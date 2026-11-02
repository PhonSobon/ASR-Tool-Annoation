"""Uploaded audio. The sound is on disk, one folder per audio in AUDIO_DIR:

    <audio_id>/full.wav     16 kHz mono 16-bit audio

and the rest in the "audios" table (backend/core/db.py): name, duration, created, chunk_seconds, task_id
(null = still in Upload & Crop), segments (the editor's crops, autosaved; null = never edited), updated.
"""
import copy
import os
import shutil
import uuid

from flask import current_app
from sqlalchemy import select

from ..core import audio, db
from ..core.db import Audio
from ..core.storage import NotFound, now
from . import review

META = ("name", "duration", "created", "chunk_seconds", "task_id")


class AudioNotFound(NotFound):
    pass


def audio_dir(audio_id):
    return os.path.join(current_app.config["AUDIO_DIR"], os.path.basename(audio_id or ""))


def wav_path(audio_id):
    """Path of an audio's WAV; raises AudioNotFound if it does not exist."""
    path = os.path.join(audio_dir(audio_id), "full.wav")
    if not audio_id or not os.path.isfile(path):
        raise AudioNotFound("Audio not found - upload it again")
    return path


def _row(s, audio_id, lock=False):
    row = (db.locked(s, Audio, audio_id) if lock else s.get(Audio, audio_id)) if audio_id else None
    if not row:
        raise AudioNotFound("Audio not found - upload it again")
    return row


def propose_segments(duration, chunk_sec=None):
    """Fixed-length segments covering [0, duration] (one segment if chunk_sec is None).
    A tiny tail is folded into the last segment."""
    chunk_sec = chunk_sec or duration
    segments, t = [], 0.0
    while t < duration - 1e-6:
        end = min(t + chunk_sec, duration)
        segments.append({"start": round(t, 3), "end": round(end, 3)})
        t = end
    if len(segments) > 1 and segments[-1]["end"] - segments[-1]["start"] < 0.3:
        segments[-2]["end"] = segments.pop()["end"]
    return segments


def create_audio(file):
    """Save an uploaded file (werkzeug FileStorage) as a new, not yet cut audio. Raises ValueError if unreadable."""
    audio_id = uuid.uuid4().hex[:12]
    d = audio_dir(audio_id)
    os.makedirs(d)
    src = os.path.join(d, "source" + os.path.splitext(file.filename)[1])
    file.save(src)
    try:
        duration = audio.convert_to_wav(src, os.path.join(d, "full.wav"), current_app.config["SAMPLE_RATE"])
    except Exception as e:
        shutil.rmtree(d, ignore_errors=True)
        raise ValueError(f"Cannot read audio: {e}") from e
    finally:
        if os.path.exists(src):
            os.remove(src)
    with db.transaction() as s:
        s.add(Audio(id=audio_id, name=os.path.splitext(os.path.basename(file.filename))[0], duration=duration,
                    created=now(), chunk_seconds=None, task_id=None))
    return get(audio_id)


def get_meta(audio_id):
    """name, duration, created, chunk_seconds, task_id. Raises AudioNotFound."""
    with db.transaction() as s:
        row = _row(s, audio_id)
        return {c: getattr(row, c) for c in META}


def _segments(row):
    return copy.deepcopy(row.segments) if row.segments else propose_segments(row.duration, row.chunk_seconds)


def get_segments(audio_id, meta=None):
    """Saved segments, or fixed-length ones if the audio was never edited."""
    with db.transaction() as s:
        return _segments(_row(s, audio_id))


def is_processed(seg):
    """The package is in the Processed tab of the task page: completed by the annotator, or skipped (the crop or
    every dialogue segment of it deleted). Same rule as cropState() in crops.js."""
    return review.is_skipped(seg) or bool(seg.get("completed"))


def _summary(row):
    every = _segments(row)
    done = sum(1 for seg in every if is_processed(seg))
    return {**{c: getattr(row, c) for c in META}, "id": row.id,
            "count": sum(1 for seg in every if not seg.get("deleted")), "done": done, "todo": len(every) - done,
            "stages": review.counts(every), "updated": row.updated or row.created}


def summary(audio_id):
    """List-row data: meta + segment progress."""
    with db.transaction() as s:
        return _summary(_row(s, audio_id))


def get(audio_id):
    """Summary + segments (what the editor loads)."""
    with db.transaction() as s:
        row = _row(s, audio_id)
        return {**_summary(row), "segments": _segments(row)}


def list_audios(task_id=None, with_segments=False):
    """Audio of one task, or (task_id=None) the ones still in Upload & Crop. Oldest first."""
    with db.transaction() as s:
        q = select(Audio).where(Audio.task_id == task_id if task_id else Audio.task_id.is_(None))
        rows = s.scalars(q.order_by(Audio.created, Audio.name)).all()
        return [{**_summary(r), **({"segments": _segments(r)} if with_segments else {})} for r in rows]


def save_segments(audio_id, segments):
    with db.transaction() as s:
        row = _row(s, audio_id, lock=True)
        row.segments, row.updated = copy.deepcopy(segments), now()


def update_segments(audio_id, change):
    """Read, change and save the segments in one step (the row is locked meanwhile): change(segments) -> segments."""
    with db.transaction() as s:
        row = _row(s, audio_id, lock=True)
        segments = change(_segments(row))
        row.segments, row.updated = copy.deepcopy(segments), now()
        return segments


def recut(audio_id, chunk_sec):
    """Replace the segments with fixed-length ones (saved). Returns them."""
    with db.transaction() as s:
        row = _row(s, audio_id, lock=True)
        segments = propose_segments(row.duration, chunk_sec)
        row.chunk_seconds, row.segments, row.updated = chunk_sec, segments, now()
        return copy.deepcopy(segments)


def set_task(audio_id, task_id):
    with db.transaction() as s:
        _row(s, audio_id, lock=True).task_id = task_id


def delete_audio(audio_id):
    with db.transaction() as s:
        s.delete(_row(s, audio_id, lock=True))
    try:
        audio.forget(wav_path(audio_id))
    except AudioNotFound:
        pass
    shutil.rmtree(audio_dir(audio_id), ignore_errors=True)  # OneDrive may keep an empty folder; it is ignored
