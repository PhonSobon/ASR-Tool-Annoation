"""The activity log (table "activity"): sign-ins, sign-outs, password changes and every change made through the API,
for the administrator's Activity page.

Changes are logged by an after_request hook from the route that handled them (ACTIONS below); sign-in and password
changes are logged by their routes. The same action on the same thing repeated within REPEAT_SECONDS (the editor's
autosave, reviewing clip after clip of one dataset is not the same thing) adds to the "count" of the last line instead
of a new line.
"""
import time

from flask import request
from sqlalchemy import func, select

from ..core import db
from ..core.db import Activity, User
from ..core.storage import now
from . import guard

REPEAT_SECONDS = 120
ONLINE_SECONDS = 5 * 60

# endpoint -> (action, label). GET requests are logged only when listed here (downloads).
ACTIONS = {
    "audios.upload": ("audio.upload", "Uploaded audio"),
    "audios.delete_audio": ("audio.delete", "Deleted audio"),
    "audios.save_state": ("audio.edit", "Edited segments"),
    "audios.recut": ("audio.recut", "Re-cut audio"),
    "export.export_audio": ("data.export", "Downloaded a ZIP"),
    "export.export_task": ("data.export", "Downloaded a ZIP"),
    "tasks.push": ("task.create", "Created a task"),
    "tasks.delete_task": ("task.delete", "Deleted a task"),
    "tasks.set_members": ("task.members", "Assigned people to a task"),
    "tasks.claim": ("task.claim", "Pulled a task"),
    "tasks.pull": ("task.claim", "Pulled a task"),
    "tasks.share": ("task.share", "Pushed a task to annotators (or took it back)"),
    "tasks.review": ("task.review", "Reviewed a package"),
    "tasks.stop": ("task.stop", "Stopped a job"),
    "tasks.hub_push": ("hub.push", "Pushed to Hugging Face"),
    "asr.transcribe": ("asr.run", "Ran speech recognition"),
    "datasets.import_dataset": ("dataset.import", "Imported a dataset"),
    "datasets.create_local": ("dataset.upload", "Uploaded a dataset from a folder"),
    "tasks.load_hub": ("task.load", "Loaded a Hugging Face dataset into a task"),
    "tasks.load_local": ("task.load", "Loaded a local folder into a task"),
    "datasets.finish_local": ("dataset.upload_done", "Finished uploading a dataset"),
    "datasets.set_members": ("dataset.members", "Assigned people to a dataset"),
    "datasets.claim": ("dataset.claim", "Claimed a dataset"),
    "datasets.delete_dataset": ("dataset.delete", "Deleted a dataset"),
    "datasets.stop": ("dataset.stop", "Stopped a job"),
    "datasets.update_item": ("dataset.clip", "Reviewed a clip"),
    "datasets.split_item": ("dataset.split", "Split a clip"),
    "datasets.join_item": ("dataset.join", "Joined clips"),
    "datasets.recognize_item": ("asr.run", "Ran speech recognition"),
    "datasets.accept_passing": ("dataset.bulk_accept", "Accepted all passing clips"),
    "datasets.check": ("dataset.check", "Ran the quality check"),
    "datasets.push": ("hub.push", "Pushed to Hugging Face"),
    "datasets.export": ("data.export", "Downloaded a ZIP"),
    "auth.create_user": ("user.create", "Added a user"),
    "auth.update_user": ("user.update", "Changed a user"),
    "auth.delete_user": ("user.delete", "Deleted a user"),
    "auth.activity_report": ("report.download", "Downloaded an activity report"),
}
LABELS = {
    "login": "Signed in", "login.failed": "Wrong password", "logout": "Signed out",
    "password.change": "Changed own password", **{a: label for a, label in ACTIONS.values()},
}
# request body fields worth showing in the detail (never a password)
_DETAIL_KEYS = ("step", "decision", "status", "role", "active", "username", "name", "repo_id", "audio_id", "index")


def _ip():
    return (request.headers.get("X-Forwarded-For") or request.remote_addr or "").split(",")[0].strip()[:64]


def log(user, action, detail="", ok=True, username=None):
    """Add a line (or count a repeat of the last one). `user` may be None when only the name is known."""
    name = (user or {}).get("username") or username or ""
    if not name:
        return
    at = now()
    with db.transaction() as s:
        last = s.scalars(select(Activity).where(Activity.username == name).order_by(Activity.id.desc()).limit(1)).first()
        if (last and last.action == action and last.detail == detail and last.ok == ok
                and _seconds(last.at, at) <= REPEAT_SECONDS and action not in ("login", "logout")):
            last.count, last.at = (last.count or 1) + 1, at
            return
        s.add(Activity(at=at, username=name[:32], role=(user or {}).get("role", ""), action=action,
                       detail=detail[:500], ok=ok, ip=_ip(), count=1))


def _seconds(a, b):
    try:
        return abs(time.mktime(time.strptime(b, "%Y-%m-%d %H:%M:%S")) - time.mktime(time.strptime(a, "%Y-%m-%d %H:%M:%S")))
    except ValueError:
        return 1e9


def _detail():
    parts = [f"{k.replace('_id', '')}: {v}" for k, v in (request.view_args or {}).items()]
    body = request.get_json(silent=True) if request.is_json else None
    if isinstance(body, dict):
        parts += [f"{k}: {body[k]}" for k in _DETAIL_KEYS if k in body and not isinstance(body[k], (dict, list))]
    if request.files:
        parts += [f"file: {f.filename}" for f in request.files.values()]
    return ", ".join(parts)


def record(response):
    """after_request: log the change (or download) this request made, refused ones too."""
    try:
        entry = ACTIONS.get(request.endpoint or "")
        if entry and (request.method != "GET" or response.status_code < 400) and (user := guard.current_user()):
            log(user, entry[0], _detail(), ok=response.status_code < 400)
    except Exception:   # the log never breaks the request
        pass
    return response


# ---------- what the Activity page shows ----------
def _row(a):
    return {"id": a.id, "at": a.at, "username": a.username, "role": a.role, "action": a.action,
            "label": LABELS.get(a.action, a.action), "detail": a.detail, "ok": a.ok, "ip": a.ip, "count": a.count or 1}


def entries(username="", role="", action="", since="", until="", q="", page=1, per=50):
    """{entries, total, page, pages} newest first. since / until: "YYYY-MM-DD"."""
    cond = []
    if username:
        cond.append(Activity.username == username)
    if role:
        cond.append(Activity.role == role)
    if action:
        cond.append(Activity.action.startswith(action) if action.endswith(".") else Activity.action == action)
    if since:
        cond.append(Activity.at >= since[:10])
    if until:
        cond.append(Activity.at <= until[:10] + " 99")
    if q:
        cond.append(Activity.detail.ilike(f"%{q}%") | Activity.username.ilike(f"%{q}%"))
    per = max(1, min(int(per or 50), 500))
    with db.transaction() as s:
        total = s.scalar(select(func.count()).select_from(Activity).where(*cond))
        pages = max(1, -(-total // per))
        page = max(1, min(int(page or 1), pages))
        rows = s.scalars(select(Activity).where(*cond).order_by(Activity.id.desc()).offset((page - 1) * per).limit(per))
        return {"entries": [_row(a) for a in rows], "total": total, "page": page, "pages": pages}


def overview():
    """Every user with their status and what they did today and in the last 7 days, and counts for the cards."""
    today = now()[:10]
    week = time.strftime("%Y-%m-%d", time.localtime(time.time() - 6 * 86400))
    online_after = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(time.time() - ONLINE_SECONDS))
    work = Activity.action.notin_(("login", "login.failed", "logout"))
    with db.transaction() as s:
        def counts(since):
            q = select(Activity.username, func.sum(Activity.count)).where(Activity.at >= since, work).group_by(Activity.username)
            return dict(s.execute(q).all())
        day, seven = counts(today), counts(week)
        last = dict(s.execute(select(Activity.username, func.max(Activity.at)).where(work).group_by(Activity.username)).all())
        failed = dict(s.execute(select(Activity.username, func.sum(Activity.count))
                                .where(Activity.action == "login.failed", Activity.at >= today)
                                .group_by(Activity.username)).all())
        users = list(s.scalars(select(User)))
    rows = []
    for u in users:
        online = bool(u.active and u.last_seen and u.last_seen >= online_after)
        status = ("deactivated" if not u.active else "online" if online
                  else "never" if not u.last_login else "default_password" if u.must_change else "offline")
        rows.append({"username": u.username, "name": u.name, "role": u.role, "active": u.active, "status": status,
                     "must_change": bool(u.must_change), "last_login": u.last_login, "last_seen": u.last_seen,
                     "last_action": last.get(u.username), "actions_today": int(day.get(u.username) or 0),
                     "actions_week": int(seven.get(u.username) or 0), "failed_today": int(failed.get(u.username) or 0)})
    from .roles import ROLES
    rows.sort(key=lambda r: (list(ROLES).index(r["role"]) if r["role"] in ROLES else 99, r["username"]))
    active = [r for r in rows if r["active"]]
    return {
        "users": rows,
        "totals": {
            "users": len(active), "online": sum(r["status"] == "online" for r in active),
            "active_today": sum(r["actions_today"] > 0 for r in active),
            "idle_today": sum(r["actions_today"] == 0 for r in active),
            "default_password": sum(r["must_change"] for r in active),
            "never": sum(r["status"] == "never" for r in active),
            "failed_today": sum(r["failed_today"] for r in rows),
            "by_role": {role: sum(r["role"] == role for r in active) for role in ROLES},
        },
        "actions": [{"id": a, "label": label} for a, label in sorted(LABELS.items(), key=lambda x: x[1])],
        "today": today,
    }
