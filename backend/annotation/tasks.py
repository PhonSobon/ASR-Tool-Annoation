"""Tasks: a named batch of audio pushed from Upload & Crop. Table "tasks" (backend/core/db.py):

    id, name, created, created_by, last_push, members {"annotator": [user, ...], "inspector": [...], "acceptor": [...]}

Which audio belong to a task is stored on the audio (audios.task_id), so there is one source of truth.
Annotators, inspectors and acceptors see only the tasks they are members of (allowed()).
"""
import copy
import uuid

from flask import current_app
from sqlalchemy import select

from ..auth import roles
from ..core import db
from ..core.db import Task
from ..core.storage import NotFound, now
from . import audios, review

COLUMNS = ("id", "name", "created", "created_by", "members", "last_push")


class TaskNotFound(NotFound):
    pass


def _dict(row):
    return {c: copy.deepcopy(getattr(row, c)) for c in COLUMNS}


def _row(s, task_id, lock=False):
    row = (db.locked(s, Task, task_id) if lock else s.get(Task, task_id)) if task_id else None
    if not row:
        raise TaskNotFound("Task not found")
    return row


def _read(task_id):
    with db.transaction() as s:
        return _dict(_row(s, task_id))


# ---------- members and access ----------
MEMBER_ROLES = ("annotator", "inspector", "acceptor")
_STEP_PERM = {"annotator": "task.annotate", "inspector": "task.inspect", "acceptor": "task.accept"}


def members(task):
    m = task.get("members") or {}
    return {r: list(m.get(r) or []) for r in MEMBER_ROLES}


def clean_members(value):
    """{"annotator": [...], ...} with known, unique user names. Raises ValueError for an unknown user."""
    from ..auth import users

    value = value if isinstance(value, dict) else {}
    out = {}
    for r in MEMBER_ROLES:
        names = []
        for name in value.get(r) or []:
            name = str(name).strip().lower()
            if not users.exists(name):
                raise ValueError(f"Unknown user {name!r}")
            if name not in names:
                names.append(name)
        out[r] = names
    return out


def allowed(task, user, action):
    """May `user` do `action` ("view" | "edit" | "inspect" | "accept" | "manage") on the task?"""
    if not user:
        return False
    name, m = user["username"], members(task)
    if action == "manage":
        return roles.has(user, "task.manage")
    if action == "view":
        return roles.has(user, "task.view_all") or roles.has(user, "task.manage") or any(name in v for v in m.values())
    if action == "edit":
        return roles.has(user, "task.manage") or any(name in m[r] and roles.has(user, p) for r, p in _STEP_PERM.items())
    perm, member = {"inspect": ("task.inspect", "inspector"), "accept": ("task.accept", "acceptor")}[action]
    return roles.has(user, perm) and (roles.has(user, "task.manage") or name in m[member])


def access(task, user):
    """What the user may do on the task (the browser shows only those buttons)."""
    return {a: allowed(task, user, a) for a in ("view", "edit", "inspect", "accept", "manage")}


def read(task_id):
    return _read(task_id)


def set_members(task_id, value):
    m = clean_members(value)
    with db.transaction() as s:
        _row(s, task_id, lock=True).members = m
    return m


def create_task(name, audio_ids, created_by="", members_=None):
    """Push audio from Upload & Crop into a new task. Raises ValueError if the list is empty or not all drafts."""
    if not audio_ids:
        raise ValueError("Choose at least one audio to push")
    for audio_id in audio_ids:
        if audios.get_meta(audio_id)["task_id"]:
            raise ValueError(f"Audio {audio_id} is already in a task")
    task_id = uuid.uuid4().hex[:12]
    with db.transaction() as s:
        s.add(Task(id=task_id, name=(name or "").strip() or f"Batch {now()[:16]}", created=now(),
                   created_by=created_by, members=clean_members(members_), last_push=None))
    for audio_id in audio_ids:
        audios.set_task(audio_id, task_id)
    return summary(task_id)


def summary(task_id, items=None, task=None):
    """Card data for My Tasks: totals over the task's audio."""
    task = task or _read(task_id)
    items = audios.list_audios(task_id) if items is None else items
    stages = dict.fromkeys(review.STAGES, 0)
    for a in items:
        for k, v in (a.get("stages") or {}).items():
            stages[k] = stages.get(k, 0) + v
    return {**task, "members": members(task), "audio_count": len(items),
            "duration": sum(a["duration"] for a in items),
            "count": sum(a["count"] for a in items),
            "done": sum(a["done"] for a in items),
            "todo": sum(a["todo"] for a in items),
            "stages": stages,
            "updated": max([a["updated"] for a in items] + [task["created"]])}


def get(task_id):
    """Task + its audio, each with its segments (the crops annotated on the task page)."""
    items = audios.list_audios(task_id, with_segments=True)
    return {**summary(task_id, items), "audios": items}


def set_last_push(task_id, push):
    """Remember the last push to the Hub (the push dialog offers that repo again)."""
    with db.transaction() as s:
        _row(s, task_id, lock=True).last_push = push


def list_tasks(user=None):
    """The tasks the user may see (all with user=None), newest first."""
    with db.transaction() as s:
        rows = [_dict(r) for r in s.scalars(select(Task).order_by(Task.created.desc()))]
    return [{**summary(t["id"], task=t), "access": access(t, user) if user else None}
            for t in rows if user is None or allowed(t, user, "view")]


def delete_task(task_id):
    """Delete a task together with its audio, segments and text."""
    _read(task_id)
    for a in audios.list_audios(task_id):
        audios.delete_audio(a["id"])
    with db.transaction() as s:
        s.delete(_row(s, task_id, lock=True))


# ---------- review of a package ----------
def review_package(task_id, audio_id, index, step, decision, note, user):
    """Inspection / acceptance decision on crop `index` of an audio of the task. Returns the crop.
    Raises ValueError (wrong step, missing note, own package) or NotFound."""
    if audios.get_meta(audio_id)["task_id"] != task_id:
        raise audios.AudioNotFound("This audio is not in the task")
    result = {}

    def change(segments):
        if not 0 <= index < len(segments):
            raise NotFound("Package not found")
        crop = segments[index]
        if crop.get("annotator") == user["username"] and user["role"] != "admin":
            raise ValueError("You annotated this package - another person has to check it")
        result["crop"] = review.decide(crop, step, decision, user["username"], note, now())
        return segments

    audios.update_segments(audio_id, change)
    return result["crop"]


# ---------- push to the Hugging Face Hub ----------
SPEAKER_COLUMNS = {"age": "speaker_age", "gender": "speaker_gender", "native": "speaker_native"}
INFO_COLUMNS = {"language": "language", "accent": "accent", "domain": "domain", "subdomain": "subdomain",
                "style": "speech_style", "overlap": "speaker_overlap", "background": "background_sound",
                "codeSwitch": "code_switching", "challenges": "challenges"}
HUB_COLUMNS = [("audio", "audio"), ("text", "string"), ("text_normalized", "string"), ("id", "string"),
               ("task", "string"), ("source_audio", "string"), ("start", "float"), ("end", "float"), ("duration", "float"),
               ("role", "string"), *[(c, "string") for c in SPEAKER_COLUMNS.values()],
               *[(c, "string") for c in INFO_COLUMNS.values()]]
INCLUDE = ("accepted", "passed", "done", "with_text")   # accepted / passed inspection / completed / any text
_INCLUDE_STAGES = {"accepted": {"accepted"}, "passed": {"accepting", "accepted"}}


def crop_done(crop):
    """The annotator checked the package and pressed Complete (and every live dialogue segment has text)."""
    parts = [p for p in (crop.get("parts") or [crop]) if not p.get("deleted")]
    return (not crop.get("deleted") and bool(crop.get("completed")) and bool(parts)
            and all((p.get("text") or "").strip() for p in parts))


def keep_crop(crop, include):
    """Does the package go to the Hub? "accepted" / "passed" (inspection) / "done" (completed) / "with_text"."""
    if include == "with_text":
        return True
    return crop_done(crop) and (include == "done" or review.stage(crop) in _INCLUDE_STAGES[include])


def hub_segments(task_id, include="done"):
    """[(audio_id, audio name, export segment)] that go to the Hub: the segments with text of the packages kept by
    `include` (keep_crop); skipped packages and segments never. Clip ids are the ones of the task ZIP."""
    from ..core import exporter

    out, used = [], set()
    for a in get(task_id)["audios"]:
        name = base = exporter.safe_name(a["name"], a["id"])
        k = 2
        while name in used:  # two audio with the same file name
            name, k = f"{base}_{k}", k + 1
        used.add(name)
        crops = [c if keep_crop(c, include) else {**c, "deleted": True} for c in a["segments"]]
        for s in exporter.from_saved(crops, name):
            if (s.get("text") or "").strip() and s["end"] - s["start"] >= current_app.config["MIN_EXPORT_SECONDS"]:
                out.append((a["id"], a["name"], s))
    return out


def hub_row(task_name, audio_name, s, wav, duration):
    from ..core.text import normalize_text

    text = s["text"].strip()
    speaker, info = s.get("speaker") or {}, s.get("audio_info") or {}
    flat = lambda v: ", ".join(map(str, v)) if isinstance(v, list) else (None if v in (None, "") else str(v))
    return {"audio": {"bytes": wav, "path": s["id"] + ".wav"}, "text": text,
            "text_normalized": (s.get("normalized") or "").strip() or normalize_text(text), "id": s["id"],
            "task": task_name, "source_audio": audio_name, "start": round(float(s["start"]), 3), "end": round(float(s["end"]), 3),
            "duration": duration, "role": s.get("role") or None,
            **{c: flat(speaker.get(k)) for k, c in SPEAKER_COLUMNS.items()},
            **{c: flat(info.get(k)) for k, c in INFO_COLUMNS.items()}}
