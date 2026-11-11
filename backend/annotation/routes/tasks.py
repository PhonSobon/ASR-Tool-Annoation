"""Tasks: push audio from Upload & Crop into a batch, or load a Hugging Face dataset / a local folder with its text
(Load Data), list (My Tasks), open, delete, assign people, review the packages (accept or return), push the
annotations to the Hub."""
import json
import re
import shutil

from flask import Blueprint, abort, current_app, jsonify, request

from ...auth import guard
from ...auth.guard import require
from ...core import audio, hub, jobs
from ...core.storage import now
from .. import access, audios, importer, tasks

bp = Blueprint("tasks", __name__, url_prefix="/api/tasks")


@bp.get("")
def list_tasks():
    """The tasks the logged-in user may see (managers: all; the others: those they are assigned to)."""
    return jsonify(tasks=tasks.list_tasks(guard.current_user()))


@bp.post("")
@require("audio.upload")
def push():
    """Body: {name, audio_ids: [...], members?: {annotator, inspector}} -> new task with those audio."""
    data = request.get_json(force=True) or {}
    try:
        return jsonify(tasks.create_task(data.get("name"), data.get("audio_ids") or [], guard.username(),
                                         data.get("members"))), 201
    except ValueError as e:
        return jsonify(error=str(e)), 400


# ---------- Load Data: speech that already has its text ----------
def _int(data, key, default=None, low=0):
    v = data.get(key)
    if v in (None, ""):
        return default
    v = int(v)
    if v < low:
        raise ValueError
    return v


@bp.post("/load/hub")
@require("audio.upload")
def load_hub():
    """{repo, config, split, audio_column, text_column, rows?, start_row?, max_rows?, batches?, name?, token?,
    members?} -> {tasks: [...], warning?}. One task per batch of rows (only those rows are read from the Hub), loaded
    in the background (GET /api/tasks/<id>/job). Every clip is one package with its text filled in."""
    data = request.get_json(force=True, silent=True) or {}
    token = (data.get("token") or "").strip() or None
    try:
        repo = hub.check_repo_id(data.get("repo"))
    except ValueError as e:
        return jsonify(error=str(e)), 400
    config, split = data.get("config") or "default", data.get("split") or "train"
    audio_col, text_col = data.get("audio_column"), data.get("text_column")
    if not audio_col or not text_col or audio_col == text_col:
        return jsonify(error="Choose the audio column and the text column"), 400
    try:
        start, max_rows = _int(data, "start_row", 0), _int(data, "max_rows", None, 1)
        n_batches, total = min(_int(data, "batches", 1, 1), 100), _int(data, "rows")
    except (TypeError, ValueError):
        return jsonify(error="Start row, rows per batch and batches must be whole numbers"), 400
    if n_batches > 1 and not max_rows:
        return jsonify(error="Set the rows per batch to load more than one batch"), 400
    ranges = [(start + k * (max_rows or 0), max_rows) for k in range(n_batches)]
    ranges = [(s, min(n, total - s) if n and total else n) for s, n in ranges if total is None or s < total]
    if not ranges:
        return jsonify(error=f"This split has only {total} rows"), 400
    for s, n in ranges:
        if importer.overlap(repo, config, split, s, n) is not None:
            return jsonify(error=f"Rows from {s} are already loaded in another task - start at row "
                                 f"{importer.next_row(repo, config, split)}"), 400
    base = (data.get("name") or "").strip() or f"{repo.split('/')[-1]} ({split})"
    sha = hub.dataset_sha(repo, token)
    earlier = {src.get("sha") for src in importer.hub_sources(repo) if importer.same_split(src, config, split) and src.get("sha")}
    warning = (f"{repo} changed on the Hub since the earlier batches were loaded (now at commit {sha[:8]}). If rows "
               "were added or removed in the middle, row numbers may not line up.") if sha and earlier and sha not in earlier else None
    out = []
    for s, n in ranges:
        name = f"{base} · rows {s}–{s + n - 1}" if n else (f"{base} · rows {s}–end" if s else base)
        task_id = importer.create(name, {"kind": "hub", "repo": repo, "config": config, "split": split, "start_row": s,
                                         "max_rows": n, "sha": sha}, guard.username(), data.get("members"))
        jobs.start(_job_key(task_id), "load", _loader(task_id, repo, config, split, audio_col, text_col, token, s, n, total))
        out.append(tasks.summary(task_id))
    return jsonify(tasks=out, warning=warning), 201


def _loader(task_id, repo, config, split, audio_col, text_col, token, start, max_rows, total):
    def run(job):
        job.progress(0, None, "Waiting to read the Hub…")
        files, partial = hub.parquet_files(repo, config, split, token)
        if not files:
            raise ValueError(f"No parquet files for {repo} / {config} / {split}")
        expect = min(max_rows, total - start) if max_rows and total else (max_rows or total)
        on_file = lambda k, n: job.progress(job.done, expect, f"Reading file {k + 1} / {n}…")
        rows = hub.iter_rows(repo, files, [audio_col, text_col], token, start, max_rows, on_file)
        result = importer.load_rows(task_id, rows, audio_col, text_col, start, job, expect)
        if not result["count"] and not result["failed"] and not job.stopped:
            raise ValueError(f"No rows from row {start} on" + (
                " - the Hub has parquet for only the first part of this split (about 5 GB), so later rows cannot be "
                "read in batches" if partial else ""))
        return result
    return run


@bp.post("/load/local")
@require("audio.upload")
def load_local():
    """{name, members?} -> a new, empty task for a local folder. Then POST its files in parts (/<id>/files) and
    finish it (/<id>/finish)."""
    data = request.get_json(force=True, silent=True) or {}
    if not (data.get("name") or "").strip():
        return jsonify(error="Give the task a name"), 400
    task_id = importer.create(data["name"], {"kind": "local"}, guard.username(), data.get("members"))
    return jsonify(tasks.summary(task_id)), 201


def _local_task(task_id):
    access.task(task_id, "manage")
    task = tasks.summary(task_id)
    if (task.get("source") or {}).get("kind") != "local":
        abort(400, "Files can only be added to a task loaded from a local folder")
    return task


@bp.post("/<task_id>/files")
@require("audio.upload")
def load_files(task_id):
    """multipart: audio (files), texts (JSON list: the label of each file, same order), names (JSON list: the path
    of each file in the folder) -> {added, skipped, failed: [{file, error}], count}."""
    _local_task(task_id)
    files = request.files.getlist("audio")
    try:
        texts = json.loads(request.form.get("texts") or "[]")
        names = json.loads(request.form.get("names") or "[]") or [f.filename for f in files]
    except ValueError:
        return jsonify(error="texts and names must be JSON lists"), 400
    if not files:
        return jsonify(error="No audio file in the request"), 400
    if not isinstance(texts, list) or not isinstance(names, list) or len(texts) != len(files) or len(names) != len(files):
        return jsonify(error="Send one text (and one name) per audio file"), 400
    batch = [(str(n or f.filename or "").replace(chr(92), "/").strip("/")[:300], f.read(), str(t or ""))
             for f, n, t in zip(files, names, texts)]
    result = importer.add_files(task_id, batch)
    return jsonify({**result, "count": len(importer.clip_names(task_id))})


@bp.post("/<task_id>/finish")
@require("audio.upload")
def load_finish(task_id):
    """The folder is loaded -> the task summary. A task without any clip is refused."""
    _local_task(task_id)
    if not importer.clip_names(task_id):
        return jsonify(error="No audio file could be loaded"), 400
    importer.set_source(task_id, state="ready")
    return jsonify(tasks.summary(task_id))


@bp.get("/<task_id>")
def get_task(task_id):
    t = access.task(task_id)
    return jsonify({**tasks.get(task_id), "access": tasks.access(t, guard.current_user())})


@bp.delete("/<task_id>")
def delete_task(task_id):
    access.task(task_id, "manage")
    tasks.delete_task(task_id)
    return jsonify(ok=True)


@bp.put("/<task_id>/members")
def set_members(task_id):
    """{annotator: [user, ...], inspector: [...] (the reviewers), open_roles?: ["annotator", ...]} -> the members and
    the roles that may claim the task themselves (open_roles left out: unchanged)."""
    task = access.task(task_id, "manage")
    data = request.get_json(force=True, silent=True) or {}
    try:
        new_members = tasks.clean_members(data)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    if "open_roles" in data:
        try:
            tasks.check_take_back(task, tasks.clean_open_roles(data["open_roles"]), new_members)
        except ValueError as e:
            return jsonify(error=str(e)), 409
    m = tasks.set_members(task_id, data)
    open_roles = tasks.set_open_roles(task_id, data["open_roles"]) if "open_roles" in data         else tasks.clean_open_roles(tasks.read(task_id).get("open_roles"))
    return jsonify(members=m, open_roles=open_roles)


@bp.put("/<task_id>/share")
def share(task_id):
    """{annotator: bool}: a manager pushes the task to the annotators (they can pull it from My Tasks) or takes it
    back. Other open roles stay as they are -> {open_roles}. A task still loading cannot be pushed."""
    task = access.task(task_id, "manage")
    data = request.get_json(force=True, silent=True) or {}
    on = bool(data.get("annotator"))
    if on and (task.get("source") or {}).get("state", "ready") != "ready":
        return jsonify(error="The data is still loading - push it to annotators when it is ready"), 400
    if on and not tasks.summary(task_id)["count"]:
        return jsonify(error="This task has no package to annotate"), 400
    current = [r for r in tasks.clean_open_roles(task.get("open_roles")) if r != "annotator"]
    if not on:
        try:
            tasks.check_take_back(task, current)
        except ValueError as e:
            return jsonify(error=str(e)), 409
    return jsonify(open_roles=tasks.set_open_roles(task_id, current + ["annotator"] if on else current))


@bp.post("/<task_id>/pull")
def pull(task_id):
    """The logged-in user pulls a task pushed to their role (My Tasks -> Available to pull) and joins it -> the
    members."""
    try:
        return jsonify(members=tasks.claim(task_id, guard.current_user()))
    except tasks.PulledAlready as e:
        return jsonify(error=str(e), pulled=True), 409
    except ValueError as e:
        return jsonify(error=str(e)), 400


@bp.post("/<task_id>/claim")
def claim(task_id):
    """Old name of /pull, kept for older clients."""
    return pull(task_id)


@bp.post("/<task_id>/review")
def review(task_id):
    """{audio_id, index, decision: "accept" | "return", note?} -> the package (crop). One review step: the reviewer
    accepts the package or returns it to the annotator with a note. ("pass" from older clients means accept.)"""
    data = request.get_json(force=True, silent=True) or {}
    decision = "accept" if data.get("decision") == "pass" else data.get("decision")
    access.task(task_id, "review")
    try:
        index = int(data.get("index"))
    except (TypeError, ValueError):
        return jsonify(error="index must be a number"), 400
    try:
        crop = tasks.review_package(task_id, data.get("audio_id"), index, decision, data.get("note"), guard.current_user())
    except ValueError as e:
        return jsonify(error=str(e)), 400
    return jsonify(crop=crop)


# ---------- push to the Hugging Face Hub (background job) ----------
def _job_key(task_id):
    return f"task-{task_id}"


@bp.get("/<task_id>/job")
def job(task_id):
    access.task(task_id)
    return jsonify(job=jobs.get(_job_key(task_id)))


@bp.post("/<task_id>/stop")
@require("hub.push")
def stop(task_id):
    access.task(task_id)
    jobs.stop(_job_key(task_id))
    return jsonify(job=jobs.get(_job_key(task_id)))


@bp.post("/<task_id>/hub-push")
@require("hub.push")
def hub_push(task_id):
    """{repo_id, split?, include?: "accepted" | "done" | "with_text", private?, create_pr?, token?}:
    upload the annotated segments as parquet to a Hub dataset repo (background job; the result has the commit or
    pull request URL). A private repo needs the token."""
    access.task(task_id)
    data, task = request.get_json(force=True, silent=True) or {}, tasks.summary(task_id)
    try:
        repo_id = hub.check_repo_id(data.get("repo_id"))
    except ValueError as e:
        return jsonify(error=str(e)), 400
    split = (data.get("split") or "train").strip()
    if not re.match(r"^\w+$", split):
        return jsonify(error="The split name may only use letters, digits and _"), 400
    include = data.get("include") if data.get("include") in tasks.INCLUDE else "done"
    token = (data.get("token") or "").strip() or None
    private, create_pr = bool(data.get("private", True)), bool(data.get("create_pr"))
    if private and not create_pr and not token:
        return jsonify(error="A private repo needs a Hugging Face access token (write)"), 400
    sr = current_app.config["SAMPLE_RATE"]

    def run(job):
        segments = tasks.hub_segments(task_id, include)
        total = len(segments)
        if not total:
            raise ValueError({"accepted": "Nothing to push - no package is accepted yet",
                              "passed": "Nothing to push - no package is accepted yet",
                              "done": "Nothing to push - no completed package with text yet"}.get(
                                  include, "Nothing to push - no segment has text yet"))
        stats = {"seconds": 0.0}

        def rows():
            for audio_id, audio_name, s in segments:
                if job.stopped:
                    raise RuntimeError("Stopped")
                pcm = audio.clip(audio.load_pcm(audios.wav_path(audio_id)), s["start"], s["end"], sr)
                duration = round(len(pcm) / sr, 3)
                stats["seconds"] += duration
                yield tasks.hub_row(task["name"], audio_name, s, audio.wav_bytes(pcm, sr), duration)

        folder = hub.temp_folder()
        try:
            job.progress(0, total, "Preparing parquet files…")
            prefix = f"{split}-task-{task_id}"   # each task has its own files: many tasks go to one repo
            hub.write_shards(rows(), folder, prefix, tasks.HUB_COLUMNS,
                             progress=lambda k: job.progress(k, total, f"Preparing {k} / {total} segments…"))
            job.progress(total, total, f"Uploading {total} segments to {repo_id}…")
            row = {"Batch": f"task {task['name']}", "Split": split, "Clips": total,
                   "Hours": f"{stats['seconds'] / 3600:.2f}", "Rejected": "–", "Text fixed": "–", "Pushed": now()[:10]}
            url = hub.push(folder, repo_id, split, lambda old, splits: hub.dataset_card(
                old, repo_id, splits, tasks.HUB_COLUMNS, _report(include), row),
                token, private, create_pr, f"Upload annotated task {task['name']} ({total} segments)", prefix=prefix)
        finally:
            shutil.rmtree(folder, ignore_errors=True)
        tasks.set_last_push(task_id, {"repo": repo_id, "split": split, "url": url, "at": now(), "count": total,
                                      "pr": create_pr})
        job.message = ("Pull request opened" if create_pr else "Pushed") + f": {url}"
        return {"url": url}

    try:
        jobs.start(_job_key(task_id), "push", run)
    except RuntimeError as e:
        return jsonify(error=str(e)), 409
    return jsonify(job=jobs.get(_job_key(task_id)))


def _report(include):
    """What every task pushed to the repo has in common (the numbers per task are in the card's batch table)."""
    kept = {"accepted": "packages accepted after quality inspection",
            "passed": "accepted packages",
            "done": "completed packages (every segment has text)"}.get(include, "every segment with text")
    return "\n".join([
        f"- Source: annotation tasks made with this tool; each task keeps its {kept}; 16 kHz mono WAV",
        "- `text`: the annotation text; `text_normalized`: normalized for training (zero-width spaces removed, Khmer "
        "digits written 0-9, words separated by spaces with khmercut), corrected by the annotator where needed",
        "- `task`, `source_audio`, `start`, `end`: the task and where the segment is in the original recording; "
        "`role` and `speaker_*`: who speaks; the other columns describe the recording (language, accent, domain, ...)",
    ])
