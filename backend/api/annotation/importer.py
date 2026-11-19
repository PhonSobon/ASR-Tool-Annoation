"""Load Data: speech that already has its text - a Hugging Face dataset or a local folder of audio + labels - goes
straight into a new task. Every clip becomes one audio of the task with one package (crop) whose text is filled in,
so the annotator only checks it (no speech recognition needed) and the package goes through the review
like any other.

The task remembers where its clips came from (tasks.source):

    {"kind": "hub", "repo", "config", "split", "start_row", "max_rows", "sha"}   a batch of rows of a Hub split
    {"kind": "local"}                                                             a folder uploaded from the browser

A big Hub split is loaded in batches (one task per batch of rows); the next batch starts after the rows already
loaded (next_row), and overlapping batches are refused (overlap).
"""
import os
import uuid

from flask import current_app
from sqlalchemy import select

from ..core import audio, db
from ..core.db import Audio, Task
from ..core.storage import now
from ..core.text import normalize_text
from . import audios, tasks

AUDIO_EXTS = (".wav", ".mp3", ".flac", ".ogg", ".opus", ".m4a", ".aac", ".wma", ".webm", ".mp4")


# ---------- one clip -> one audio with one package ----------
def package(duration, text):
    """The crop of an imported clip: the whole clip, its text and normalized text filled in, not completed yet.
    wordsText stays null, so the text counts as typed by hand (Recognize all never replaces it)."""
    text = " ".join(str(text or "").split())
    norm = normalize_text(text) if text else ""
    part = {"id": 1, "start": 0.0, "end": duration, "role": "Narrator", "text": text, "norm": norm, "normEdited": False,
            "words": None, "wordsText": None, "state": "done" if text else "pending", "error": "", "deleted": False}
    return {"id": 1, "start": 0.0, "end": duration, "text": text, "norm": norm, "role": "Narrator",
            "state": part["state"], "parts": [part], "imported": True}


def add_clip(task_id, name, samples, text):
    """Save float samples (at SAMPLE_RATE) as a new audio of the task with one filled-in package.
    Returns (its id, the audio it duplicates - see duplicates.py)."""
    sr, audio_id = current_app.config["SAMPLE_RATE"], uuid.uuid4().hex[:12]
    d = audios.audio_dir(audio_id)
    os.makedirs(d)
    pcm = audio.to_pcm(samples)
    with open(os.path.join(d, "full.wav"), "wb") as f:
        f.write(audio.wav_bytes(pcm, sr))
    duration = round(len(pcm) / sr, 3)
    with db.transaction() as s:
        s.add(Audio(id=audio_id, name=name[:300], duration=duration, created=now(), chunk_seconds=None, task_id=task_id,
                    segments=[package(duration, text)], updated=None))
    from . import duplicates
    return audio_id, duplicates.add(audio_id, pcm)


def clip_names(task_id):
    with db.transaction() as s:
        return set(s.scalars(select(Audio.name).where(Audio.task_id == task_id)))


# ---------- the task ----------
def create(name, source, created_by="", members=None):
    """A new, empty task for loaded clips. Returns its id."""
    task_id = uuid.uuid4().hex[:12]
    with db.transaction() as s:
        s.add(Task(id=task_id, name=(name or "").strip()[:300] or f"Loaded data {now()[:16]}", created=now(),
                   created_by=created_by, members=tasks.clean_members(members), last_push=None,
                   source={**source, "state": "loading"}))
    return task_id


def set_source(task_id, **changes):
    with db.transaction() as s:
        row = db.locked(s, Task, task_id)
        row.source = {**(row.source or {}), **changes}
        return dict(row.source)


# ---------- a local folder (sent from the browser in parts) ----------
def add_files(task_id, files):
    """files: [(path in the folder, encoded audio bytes, label text)] -> {added, skipped, failed: [{file, error}]}.
    A path already loaded into the task is skipped (a part sent again after a network error makes no duplicate)."""
    sr, have = current_app.config["SAMPLE_RATE"], clip_names(task_id)
    added, skipped, failed, dups = 0, [], [], 0
    for path, data, text in files:
        name = os.path.splitext(path.replace("\\", "/").split("/")[-1])[0] or "clip"
        if name in have:
            skipped.append(path)
            continue
        if not path.lower().endswith(AUDIO_EXTS):
            failed.append({"file": path, "error": "not an audio file"})
            continue
        try:
            x = audio.decode_bytes(data, sr)
            if not len(x):
                raise ValueError("no samples")
        except Exception as e:
            current_app.logger.warning("%s: cannot decode audio: %s", path, e)
            failed.append({"file": path, "error": f"cannot read the audio ({str(e)[:120] or e.__class__.__name__})"})
            continue
        dups += bool(add_clip(task_id, name, x, text)[1])
        have.add(name)
        added += 1
    if failed:
        with db.transaction() as s:
            row = db.locked(s, Task, task_id)
            row.source = {**(row.source or {}), "failed": (row.source or {}).get("failed", 0) + len(failed)}
    return {"added": added, "skipped": skipped, "failed": failed, "duplicates": dups}


# ---------- a Hugging Face dataset (a background job per batch) ----------
def hub_sources(repo):
    with db.transaction() as s:
        return [src for src in s.scalars(select(Task.source)) if src and src.get("kind") == "hub" and src.get("repo") == repo]


def same_split(src, config, split):
    return (src.get("config"), src.get("split")) == (config, split)


def overlap(repo, config, split, start, rows):
    """The first row of an earlier batch of this split that overlaps rows [start, start + rows), or None."""
    end = start + rows if rows else float("inf")
    for src in hub_sources(repo):
        if same_split(src, config, split):
            s = src.get("start_row") or 0
            e = s + src["max_rows"] if src.get("max_rows") else float("inf")
            if s < end and start < e:
                return s
    return None


def next_row(repo, config, split):
    """The first row after every batch already loaded from this split."""
    return max([(src.get("start_row") or 0) + (src.get("max_rows") or 0) for src in hub_sources(repo)
                if same_split(src, config, split) and src.get("max_rows")] + [0])


def load_rows(task_id, rows, audio_col, text_col, start, job, total=None):
    """Decode every row ({column: value}) into a clip of the task. Rows without readable audio are counted."""
    from ..cleaning.datasets import _decode

    sr, split = current_app.config["SAMPLE_RATE"], (set_source(task_id).get("split") or "train")
    added = failed = dups = 0
    for idx, row in enumerate(rows, start):
        if job.stopped:
            break
        try:
            x = _decode(row.get(audio_col), sr)
        except Exception as e:
            failed += 1
            current_app.logger.warning("row %s: cannot decode audio: %s", idx, e)
            continue
        src = row.get(audio_col)
        path = src.get("path") if isinstance(src, dict) else None
        name = os.path.splitext(os.path.basename(path))[0] if path else f"{split}_{idx:06d}"
        dups += bool(add_clip(task_id, name, x, row.get(text_col))[1])
        added += 1
        if added % 10 == 0:
            job.progress(added, total, f"Loaded {added}" + (f" / {total}" if total else "") + " clips")
    set_source(task_id, state="ready", failed=failed, loaded=added, duplicates=dups)
    job.progress(added, total or added, f"Loaded {added} clips" + (f", {failed} could not be read" if failed else "") +
                 (f", {dups} look like audio already in the tool (see Duplicates)" if dups else "") +
                 (" (stopped)" if job.stopped else ""))
    return {"count": added, "failed": failed, "duplicates": dups}
