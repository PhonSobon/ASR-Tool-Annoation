"""Datasets imported from the Hugging Face Hub for cleaning. One folder per dataset in DATASETS_DIR:

    <dataset_id>/meta.json     name, source (repo, config, split, columns, start_row / max_rows of a batch),
                               created, import state, last_push
    <dataset_id>/items.json    one item per clip (below)
    <dataset_id>/summary.json  counts for the cards (kept with items.json, so a list of thousands of batches is fast)
    <dataset_id>/clips/<n>.wav 16 kHz mono 16-bit

An item: idx (row in the source split), part (0 = the whole row; 1, 2, ... = the parts of a row cut in pieces,
in time order; the parts share the row's clip file and each keeps its own trim), file, duration (of the clip file),
original_text, text (the reviewed text), norm (normalized text typed by a reviewer; null = made from text by
text.normalize_text), extra (other columns of the row, pushed back unchanged), md5, audio (loudness facts, times in the
clip file), trim ([start, end] or null), asr_text, cer, flags, category (quality.py), status ("todo" | "accepted" |
"rejected"), reason, reviewer, updated.
"""
import copy
import hashlib
import os
import shutil
import threading
import uuid

from flask import current_app

from . import audio, quality, recognizer
from .text import normalize_text
from .audios import NotFound, now, read_json, write_json

STATUSES = ("todo", "accepted", "rejected")
SAVE_EVERY = 200   # clips imported between two saves (so a stopped import keeps what it has)
CHECK_SAVE_EVERY = 20

_locks = {}
_locks_lock = threading.Lock()


class DatasetNotFound(NotFound):
    pass


def _dir(dataset_id):
    return os.path.join(current_app.config["DATASETS_DIR"], os.path.basename(dataset_id or ""))


def _lock(dataset_id):
    with _locks_lock:
        return _locks.setdefault(dataset_id, threading.RLock())


def _cfg():
    c = current_app.config
    return {k: c[k] for k in ("CER_PASS", "CER_BAD", "MIN_CLIP_SECONDS", "MAX_CLIP_SECONDS", "SILENCE_SECONDS")}


def clip_path(dataset_id, item):
    return os.path.join(_dir(dataset_id), item["file"])


# ---------- meta + items ----------
def get_meta(dataset_id):
    meta = read_json(os.path.join(_dir(dataset_id), "meta.json")) if dataset_id else None
    if not meta:
        raise DatasetNotFound("Dataset not found")
    return meta


def update_meta(dataset_id, **changes):
    with _lock(dataset_id):
        meta = {**get_meta(dataset_id), **changes}
        write_json(os.path.join(_dir(dataset_id), "meta.json"), meta)
        return meta


def load_items(dataset_id):
    get_meta(dataset_id)
    return read_json(os.path.join(_dir(dataset_id), "items.json"), [])


def _save_items(dataset_id, items):
    write_json(os.path.join(_dir(dataset_id), "items.json"), items)
    write_json(os.path.join(_dir(dataset_id), "summary.json"), _counts(items))


def _counts(items):
    count = lambda key, value: sum(1 for it in items if it.get(key) == value)
    dur = lambda its: round(sum(clip_seconds(it) for it in its), 3)
    accepted = [it for it in items if it["status"] == "accepted"]
    return {"count": len(items), "duration": dur(items),
            "status_counts": {s: count("status", s) for s in STATUSES},
            "category_counts": {c: count("category", c) for c in ("pass", "review", "bad", "unchecked")},
            "checked": sum(1 for it in items if it.get("asr_text") is not None),
            "fixed": sum(1 for it in accepted if it["text"] != it["original_text"]),
            "accepted_duration": dur(accepted),
            "updated": max([it.get("updated") or "" for it in items] + [""])}


def summary(dataset_id, items=None):
    """Card / header data: meta + counts by status and category, durations, the batch (rows) and its job."""
    from . import jobs

    meta = get_meta(dataset_id)
    counts = _counts(items) if items is not None else read_json(os.path.join(_dir(dataset_id), "summary.json"))
    if counts is None:  # imported before summary.json existed
        counts = _counts(load_items(dataset_id))
    return {**meta, **counts, "updated": max(counts["updated"], meta["created"]), "batch": batch(meta),
            "job": jobs.get(dataset_id)}


# ---------- batches: a range of rows of a big split ----------
def batch(meta):
    """{start, end, name, prefix} of a dataset imported as a range of rows, None for a whole split.
    prefix names its parquet files on the Hub: data/<split>-rows-0000200-0000399-00000-of-00001.parquet."""
    start, rows = meta.get("start_row") or 0, meta.get("max_rows")
    if not start and not rows:
        return None
    end = start + rows - 1 if rows else None
    return {"start": start, "end": end, "name": f"rows {start}–{end}" if rows else f"rows {start}–end",
            "prefix": f"rows-{start:07d}-{end:07d}" if rows else f"rows-{start:07d}-end"}


def _metas():
    root = current_app.config["DATASETS_DIR"]
    for dataset_id in os.listdir(root):
        meta = read_json(os.path.join(root, dataset_id, "meta.json"))
        if meta:
            yield meta


def _same_source(meta, repo, config, split):
    return (meta.get("repo"), meta.get("config"), meta.get("split")) == (repo, config, split)


def overlap(repo, config, split, start, rows):
    """The name of an imported dataset that already has some of rows [start, start + rows), or None."""
    end = start + rows if rows else float("inf")
    for meta in _metas():
        if _same_source(meta, repo, config, split):
            s = meta.get("start_row") or 0
            e = s + meta["max_rows"] if meta.get("max_rows") else float("inf")
            if s < end and start < e:
                return meta["name"]
    return None


def next_row(repo, config, split):
    """First row after every batch already imported from this split (where the next batch starts)."""
    return max([(m.get("start_row") or 0) + (m.get("max_rows") or 0) for m in _metas()
                if _same_source(m, repo, config, split) and m.get("max_rows")] + [0])


def sibling_push(meta):
    """The last push of another batch of the same source (its batches usually all go to one repo)."""
    pushes = [m["last_push"] for m in _metas() if m.get("last_push") and m.get("id") != meta.get("id")
              and _same_source(m, meta.get("repo"), meta.get("config"), meta.get("split"))]
    return max(pushes, key=lambda p: p["at"]) if pushes else None


def get(dataset_id):
    items = load_items(dataset_id)
    s = summary(dataset_id, items)
    return {**s, "items": items, "cer_pass": current_app.config["CER_PASS"], "sibling_push": sibling_push(s),
            "flag_info": {k: {"severity": sev, "text": text} for k, (sev, text) in quality.FLAGS.items()}}


def list_datasets():
    root, out = current_app.config["DATASETS_DIR"], []
    for dataset_id in os.listdir(root):
        try:
            out.append(summary(dataset_id))
        except DatasetNotFound:
            continue
    return sorted(out, key=lambda d: (d["created"], -(d.get("start_row") or 0)), reverse=True)  # batches in row order


def delete_dataset(dataset_id):
    get_meta(dataset_id)
    shutil.rmtree(_dir(dataset_id), ignore_errors=True)


def clip_seconds(item):
    start, end = item.get("trim") or (0, item["duration"])
    return max(0.0, end - start)


# ---------- import ----------
def create(meta):
    """New, empty dataset folder. `meta`: name, repo, config, split, audio_column, text_column, extra_columns,
    column_types ({column: "int" | "float" | "string"}), start_row, max_rows."""
    dataset_id = uuid.uuid4().hex[:12]
    os.makedirs(os.path.join(_dir(dataset_id), "clips"))
    write_json(os.path.join(_dir(dataset_id), "meta.json"),
               {**meta, "id": dataset_id, "created": now(), "state": "importing", "failed": 0})
    _save_items(dataset_id, [])
    return dataset_id


def import_rows(dataset_id, rows, job, total=None):
    """Decode, resample and save every row (a dict of the source columns) as a clip + item.
    Rows that cannot be decoded are counted in meta "failed"."""
    meta, sr, cfg = get_meta(dataset_id), current_app.config["SAMPLE_RATE"], _cfg()
    audio_col, text_col, extra_cols = meta["audio_column"], meta["text_column"], meta.get("extra_columns") or []
    items, failed = [], 0
    for idx, row in enumerate(rows, meta.get("start_row") or 0):  # idx = row number in the source split
        if job.stopped:
            break
        try:
            x = _decode(row.get(audio_col), sr)
        except Exception as e:
            failed += 1
            current_app.logger.warning("row %s: cannot decode audio: %s", idx, e)
            continue
        pcm = audio.to_pcm(x)
        fname = f"clips/{idx:06d}.wav"
        with open(os.path.join(_dir(dataset_id), fname), "wb") as f:
            f.write(audio.wav_bytes(pcm, sr))
        text = str(row.get(text_col) or "").strip()
        src = row.get(audio_col)
        items.append({"idx": idx, "part": 0, "file": fname, "duration": round(len(pcm) / sr, 3),
                      "source_file": src.get("path") if isinstance(src, dict) else None,
                      "original_text": text, "text": text, "norm": None,
                      "extra": {c: row.get(c) for c in extra_cols},
                      "md5": hashlib.md5(pcm.tobytes()).hexdigest(), "audio": quality.audio_stats(x, sr),
                      "trim": None, "asr_text": None, "cer": None, "flags": [], "category": "unchecked",
                      "status": "todo", "reason": "", "reviewer": "", "updated": ""})
        if len(items) % 25 == 0:
            job.progress(len(items), total, f"Imported {len(items)}" + (f" / {total}" if total else "") + " clips")
        if len(items) % SAVE_EVERY == 0:
            with _lock(dataset_id):
                _save_items(dataset_id, quality.refresh(items, cfg))
    with _lock(dataset_id):
        _save_items(dataset_id, quality.refresh(items, cfg))
    update_meta(dataset_id, state="ready", failed=failed)
    msg = f"Imported {len(items)} clips" + (f", {failed} could not be read" if failed else "") + \
        (" (stopped)" if job.stopped else "")
    job.progress(len(items), total or len(items), msg)
    return {"count": len(items), "failed": failed}


def _decode(value, sr):
    """An Audio cell: {"bytes", "path"} (parquet) or {"array", "sampling_rate"} -> float32 samples at sr."""
    if isinstance(value, dict) and value.get("bytes"):
        return audio.decode_bytes(value["bytes"], sr)
    if isinstance(value, dict) and value.get("array") is not None:
        import numpy as np

        return audio.resample(np.asarray(value["array"], dtype=np.float32), int(value["sampling_rate"]), sr)
    if isinstance(value, (bytes, bytearray)):
        return audio.decode_bytes(bytes(value), sr)
    raise ValueError("no audio bytes in this row")


# ---------- review ----------
def update_item(dataset_id, n, changes, reviewer=""):
    """Change one item (n = position in items.json): text, norm, status, reason, trim. Returns the item."""
    with _lock(dataset_id):
        items = load_items(dataset_id)
        if not 0 <= n < len(items):
            raise DatasetNotFound("Clip not found")
        it = items[n]
        if "text" in changes:
            it["text"] = str(changes["text"] or "")
            if it.get("asr_text") is not None:
                it["cer"] = quality.cer(it["text"], it["asr_text"])
        if "norm" in changes:  # empty = made from the text again
            it["norm"] = str(changes["norm"] or "").strip() or None
        if "status" in changes:
            if changes["status"] not in STATUSES:
                raise ValueError(f"status must be one of {', '.join(STATUSES)}")
            it["status"] = changes["status"]
        if "reason" in changes:
            it["reason"] = str(changes["reason"] or "")
        if "trim" in changes:
            it["trim"] = _clean_trim(changes["trim"], it["duration"])
        it["reviewer"], it["updated"] = reviewer or it.get("reviewer", ""), now()
        quality.refresh(items, _cfg())
        _save_items(dataset_id, items)
        return it


def _piece(dataset_id, item, start, end):
    """Cut item to [start, end] of its clip file: new audio facts, md5 and trim; checked again, back to review."""
    sr = current_app.config["SAMPLE_RATE"]
    pcm = audio.clip(audio.read_wav(clip_path(dataset_id, item)), start, end, sr)
    a = quality.audio_stats(pcm.astype("float32") / 32768, sr)
    a["speech_start"], a["speech_end"] = round(a["speech_start"] + start, 3), round(a["speech_end"] + start, 3)
    item.update(audio=a, md5=hashlib.md5(pcm.tobytes()).hexdigest(), trim=_clean_trim([start, end], item["duration"]),
                asr_text=None, cer=None, status="todo", reason="")


def _renumber(items, idx):
    """Parts of one row: 1, 2, ... in time order (0 when only one is left)."""
    parts = sorted((it for it in items if it["idx"] == idx), key=_start)
    for k, it in enumerate(parts, 1):
        it["part"] = k if len(parts) > 1 else 0


def _start(item):
    return (item.get("trim") or (0, item["duration"]))[0]


def _end(item):
    return (item.get("trim") or (0, item["duration"]))[1]


def split_item(dataset_id, n, at, reviewer=""):
    """Cut item n in two at `at` seconds (in its clip file). The first part keeps the text, the second starts empty;
    both go back to review and are checked again. Returns the two items (now at n and n + 1)."""
    with _lock(dataset_id):
        items = load_items(dataset_id)
        if not 0 <= n < len(items):
            raise DatasetNotFound("Clip not found")
        a = items[n]
        start, end, at = _start(a), _end(a), round(float(at), 3)
        if not start + 0.1 <= at <= end - 0.1:
            raise ValueError("Cut inside the clip, at least 0.1 s from its start and end")
        b = copy.deepcopy(a)
        b.update(text="", norm=None)
        _piece(dataset_id, a, start, at)
        _piece(dataset_id, b, at, end)
        for it in (a, b):
            it["reviewer"], it["updated"] = reviewer or it.get("reviewer", ""), now()
        items.insert(n + 1, b)
        _renumber(items, a["idx"])
        quality.refresh(items, _cfg())
        _save_items(dataset_id, items)
        return [a, b]


def join_item(dataset_id, n, reviewer=""):
    """Join item n with the next part of the same row (texts joined, checked again). Returns the joined item."""
    with _lock(dataset_id):
        items = load_items(dataset_id)
        if not 0 <= n < len(items):
            raise DatasetNotFound("Clip not found")
        a = items[n]
        later = [k for k, it in enumerate(items) if it["idx"] == a["idx"] and k != n and _start(it) > _start(a)]
        if not later:
            raise ValueError("This is the last part of the row - there is nothing after it to join")
        k = min(later, key=lambda k: _start(items[k]))
        b = items[k]
        a["text"] = " ".join(t for t in (a["text"].strip(), b["text"].strip()) if t)
        a["norm"] = None
        _piece(dataset_id, a, _start(a), max(_end(a), _end(b)))
        a["reviewer"], a["updated"] = reviewer or a.get("reviewer", ""), now()
        del items[k]
        _renumber(items, a["idx"])
        quality.refresh(items, _cfg())
        _save_items(dataset_id, items)
        return a


def recognize_item(dataset_id, n):
    """Run the ASR on one item (its trim applied) and score it. Returns the item."""
    items = load_items(dataset_id)
    if not 0 <= n < len(items):
        raise DatasetNotFound("Clip not found")
    x = clip_pcm(dataset_id, items[n]).astype("float32") / 32768
    _store_asr(dataset_id, {n: recognizer.recognize(x, current_app.config["OMNI_ASR_MODEL"])["text"]})
    return load_items(dataset_id)[n]


def _clean_trim(trim, duration):
    if not trim:
        return None
    start, end = max(0.0, float(trim[0])), min(duration, float(trim[1]))
    if end - start < 0.1:
        raise ValueError("The trimmed clip must be at least 0.1 s long")
    return None if start <= 0 and end >= duration else [round(start, 3), round(end, 3)]


def accept_passing(dataset_id, max_cer, reviewer=""):
    """Accept every clip still to do whose category is "pass" and CER <= max_cer. Returns how many."""
    with _lock(dataset_id):
        items, n = load_items(dataset_id), 0
        for it in items:
            if it["status"] == "todo" and it["category"] == "pass" and it["cer"] is not None and it["cer"] <= max_cer:
                it["status"], it["reviewer"], it["updated"], n = "accepted", reviewer, now(), n + 1
        _save_items(dataset_id, items)
        return n


# ---------- automatic checks ----------
def run_checks(dataset_id, job, redo=False):
    """Recognize every clip (only the unchecked ones unless redo) and score it against its text.
    The trim is applied, so each part of a cut row is checked on its own audio."""
    model = current_app.config["OMNI_ASR_MODEL"]
    todo = [(n, it) for n, it in enumerate(load_items(dataset_id))
            if redo or it.get("asr_text") is None]  # clips cannot be cut or joined while a job runs
    done, pending = 0, {}
    job.progress(0, len(todo), f"Checking 0 / {len(todo)} clips (the model loads first)…")
    for n, it in todo:
        if job.stopped:
            break
        x = clip_pcm(dataset_id, it).astype("float32") / 32768
        pending[n] = recognizer.recognize(x, model)["text"]
        done += 1
        if len(pending) >= CHECK_SAVE_EVERY:
            _store_asr(dataset_id, pending)
        job.progress(done, len(todo), f"Checked {done} / {len(todo)} clips")
    _store_asr(dataset_id, pending)
    job.progress(done, len(todo), f"Checked {done} clips" + (" (stopped)" if job.stopped else ""))
    return {"checked": done}


def _store_asr(dataset_id, results):
    if not results:
        return
    with _lock(dataset_id):
        items = load_items(dataset_id)
        for n, text in results.items():
            items[n]["asr_text"] = text
            items[n]["cer"] = quality.cer(items[n]["text"], text)
        quality.refresh(items, _cfg())
        _save_items(dataset_id, items)
    results.clear()


# ---------- output ----------
def selected(items, include):
    """Items that go into an export / push: "accepted" | "not_rejected" | "all"."""
    if include == "accepted":
        return [it for it in items if it["status"] == "accepted"]
    if include == "not_rejected":
        return [it for it in items if it["status"] != "rejected"]
    return list(items)


def clip_pcm(dataset_id, item, trim_silence=False, pad=0.2):
    """int16 samples of a clip with its trim applied; trim_silence also cuts long silence at the ends."""
    sr = current_app.config["SAMPLE_RATE"]
    pcm = audio.read_wav(clip_path(dataset_id, item))
    start, end = item.get("trim") or (0, item["duration"])
    if trim_silence and not item.get("trim") and "long_silence" in item["flags"]:
        a = item["audio"]
        start, end = max(0, a["speech_start"] - pad), min(item["duration"], a["speech_end"] + pad)
    return audio.clip(pcm, start, end, sr)


def output_rows(dataset_id, include="accepted", trim_silence=True):
    """(clip id, int16 samples, record) for every clip that goes out. The record has the reviewed text, the
    original text, the ASR's CER, review status and the source's other columns."""
    meta, sr = get_meta(dataset_id), current_app.config["SAMPLE_RATE"]
    for it in selected(load_items(dataset_id), include):
        pcm, text = clip_pcm(dataset_id, it, trim_silence), it["text"].strip()
        yield f"{meta['split']}_{it['idx']:06d}" + (f"_{it['part']:02d}" if it.get("part") else ""), pcm, {
            "text": text, "norm": it.get("norm") or normalize_text(text), "original_text": it["original_text"], "duration": round(len(pcm) / sr, 3),
            "asr_text": it.get("asr_text"), "cer": it.get("cer"), "status": it["status"], "reason": it.get("reason", ""),
            "flags": it["flags"], "source_index": it["idx"], "part": it.get("part", 0), "extra": it.get("extra") or {}}


def hub_columns(meta, rows_sample):
    """[(column, type)] of the pushed dataset: audio, the text column (reviewed), <text column>_normalized, the
    source's other columns, original_<text column>, duration, asr_cer and review_status. The same for every batch of
    a source (types from the source's schema), so their parquet files fit together in one repo.
    A source column named <text column>_normalized is replaced by the normalized reviewed text."""
    text_col = meta["text_column"]
    cols = [(meta["audio_column"], "audio"), (text_col, "string"), (f"{text_col}_normalized", "string")]
    for c in meta.get("extra_columns") or []:
        if c == f"{text_col}_normalized":
            continue
        kind = (meta.get("column_types") or {}).get(c)
        if not kind:  # imported before the types were kept: guess from the values
            values = [r["extra"].get(c) for r in rows_sample if r["extra"].get(c) is not None]
            kind = ("int" if values and all(isinstance(v, int) and not isinstance(v, bool) for v in values) else
                    "float" if values and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in values)
                    else "string")
        cols.append((c, kind))
    taken = {c for c, _ in cols}
    for c, kind in ((f"original_{text_col}", "string"), ("duration", "float"), ("asr_cer", "float"),
                    ("review_status", "string")):
        if c not in taken:
            cols.append((c, kind))
    return cols


def hub_row(meta, columns, clip_id, wav, rec):
    row = {meta["audio_column"]: {"bytes": wav, "path": clip_id + ".wav"}, meta["text_column"]: rec["text"],
           f"{meta['text_column']}_normalized": rec["norm"],
           f"original_{meta['text_column']}": rec["original_text"], "duration": rec["duration"],
           "asr_cer": rec["cer"], "review_status": rec["status"]}
    for c, kind in columns:
        if c in rec["extra"] and c not in row:
            v = rec["extra"][c]
            row[c] = None if v is None else str(v) if kind == "string" else v
    return {c: row.get(c) for c, _ in columns}
