"""Tasks: a named batch of audio pushed from Upload & Crop. One JSON file per task in TASKS_DIR:

    <task_id>.json   {"id", "name", "created"}

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
