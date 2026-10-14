"""Dataset cleaning: import a Hugging Face dataset, check it automatically, review clips, export / push to the Hub."""
import re
import shutil

from flask import Blueprint, current_app, jsonify, request, send_file

from ..services import audio, datasets, exporter, hub, jobs
from ..services.audios import now

bp = Blueprint("datasets", __name__, url_prefix="/api")

SCALAR = {"string", "large_string", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64",
          "float16", "float32", "float64", "bool"}
INCLUDE = ("accepted", "not_rejected", "all")


def _body():
    return request.get_json(force=True, silent=True) or {}


def _token(data):
    return (data.get("token") or "").strip() or None


def _busy(dataset_id):
    if jobs.running(dataset_id):
        return jsonify(error="A job is running on this dataset - wait for it or stop it first"), 409


# ---------- Hub ----------
@bp.post("/hub/inspect")
def inspect():
    """{repo, token?} -> configs, splits (rows, next_row = where the next batch starts) and columns of a Hub dataset."""
    data = _body()
    try:
        info = hub.inspect(data.get("repo"), _token(data))
    except ValueError as e:
        return jsonify(error=str(e)), 400
    except Exception as e:
        return jsonify(error=f"Cannot read {data.get('repo')}: {e}"), 502
    for c in info["configs"]:
        for s in c["splits"]:
            s["next_row"] = datasets.next_row(info["repo"], c["name"], s["name"])
    return jsonify(info)


@bp.post("/hub/whoami")
def whoami():
    try:
        return jsonify(name=hub.whoami(_token(_body())))
    except Exception as e:
        return jsonify(name=None, error=f"Not logged in to Hugging Face: {e}")


# ---------- datasets ----------
@bp.get("/datasets")
def list_datasets():
    return jsonify(datasets=datasets.list_datasets())


def _kind(hf_type):
    return "int" if re.fullmatch(r"u?int\d+", hf_type or "") else "float" if (hf_type or "").startswith("float") else "string"


def _int(data, key, default=None, low=0):
    v = data.get(key)
    if v in (None, ""):
        return default
    v = int(v)
    if v < low:
        raise ValueError
    return v


@bp.post("/datasets")
def import_dataset():
    """{repo, config, split, audio_column, text_column, columns, rows?, start_row?, max_rows?, batches?, check?,
    name?, token?} -> {datasets: [...]}. A big split is cut in batches: `batches` datasets of `max_rows` rows each,
    from `start_row` on (only those rows are read from the Hub). Each import runs in the background
    (GET /api/datasets/<id>/job); with `check`, the ASR checks the clips right after."""
    data = _body()
    data_token = _token(data)
    try:
        repo = hub.check_repo_id(data.get("repo"))
    except ValueError as e:
        return jsonify(error=str(e)), 400
    config, split = data.get("config") or "default", data.get("split") or "train"
    audio_col, text_col = data.get("audio_column"), data.get("text_column")
    if not audio_col or not text_col or audio_col == text_col:
        return jsonify(error="Choose the audio column and the text column"), 400
    columns = data.get("columns") or []
    extra = [c["name"] for c in columns if c.get("type") in SCALAR and c["name"] not in (audio_col, text_col)]
    types = {c["name"]: _kind(c.get("type")) for c in columns if c["name"] in extra}
    try:
        start, max_rows = _int(data, "start_row", 0), _int(data, "max_rows", None, 1)
        n_batches, total = min(_int(data, "batches", 1, 1), 100), _int(data, "rows")
    except (TypeError, ValueError):
        return jsonify(error="Start row, rows per batch and batches must be whole numbers"), 400
    if n_batches > 1 and not max_rows:
        return jsonify(error="Set the rows per batch to import more than one batch"), 400
    ranges = [(start + k * (max_rows or 0), max_rows) for k in range(n_batches)]
    ranges = [(s, min(n, total - s) if n and total else n) for s, n in ranges if total is None or s < total]
    if not ranges:
        return jsonify(error=f"This split has only {total} rows"), 400
    for s, n in ranges:
        if taken := datasets.overlap(repo, config, split, s, n):
            return jsonify(error=f"Rows from {s} are already imported in “{taken}” - start at row "
                                 f"{datasets.next_row(repo, config, split)}"), 400
    base = (data.get("name") or "").strip() or f"{repo.split('/')[-1]} ({split})"
    check = bool(data.get("check"))
    out = []
    for s, n in ranges:
        meta = {"name": base, "repo": repo, "config": config, "split": split, "audio_column": audio_col,
                "text_column": text_col, "extra_columns": extra, "column_types": types, "start_row": s,
                "max_rows": n}
        if datasets.batch(meta):
            meta["name"] = f"{base} · {datasets.batch(meta)['name']}"
        dataset_id = datasets.create(meta)
        jobs.start(dataset_id, "import", _importer(dataset_id, repo, config, split, [audio_col, text_col, *extra],
                                                   data_token, s, n, total, check))
        out.append(datasets.summary(dataset_id))
    return jsonify(datasets=out), 201


def _importer(dataset_id, repo, config, split, cols, token, start, max_rows, total, check):
    def run(job):
        job.progress(0, None, "Waiting to read the Hub…")
        files = hub.parquet_files(repo, config, split, token)
        if not files:
            raise ValueError(f"No parquet files for {repo} / {config} / {split}")
        expect = min(max_rows, total - start) if max_rows and total else (max_rows or total)
        on_file = lambda k, n: job.progress(job.done, expect, f"Reading file {k + 1} / {n}…")
        result = datasets.import_rows(dataset_id, hub.iter_rows(repo, files, cols, token, start, max_rows, on_file),
                                      job, expect)
        if check and not job.stopped and result["count"]:
            result.update(datasets.run_checks(dataset_id, job))
            job.message = f"Imported {result['count']} clips and checked {result['checked']}"
        return result
    return run


@bp.get("/datasets/<dataset_id>")
def get_dataset(dataset_id):
    return jsonify(datasets.get(dataset_id))


@bp.delete("/datasets/<dataset_id>")
def delete_dataset(dataset_id):
    datasets.get_meta(dataset_id)
    if busy := _busy(dataset_id):
        return busy
    datasets.delete_dataset(dataset_id)
    return jsonify(ok=True)


@bp.get("/datasets/<dataset_id>/job")
def job(dataset_id):
    return jsonify(job=jobs.get(dataset_id))


@bp.post("/datasets/<dataset_id>/stop")
def stop(dataset_id):
    jobs.stop(dataset_id)
    return jsonify(job=jobs.get(dataset_id))


@bp.get("/datasets/<dataset_id>/clips/<int:n>")
def clip(dataset_id, n):
    items = datasets.load_items(dataset_id)
    if not 0 <= n < len(items):
        return jsonify(error="Clip not found"), 404
    return send_file(datasets.clip_path(dataset_id, items[n]), mimetype="audio/wav", conditional=True)


@bp.patch("/datasets/<dataset_id>/items/<int:n>")
def update_item(dataset_id, n):
    """{text?, norm?, status?, reason?, trim?: [start, end] | null, reviewer?} -> the item (CER, flags, category updated)."""
    if jobs.running(dataset_id) and jobs.get(dataset_id)["kind"] == "import":
        return jsonify(error="Wait until the import has finished"), 409
    data = _body()
    changes = {k: data[k] for k in ("text", "norm", "status", "reason", "trim") if k in data}
    try:
        return jsonify(datasets.update_item(dataset_id, n, changes, data.get("reviewer") or ""))
    except ValueError as e:
        return jsonify(error=str(e)), 400


@bp.post("/datasets/<dataset_id>/items/<int:n>/split")
def split_item(dataset_id, n):
    """{at, reviewer?}: cut the clip in two at `at` seconds of its clip file -> {items: [first, second]}."""
    datasets.get_meta(dataset_id)
    if busy := _busy(dataset_id):
        return busy
    data = _body()
    try:
        at = float(data.get("at"))
    except (TypeError, ValueError):
        return jsonify(error="at must be a number"), 400
    try:
        return jsonify(items=datasets.split_item(dataset_id, n, at, data.get("reviewer") or ""))
    except ValueError as e:
        return jsonify(error=str(e)), 400


@bp.post("/datasets/<dataset_id>/items/<int:n>/join")
def join_item(dataset_id, n):
    """{reviewer?}: join the clip with the next part of the same row -> the joined item."""
    datasets.get_meta(dataset_id)
    if busy := _busy(dataset_id):
        return busy
    try:
        return jsonify(datasets.join_item(dataset_id, n, _body().get("reviewer") or ""))
    except ValueError as e:
        return jsonify(error=str(e)), 400


@bp.post("/datasets/<dataset_id>/items/<int:n>/recognize")
def recognize_item(dataset_id, n):
    """Check one clip with the local ASR now -> the item (asr_text, CER, category updated)."""
    if not 0 <= n < len(datasets.load_items(dataset_id)):
        return jsonify(error="Clip not found"), 404
    if jobs.running(dataset_id) and jobs.get(dataset_id)["kind"] == "import":
        return jsonify(error="Wait until the import has finished"), 409
    try:
        return jsonify(datasets.recognize_item(dataset_id, n))
    except Exception as e:
        current_app.logger.exception("Omni-ASR failed")
        return jsonify(error=f"Omni-ASR: {e}"), 500


@bp.post("/datasets/<dataset_id>/accept-passing")
def accept_passing(dataset_id):
    """{max_cer, reviewer?}: accept every clip to do that passed the checks with CER <= max_cer."""
    data = _body()
    try:
        max_cer = float(data.get("max_cer", current_app.config["CER_PASS"]))
    except (TypeError, ValueError):
        return jsonify(error="max_cer must be a number"), 400
    return jsonify(accepted=datasets.accept_passing(dataset_id, max_cer, data.get("reviewer") or ""))


@bp.post("/datasets/<dataset_id>/check")
def check(dataset_id):
    """{redo?}: recognize every clip with the local ASR and score it (background job)."""
    datasets.get_meta(dataset_id)
    redo = bool(_body().get("redo"))
    try:
        jobs.start(dataset_id, "check", lambda job: datasets.run_checks(dataset_id, job, redo))
    except RuntimeError as e:
        return jsonify(error=str(e)), 409
    return jsonify(job=jobs.get(dataset_id))


def _include(value):
    return value if value in INCLUDE else "accepted"


@bp.get("/datasets/<dataset_id>/export")
def export(dataset_id):
    """?include=accepted|not_rejected|all&trim=1 -> <name>.zip (wavs/ + metadata.json)."""
    meta = datasets.get_meta(dataset_id)
    name = exporter.safe_name(meta["name"], f"dataset_{dataset_id}")
    rows = datasets.output_rows(dataset_id, _include(request.args.get("include")), request.args.get("trim") != "0")
    buf = exporter.build_dataset_zip(name, rows, current_app.config["SAMPLE_RATE"])
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=f"{name}.zip")


@bp.post("/datasets/<dataset_id>/push")
def push(dataset_id):
    """{repo_id, split?, include?, trim?, private?, create_pr?, token?}: upload the cleaned clips as parquet
    to a Hub dataset repo (background job; the result has the commit or pull request URL). A batch writes
    data/<split>-rows-<start>-<end>-*.parquet and replaces only its own earlier files, so every batch of a big
    dataset can be pushed to the same repo."""
    data, meta = _body(), datasets.get_meta(dataset_id)
    try:
        repo_id = hub.check_repo_id(data.get("repo_id"))
    except ValueError as e:
        return jsonify(error=str(e)), 400
    split = (data.get("split") or meta["split"]).strip()
    if not re.match(r"^\w+$", split):
        return jsonify(error="The split name may only use letters, digits and _"), 400
    include, trim, token = _include(data.get("include")), data.get("trim", True) is not False, _token(data)
    private, create_pr = bool(data.get("private", True)), bool(data.get("create_pr"))
    sr = current_app.config["SAMPLE_RATE"]

    def run(job):
        items = datasets.load_items(dataset_id)
        total = len(datasets.selected(items, include))
        if not total:
            raise ValueError("Nothing to push - accept some clips first (or include more clips)")
        cols = datasets.hub_columns(meta, [{"extra": it.get("extra") or {}} for it in items])
        stats = {"n": 0, "seconds": 0.0, "fixed": 0, "cer": []}
        b = datasets.batch(meta)
        prefix = f"{split}-{b['prefix']}" if b else split

        def rows():
            for clip_id, pcm, rec in datasets.output_rows(dataset_id, include, trim):
                if job.stopped:
                    raise RuntimeError("Stopped")
                stats["n"] += 1
                stats["seconds"] += rec["duration"]
                stats["fixed"] += rec["text"] != rec["original_text"]
                if rec["cer"] is not None:
                    stats["cer"].append(rec["cer"])
                yield datasets.hub_row(meta, cols, clip_id, audio.wav_bytes(pcm, sr), rec)

        folder = hub.temp_folder()
        try:
            job.progress(0, total, "Preparing parquet files…")
            hub.write_shards(rows(), folder, prefix, cols,
                             progress=lambda k: job.progress(k, total, f"Preparing {k} / {total} clips…"))
            job.progress(total, total, f"Uploading {total} clips to {repo_id}…")
            row = {"Batch": b["name"] if b else "all rows", "Split": split, "Clips": stats["n"],
                   "Hours": f"{stats['seconds'] / 3600:.2f}", "Rejected": sum(it["status"] == "rejected" for it in items),
                   "Text fixed": stats["fixed"], "Pushed": now()[:10]}
            url = hub.push(folder, repo_id, split, lambda old, splits: hub.dataset_card(
                old, repo_id, splits, cols, _report(meta, include, trim), row),
                token, private, create_pr, f"Upload cleaned {split} {row['Batch']} ({total} clips)", prefix=prefix)
        finally:
            shutil.rmtree(folder, ignore_errors=True)
        datasets.update_meta(dataset_id, last_push={"repo": repo_id, "split": split, "url": url, "at": now(),
                                                   "count": total, "pr": create_pr})
        job.message = ("Pull request opened" if create_pr else "Pushed") + f": {url}"
        return {"url": url}

    try:
        jobs.start(dataset_id, "push", run)
    except RuntimeError as e:
        return jsonify(error=str(e)), 409
    return jsonify(job=jobs.get(dataset_id))


def _report(meta, include, trim):
    """What every batch of this source has in common (the numbers per batch are in the card's batch table)."""
    cfg = current_app.config
    kept = {"accepted": "accepted clips", "not_rejected": "all clips except rejected ones", "all": "all clips"}[include]
    return "\n".join([
        f"- Source: [{meta['repo']}](https://huggingface.co/datasets/{meta['repo']}) "
        f"(config `{meta['config']}`, split `{meta['split']}`, text column `{meta['text_column']}`), cleaned in "
        f"batches of rows; each batch keeps its {kept}",
        "- Audio: 16 kHz mono WAV" + (", long silence at the start / end trimmed" if trim else ""),
        f"- Automatic check: every clip recognized with "
        f"[Darayut/Omnilingual-ASR-Khm](https://huggingface.co/Darayut/Omnilingual-ASR-Khm) and compared with its text "
        f"(character error rate, spaces and punctuation ignored; pass <= {cfg['CER_PASS']:.0%}, likely bad > "
        f"{cfg['CER_BAD']:.0%}); then reviewed by a person",
        f"- `{meta['text_column']}_normalized`: the final text normalized for training (zero-width spaces removed, "
        f"Khmer digits written 0-9, words separated by spaces with khmercut), corrected by a reviewer where needed",
        "- Clip ids are `<split>_<source row>` (`<split>_<row>_<part>` when a reviewer cut a row in parts)",
        f"- `original_{meta['text_column']}` is the text before review; `asr_cer` is the CER of the ASR against the "
        f"final text (empty if not checked); `review_status` is accepted / todo / rejected",
    ])
