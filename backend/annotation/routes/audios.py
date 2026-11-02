"""Uploaded audio: list, upload, open, autosave, cut length, delete."""
from flask import Blueprint, current_app, jsonify, request

from ...auth import guard
from ...auth.guard import require
from .. import access, audios, review, tasks

bp = Blueprint("audios", __name__, url_prefix="/api/audios")


@bp.get("")
def list_audios():
    """?task=<id> -> the audio of that task; no parameter -> audio still in Upload & Crop."""
    task_id = request.args.get("task") or None
    if task_id:
        access.task(task_id)
    else:
        guard.need("audio.upload")
    return jsonify(audios=audios.list_audios(task_id))


@bp.post("")
@require("audio.upload")
def upload():
    """multipart/form-data: audio=<file>. One file per request so the browser can show progress per file."""
    file = request.files.get("audio")
    if not file or not file.filename:
        return jsonify(error="No audio file uploaded"), 400
    try:
        return jsonify(audios.create_audio(file)), 201
    except ValueError as e:
        return jsonify(error=str(e)), 400


@bp.get("/<audio_id>")
def get_audio(audio_id):
    access.audio(audio_id)
    return jsonify(audios.get(audio_id))


@bp.delete("/<audio_id>")
def delete_audio(audio_id):
    if audios.get_meta(audio_id)["task_id"]:
        return jsonify(error="This audio is in a task - delete the task instead"), 400
    access.audio(audio_id)
    audios.delete_audio(audio_id)
    return jsonify(ok=True)


@bp.put("/<audio_id>/state")
def save_state(audio_id):
    """Autosave from the editor: {segments, changed?}. Segments with times, text, role, word timings and status.
    In a task, `changed` = indexes of the packages edited (the others stay as saved) and the review decisions
    on the packages are kept (annotation/review.py)."""
    data = request.get_json(force=True) or {}
    segments, changed = data.get("segments", []), data.get("changed")
    if not isinstance(segments, list) or (changed is not None and not isinstance(changed, list)):
        return jsonify(error="segments (and changed) must be lists"), 400
    meta = access.audio(audio_id, "edit")
    if meta["task_id"]:
        task, user = tasks.read(meta["task_id"]), guard.current_user()
        may_review = any(tasks.allowed(task, user, a) for a in ("inspect", "accept", "manage"))
        audios.update_segments(audio_id, lambda old: review.merge_saved(old, segments, may_review, changed))
    else:
        audios.save_segments(audio_id, segments)
    return jsonify(ok=True)


@bp.post("/<audio_id>/recut")
def recut(audio_id):
    """Cut the whole audio again into fixed-length segments {chunk_seconds} (replaces the saved segments)."""
    if audios.get_meta(audio_id)["task_id"]:
        return jsonify(error="This audio is in a task - it cannot be cut again"), 400
    access.audio(audio_id)
    try:
        chunk = max(1, int(float((request.get_json(force=True) or {}).get("chunk_seconds"))))
    except (TypeError, ValueError):
        chunk = current_app.config["DEFAULT_CHUNK_SECONDS"]
    return jsonify(segments=audios.recut(audio_id, chunk), chunk_seconds=chunk)
