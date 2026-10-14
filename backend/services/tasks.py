"""Tasks: a named batch of audio pushed from Upload & Crop. One JSON file per task in TASKS_DIR:

    <task_id>.json   {"id", "name", "created", "last_push"}

Which audio belong to a task is stored on the audio (meta.json "task_id"), so there is one source of truth.
"""
import os
import uuid

from flask import current_app

from . import audios
from .audios import NotFound, now, read_json, write_json


class TaskNotFound(NotFound):
    pass


def _path(task_id):
    return os.path.join(current_app.config["TASKS_DIR"], os.path.basename(task_id or "") + ".json")


def _read(task_id):
    task = read_json(_path(task_id)) if task_id else None
    if not task:
        raise TaskNotFound("Task not found")
    return task


def create_task(name, audio_ids):
    """Push audio from Upload & Crop into a new task. Raises ValueError if the list is empty or not all drafts."""
    if not audio_ids:
        raise ValueError("Choose at least one audio to push")
    for audio_id in audio_ids:
        if audios.get_meta(audio_id)["task_id"]:
            raise ValueError(f"Audio {audio_id} is already in a task")
    task = {"id": uuid.uuid4().hex[:12], "name": (name or "").strip() or f"Batch {now()[:16]}", "created": now()}
    write_json(_path(task["id"]), task)
    for audio_id in audio_ids:
        audios.set_task(audio_id, task["id"])
    return summary(task["id"])


def summary(task_id, items=None):
    """Card data for My Tasks: totals over the task's audio."""
    task = _read(task_id)
    items = audios.list_audios(task_id) if items is None else items
    return {**task, "audio_count": len(items),
            "duration": sum(a["duration"] for a in items),
            "count": sum(a["count"] for a in items),
            "done": sum(a["done"] for a in items),
            "todo": sum(a["todo"] for a in items),
            "updated": max([a["updated"] for a in items] + [task["created"]])}


def get(task_id):
    """Task + its audio, each with its segments (the crops annotated on the task page)."""
    items = audios.list_audios(task_id)
    return {**summary(task_id, items), "audios": [{**a, "segments": audios.get_segments(a["id"])} for a in items]}


def set_last_push(task_id, push):
    """Remember the last push to the Hub (the push dialog offers that repo again)."""
    write_json(_path(task_id), {**_read(task_id), "last_push": push})


def list_tasks():
    """All tasks, newest first."""
    out = []
    for fname in os.listdir(current_app.config["TASKS_DIR"]):
        if fname.endswith(".json"):
            try:
                out.append(summary(fname[:-5]))
            except TaskNotFound:
                continue
    return sorted(out, key=lambda t: t["created"], reverse=True)


def delete_task(task_id):
    """Delete a task together with its audio, segments and text."""
    _read(task_id)
    for a in audios.list_audios(task_id):
        audios.delete_audio(a["id"])
    os.remove(_path(task_id))


# ---------- push to the Hugging Face Hub ----------
SPEAKER_COLUMNS = {"age": "speaker_age", "gender": "speaker_gender", "native": "speaker_native"}
INFO_COLUMNS = {"language": "language", "accent": "accent", "domain": "domain", "subdomain": "subdomain",
                "style": "speech_style", "overlap": "speaker_overlap", "background": "background_sound",
                "codeSwitch": "code_switching", "challenges": "challenges"}
HUB_COLUMNS = [("audio", "audio"), ("text", "string"), ("text_normalized", "string"), ("id", "string"),
               ("task", "string"), ("source_audio", "string"), ("start", "float"), ("end", "float"), ("duration", "float"),
               ("role", "string"), *[(c, "string") for c in SPEAKER_COLUMNS.values()],
               *[(c, "string") for c in INFO_COLUMNS.values()]]
INCLUDE = ("done", "with_text")


def crop_done(crop):
    """Every live dialogue segment of the crop has text (the package is completed)."""
    parts = [p for p in (crop.get("parts") or [crop]) if not p.get("deleted")]
    return not crop.get("deleted") and bool(parts) and all((p.get("text") or "").strip() for p in parts)


def hub_segments(task_id, include="done"):
    """[(audio_id, audio name, export segment)] that go to the Hub: the segments with text of the completed
    packages ("done") or of every package ("with_text"); skipped packages and segments never. Clip ids are the
    ones of the task ZIP."""
    from . import exporter

    out, used = [], set()
    for a in get(task_id)["audios"]:
        name = base = exporter.safe_name(a["name"], a["id"])
        k = 2
        while name in used:  # two audio with the same file name
            name, k = f"{base}_{k}", k + 1
        used.add(name)
        crops = [c if include == "with_text" or crop_done(c) else {**c, "deleted": True} for c in a["segments"]]
        for s in exporter.from_saved(crops, name):
            if (s.get("text") or "").strip() and s["end"] - s["start"] >= current_app.config["MIN_EXPORT_SECONDS"]:
                out.append((a["id"], a["name"], s))
    return out


def hub_row(task_name, audio_name, s, wav, duration):
    from .text import normalize_text

    text = s["text"].strip()
    speaker, info = s.get("speaker") or {}, s.get("audio_info") or {}
    flat = lambda v: ", ".join(map(str, v)) if isinstance(v, list) else (None if v in (None, "") else str(v))
    return {"audio": {"bytes": wav, "path": s["id"] + ".wav"}, "text": text,
            "text_normalized": (s.get("normalized") or "").strip() or normalize_text(text), "id": s["id"],
            "task": task_name, "source_audio": audio_name, "start": round(float(s["start"]), 3), "end": round(float(s["end"]), 3),
            "duration": duration, "role": s.get("role") or None,
            **{c: flat(speaker.get(k)) for k, c in SPEAKER_COLUMNS.items()},
            **{c: flat(info.get(k)) for k, c in INFO_COLUMNS.items()}}
