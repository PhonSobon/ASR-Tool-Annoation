"""The Project Dashboard (administrators and project managers): where the work stands, read from the tasks and
their packages in one pass (no counters to keep in step).

    tasks      how many tasks, and their pull status: not shared, pushed and waiting for a pull, pulled, finished
    pipeline   packages per review stage (to annotate, returned, waiting for review, accepted, skipped)
    hours      speech time of every package and of the accepted ones
    quality    packages reviewed, accepted, returned, first-time acceptance rate, return rate
    daily      per day of the period: packages completed, accepted, returned
    waiting    the oldest package waiting for review (how long reviewers are behind)
    attention  tasks that need a manager: pushed but nobody pulled, pulled but no save for STALE_DAYS, returned
               packages not fixed yet
    team       active users per role, and the annotators free to pull (no unfinished task)
    cleaning   dataset batches and their clips by review status
    rows       one row per task, for the table
"""
from datetime import datetime, timedelta

from sqlalchemy import select

from ..auth.roles import ROLES
from ..auth.workload import _crop_seconds
from ..cleaning.datasets import clip_seconds
from ..core import db
from ..core.db import Audio, Dataset, Task, User
from ..core.storage import now
from . import review, tasks

STALE_DAYS = 3
FMT = "%Y-%m-%d %H:%M:%S"


def _when(stamp):
    try:
        return datetime.strptime(str(stamp)[:19], FMT)
    except (TypeError, ValueError):
        return None


def _status(t, row):
    """not_shared | waiting_pull | pulled | assigned | finished"""
    open_pkgs = sum(row["stages"][k] for k in ("annotating", "returned", "inspecting"))
    if row["packages"] and not open_pkgs:
        return "finished"
    if tasks.pulls(t, "annotator"):
        return "pulled"
    if "annotator" in tasks.clean_open_roles(t.get("open_roles")):
        return "waiting_pull"
    return "assigned" if tasks.members(t)["annotator"] else "not_shared"


def overview(days=14):
    days = max(1, min(int(days or 14), 90))
    today = datetime.strptime(now(), FMT)
    first = (today - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    daily = {(today - timedelta(days=k)).strftime("%Y-%m-%d"): {"completed": 0, "accepted": 0, "returned": 0}
             for k in range(days - 1, -1, -1)}

    with db.transaction() as s:
        task_rows = [tasks._dict(r) for r in s.scalars(select(Task).order_by(Task.created.desc()))]
        audio_rows = s.execute(select(Audio.task_id, Audio.duration, Audio.segments, Audio.updated)
                               .where(Audio.task_id.is_not(None))).all()
        users = [(u.username, u.name, u.role, bool(u.active)) for u in s.scalars(select(User))]
        dataset_rows = s.execute(select(Dataset.id, Dataset.meta, Dataset.items)).all()

    per = {t["id"]: {"packages": 0, "seconds": 0.0, "accepted_seconds": 0.0, "audio_seconds": 0.0,
                     "stages": dict.fromkeys(review.STAGES, 0), "last_save": t["created"]} for t in task_rows}
    quality = {"reviewed_packages": 0, "first_pass": 0, "accepted": 0, "returned": 0, "reviews": 0}
    oldest = {"inspecting": None}

    for task_id, duration, segments, updated in audio_rows:
        r = per.get(task_id)
        if r is None:
            continue
        r["audio_seconds"] += duration or 0
        if updated and updated > r["last_save"]:
            r["last_save"] = updated
        for crop in segments or []:
            if not isinstance(crop, dict):
                continue
            st = review.stage(crop)
            r["stages"][st] += 1
            if st == "skipped":
                continue
            secs = _crop_seconds(crop)
            r["packages"] += 1
            r["seconds"] += secs
            if st == "accepted":
                r["accepted_seconds"] += secs
            if st in oldest and crop.get("updated") and (oldest[st] is None or crop["updated"] < oldest[st]):
                oldest[st] = crop["updated"]
            if crop.get("completed") and crop.get("updated", "")[:10] in daily:
                daily[crop["updated"][:10]]["completed"] += 1
            history = crop.get("history") or []
            # the first review decision of the package ("inspection" = the first step before it was combined)
            reviews = [h for h in history if h.get("stage") in ("review", "inspection")]
            if reviews:
                quality["reviewed_packages"] += 1
                if reviews[0].get("decision") in ("accept", "pass"):
                    quality["first_pass"] += 1
            quality["reviews"] += len(reviews)
            for h in history:
                d, at = h.get("decision"), (h.get("at") or "")[:10]
                key = {"accept": "accepted", "return": "returned"}.get(d)
                if key:
                    quality[key] += 1
                    if at in daily:
                        daily[at][key] += 1

    rows, attention = [], []
    stale_before = (today - timedelta(days=STALE_DAYS)).strftime(FMT)
    for t in task_rows:
        r = per[t["id"]]
        row = {"id": t["id"], "name": t["name"], "created": t["created"], "created_by": t.get("created_by") or "",
               "kind": (t.get("source") or {}).get("kind") or "upload",
               "annotators": tasks.members(t)["annotator"], "pulled": tasks.pulls(t, "annotator"),
               "packages": r["packages"], "stages": r["stages"], "hours": round(r["seconds"] / 3600, 3),
               "accepted_hours": round(r["accepted_seconds"] / 3600, 3), "last_save": r["last_save"]}
        row["status"] = _status(t, row)
        st = r["stages"]
        row["completed"] = st["inspecting"] + st["accepted"]
        rows.append(row)
        if row["status"] == "waiting_pull":
            attention.append({"task": t["id"], "name": t["name"], "kind": "waiting_pull",
                              "text": "Pushed to annotators, nobody pulled it yet"})
        if row["status"] in ("pulled", "assigned") and st["annotating"] + st["returned"] and r["last_save"] < stale_before:
            who = ", ".join(p["username"] for p in row["pulled"]) or ", ".join(row["annotators"])
            attention.append({"task": t["id"], "name": t["name"], "kind": "stale",
                              "text": f"No save for more than {STALE_DAYS} days ({who})", "since": r["last_save"]})
        if st["returned"]:
            attention.append({"task": t["id"], "name": t["name"], "kind": "returned",
                              "text": f"{st['returned']} returned package{'s' * (st['returned'] > 1)} to fix"})

    pipeline = {k: sum(r["stages"][k] for r in rows) for k in review.STAGES}
    packages = sum(r["packages"] for r in rows)
    completed = pipeline["inspecting"] + pipeline["accepted"]
    returns, reviews = quality["returned"], quality["reviews"]
    quality.update(
        first_pass_rate=round(100 * quality["first_pass"] / quality["reviewed_packages"], 1) if quality["reviewed_packages"] else None,
        return_rate=round(100 * returns / reviews, 1) if reviews else None)

    busy = {a for r in rows if r["status"] != "finished" for a in r["annotators"]}
    team = {role: {"label": label, "active": sum(1 for u in users if u[2] == role and u[3]),
                   "total": sum(1 for u in users if u[2] == role)} for role, (label, _) in ROLES.items()}
    free = sorted(u[0] for u in users if u[2] == "annotator" and u[3] and u[0] not in busy)

    clips = {"todo": 0, "accepted": 0, "rejected": 0, "likely_bad": 0, "accepted_hours": 0.0}
    for _, meta, items in dataset_rows:
        for it in items or []:
            clips[it.get("status") if it.get("status") in ("todo", "accepted", "rejected") else "todo"] += 1
            if it.get("category") == "likely_bad" and it.get("status") == "todo":
                clips["likely_bad"] += 1
            if it.get("status") == "accepted":
                clips["accepted_hours"] += clip_seconds(it) / 3600
    clips["accepted_hours"] = round(clips["accepted_hours"], 3)

    count = lambda status: sum(1 for r in rows if r["status"] == status)
    return {
        "generated": now(), "days": days, "since": first,
        "tasks": {"total": len(rows), "not_shared": count("not_shared"), "waiting_pull": count("waiting_pull"),
                  "pulled": count("pulled"), "assigned": count("assigned"), "finished": count("finished")},
        "packages": {"total": packages, "completed": completed, "todo": pipeline["annotating"] + pipeline["returned"]},
        "pipeline": pipeline,
        "hours": {"total": round(sum(r["hours"] for r in rows), 3),
                  "accepted": round(sum(r["accepted_hours"] for r in rows), 3)},
        "quality": {**quality, "returns": returns},
        "waiting": oldest,
        "daily": [{"day": d, **v} for d, v in daily.items()],
        "attention": attention,
        "team": {"roles": team, "free_annotators": free},
        "cleaning": {"datasets": len(dataset_rows), **clips},
        "rows": rows,
    }
