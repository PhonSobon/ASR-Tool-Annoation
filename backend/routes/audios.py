"""Uploaded audio: list, upload, open, autosave, cut length, delete."""
from flask import Blueprint, current_app, jsonify, request

from ..services import audios

bp = Blueprint("audios", __name__, url_prefix="/api/audios")


@bp.get("")
def list_audios():
    """?task=<id> -> the audio of that task; no parameter -> audio still in Upload & Crop."""
    return jsonify(audios=audios.list_audios(request.args.get("task") or None))


@bp.post("")
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
    return jsonify(audios.get(audio_id))


@bp.delete("/<audio_id>")
def delete_audio(audio_id):
    audios.delete_audio(audio_id)
    return jsonify(ok=True)


@bp.put("/<audio_id>/state")
def save_state(audio_id):
    """Autosave from the editor: segments with times, text, role, word timings and status."""
    segments = (request.get_json(force=True) or {}).get("segments", [])
    if not isinstance(segments, list):
        return jsonify(error="segments must be a list"), 400
    audios.save_segments(audio_id, segments)
    return jsonify(ok=True)


@bp.post("/<audio_id>/recut")
def recut(audio_id):
    """Cut the whole audio again into fixed-length segments {chunk_seconds} (replaces the saved segments)."""
    try:
        chunk = max(1, int(float((request.get_json(force=True) or {}).get("chunk_seconds"))))
    except (TypeError, ValueError):
        chunk = current_app.config["DEFAULT_CHUNK_SECONDS"]
    return jsonify(segments=audios.recut(audio_id, chunk), chunk_seconds=chunk)
