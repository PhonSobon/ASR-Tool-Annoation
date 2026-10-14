"""Tasks: push audio from Upload & Crop into a batch, list (My Tasks), open, delete."""
from flask import Blueprint, jsonify, request

from ..services import tasks

bp = Blueprint("tasks", __name__, url_prefix="/api/tasks")


@bp.get("")
def list_tasks():
    return jsonify(tasks=tasks.list_tasks())


@bp.post("")
def push():
    """Body: {name, audio_ids: [...]} -> new task with those audio."""
    data = request.get_json(force=True) or {}
    try:
        return jsonify(tasks.create_task(data.get("name"), data.get("audio_ids") or [])), 201
    except ValueError as e:
        return jsonify(error=str(e)), 400


@bp.get("/<task_id>")
def get_task(task_id):
    return jsonify(tasks.get(task_id))


@bp.delete("/<task_id>")
def delete_task(task_id):
    tasks.delete_task(task_id)
    return jsonify(ok=True)
