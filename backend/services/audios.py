"""Uploaded audio files on disk: one folder per audio in AUDIO_DIR.

    <audio_id>/full.wav     16 kHz mono 16-bit audio
    <audio_id>/meta.json    name, duration, created, chunk_seconds, task_id (null = still in Upload & Crop)
    <audio_id>/state.json   the editor's segments (autosaved), updated
"""
import json
import os
import shutil
import time
import uuid
import wave

from flask import current_app

from . import audio


class NotFound(Exception):
    pass


class AudioNotFound(NotFound):
    pass


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def audio_dir(audio_id):
    return os.path.join(current_app.config["AUDIO_DIR"], os.path.basename(audio_id or ""))


def wav_path(audio_id):
    """Path of an audio's WAV; raises AudioNotFound if it does not exist."""
    path = os.path.join(audio_dir(audio_id), "full.wav")
    if not audio_id or not os.path.isfile(path):
        raise AudioNotFound("Audio not found - upload it again")
    return path


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


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
    write_json(os.path.join(d, "meta.json"), {
        "name": os.path.splitext(os.path.basename(file.filename))[0], "duration": duration,
        "created": now(), "chunk_seconds": None, "task_id": None})
    return get(audio_id)


def get_meta(audio_id):
    """meta.json (made up from the WAV for audio uploaded before meta.json existed)."""
    path = wav_path(audio_id)
    meta = read_json(os.path.join(audio_dir(audio_id), "meta.json"))
    if not meta:
        with wave.open(path, "rb") as w:
            duration = w.getnframes() / w.getframerate()
        meta = {"name": audio_id, "duration": duration, "chunk_seconds": None,
                "created": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(path)))}
    meta.setdefault("task_id", None)
    return meta


def get_segments(audio_id, meta=None):
    """Saved segments, or fixed-length ones if the audio was never edited."""
    meta = meta or get_meta(audio_id)
    state = read_json(os.path.join(audio_dir(audio_id), "state.json"), {})
    return state.get("segments") or propose_segments(meta["duration"], meta.get("chunk_seconds"))


def is_processed(seg):
    """The package is in the Processed tab of the task page: completed by the annotator, or skipped (the crop or
    every dialogue segment of it deleted). Same rule as cropState() in crops.js."""
    if seg.get("deleted") or (seg.get("parts") and all(p.get("deleted") for p in seg["parts"])):
        return True
    return bool(seg.get("completed"))


def summary(audio_id):
    """List-row data: meta + segment progress."""
    meta = get_meta(audio_id)
    state = read_json(os.path.join(audio_dir(audio_id), "state.json"), {})
    every = get_segments(audio_id, meta)
    segs = [s for s in every if not s.get("deleted")]
    done = sum(1 for s in every if is_processed(s))
    return {**meta, "id": audio_id, "count": len(segs), "done": done, "todo": len(every) - done,
            "updated": state.get("updated") or meta.get("created")}


def get(audio_id):
    """Summary + segments (what the editor loads)."""
    return {**summary(audio_id), "segments": get_segments(audio_id)}


def list_audios(task_id=None):
    """Audio of one task, or (task_id=None) the ones still in Upload & Crop. Oldest first."""
    out = []
    for audio_id in os.listdir(current_app.config["AUDIO_DIR"]):
        try:
            s = summary(audio_id)
        except AudioNotFound:  # leftover folder without audio
            continue
        if s["task_id"] == task_id:
            out.append(s)
    return sorted(out, key=lambda a: (a.get("created", ""), a["name"]))


def _update_meta(audio_id, **changes):
    write_json(os.path.join(audio_dir(audio_id), "meta.json"), {**get_meta(audio_id), **changes})


def save_segments(audio_id, segments):
    wav_path(audio_id)
    write_json(os.path.join(audio_dir(audio_id), "state.json"), {"segments": segments, "updated": now()})


def recut(audio_id, chunk_sec):
    """Replace the segments with fixed-length ones (saved). Returns them."""
    meta = get_meta(audio_id)
    segments = propose_segments(meta["duration"], chunk_sec)
    _update_meta(audio_id, chunk_seconds=chunk_sec)
    save_segments(audio_id, segments)
    return segments


def set_task(audio_id, task_id):
    _update_meta(audio_id, task_id=task_id)


def delete_audio(audio_id):
    audio.forget(wav_path(audio_id))
    shutil.rmtree(audio_dir(audio_id), ignore_errors=True)  # OneDrive may keep an empty folder; it is ignored
