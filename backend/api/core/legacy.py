"""`flask --app app import-json`: copy the data of the versions before the database (JSON files in DATA_DIR) into it.

    data/users.json                      -> users
    data/tasks/<id>.json                 -> tasks
    data/sessions/<id>/meta.json, state.json   -> audios   (full.wav stays where it is)
    data/datasets/<id>/meta.json, items.json   -> datasets (clips/ stays where it is)

Rows that already exist in the database are left alone, so it can be run again. The JSON files are not changed or
deleted.
"""
import os

import click
from flask import current_app
from flask.cli import with_appcontext

from . import db
from .db import Audio, Dataset, Task, User
from .storage import read_json


def _subdirs(root):
    return sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))) if os.path.isdir(root) else []


def import_all():
    """Copy everything found; returns {table: number of rows added}."""
    cfg, added = current_app.config, {"users": 0, "tasks": 0, "audios": 0, "datasets": 0}
    with db.transaction() as s:
        for u in (read_json(cfg["USERS_FILE"], {}) or {}).values():
            if not s.get(User, u["username"]):
                s.add(User(username=u["username"], name=u.get("name") or u["username"], role=u["role"],
                           active=u.get("active", True), password_hash=u["password_hash"], sv=u.get("sv", 1),
                           created=u.get("created", ""), updated=u.get("updated", "")))
                added["users"] += 1

        tasks_dir = cfg["TASKS_DIR"]
        for fname in sorted(os.listdir(tasks_dir)) if os.path.isdir(tasks_dir) else []:
            t = read_json(os.path.join(tasks_dir, fname)) if fname.endswith(".json") else None
            if t and not s.get(Task, t["id"]):
                s.add(Task(id=t["id"], name=t["name"], created=t["created"], created_by=t.get("created_by", ""),
                           members=t.get("members") or {}, last_push=t.get("last_push")))
                added["tasks"] += 1
        s.flush()

        for audio_id in _subdirs(cfg["AUDIO_DIR"]):
            folder = os.path.join(cfg["AUDIO_DIR"], audio_id)
            meta, state = read_json(os.path.join(folder, "meta.json")), read_json(os.path.join(folder, "state.json"), {})
            if not meta or not os.path.isfile(os.path.join(folder, "full.wav")) or s.get(Audio, audio_id):
                continue
            task_id = meta.get("task_id") if meta.get("task_id") and s.get(Task, meta["task_id"]) else None
            s.add(Audio(id=audio_id, name=meta.get("name") or audio_id, duration=meta["duration"],
                        created=meta.get("created", ""), chunk_seconds=meta.get("chunk_seconds"), task_id=task_id,
                        segments=state.get("segments"), updated=state.get("updated")))
            added["audios"] += 1

        from ..cleaning.datasets import _counts

        for dataset_id in _subdirs(cfg["DATASETS_DIR"]):
            folder = os.path.join(cfg["DATASETS_DIR"], dataset_id)
            meta = read_json(os.path.join(folder, "meta.json"))
            if not meta or s.get(Dataset, dataset_id):
                continue
            items = read_json(os.path.join(folder, "items.json"), []) or []
            meta = {**meta, "id": dataset_id}
            if meta.get("state") == "importing":   # the import stopped with the old server
                meta["state"] = "ready"
            s.add(Dataset(id=dataset_id, repo=meta["repo"], config=meta.get("config", "default"),
                          split=meta.get("split", "train"), created=meta.get("created", ""), meta=meta,
                          items=items, summary=_counts(items)))
            added["datasets"] += 1
    return added


@click.command("import-json")
@with_appcontext
def import_json():
    """Copy the JSON data of earlier versions (users, tasks, audio, datasets) into the database."""
    added = import_all()
    click.echo("Imported " + ", ".join(f"{n} {table}" for table, n in added.items()) + ".")
