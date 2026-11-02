"""Access checks shared by the annotation routes: a task by its members, an audio by its task (or, still in
Upload & Crop, by the audio.upload permission)."""
from flask import abort

from ..auth import guard
from . import audios, tasks


def task(task_id, action="view"):
    """The task, or abort 403 if the logged-in user may not do `action` on it."""
    t = tasks.read(task_id)
    if not tasks.allowed(t, guard.current_user(), action):
        abort(403, "You are not assigned to this task" if action == "view" else "Your role cannot do this in this task")
    return t


def audio(audio_id, action="view"):
    """meta.json of the audio, or abort 403. action: "view" | "edit" (of its task)."""
    meta = audios.get_meta(audio_id)
    if meta["task_id"]:
        task(meta["task_id"], action)
    else:
        guard.need("audio.upload", "Only managers can open audio in Upload & Crop")
    return meta
