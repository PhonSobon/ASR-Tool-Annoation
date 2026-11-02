"""The Work Dashboard (Administrator): what every user produced, read from the work itself (not the activity log).

Per user, within an optional period (since / until "YYYY-MM-DD"):

    annotation  packages they annotated and completed (crop.annotator, counted by crop.updated) and their hours,
                how many of them were accepted (by acceptance.at), times their packages were returned (errors, by the
                return's time), packages still in progress
    review      inspection passes, acceptances and returns they made (crop.history)
    cleaning    dataset clips they accepted / rejected (item.reviewer, by item.updated) and the accepted hours
"""
from sqlalchemy import select

from ..annotation import review
from ..cleaning.datasets import clip_seconds
from ..core import db
from ..core.db import Audio, Dataset, User


def _crop_seconds(crop):
    """Speech time of a package: its live dialogue segments, or the crop itself."""
    parts = [p for p in (crop.get("parts") or [crop]) if not p.get("deleted")]
    return sum(max(0.0, float(p["end"]) - float(p["start"])) for p in parts)


def _blank():
    return {"annotation": {"done": 0, "done_seconds": 0.0, "accepted": 0, "accepted_seconds": 0.0, "passed": 0,
                           "returned": 0, "in_progress": 0},
            "review": {"inspected": 0, "accepted": 0, "returned": 0},
            "cleaning": {"accepted": 0, "rejected": 0, "accepted_seconds": 0.0}}


def stats(since="", until=""):
    """{users: [{username, name, role, active, annotation, review, cleaning}], totals: {...}, since, until}"""
    since, until = (since or "")[:10], (until or "")[:10]
    # no period: everything counts; else the time stamp must be in it
    inside = lambda at: not (since or until) or bool(at) and (not since or at[:10] >= since) and (not until or at[:10] <= until)
    with db.transaction() as s:
        users = list(s.scalars(select(User)))
        crops_of = [segs for segs in s.scalars(select(Audio.segments).where(Audio.task_id.is_not(None))) if segs]
        items_of = [items for items in s.scalars(select(Dataset.items)) if items]
    per = {}
    get = lambda name: per.setdefault(name, _blank())

    for crops in crops_of:
        for crop in crops:
            st = review.stage(crop)
            if st == "skipped":
                continue
            who = crop.get("annotator")
            if who:
                a, secs = get(who)["annotation"], _crop_seconds(crop)
                if st in ("annotating", "returned"):
                    a["in_progress"] += 1
                elif inside(crop.get("updated")):
                    a["done"] += 1
                    a["done_seconds"] += secs
                if st in ("accepting", "accepted") and inside((crop.get("inspection") or {}).get("at")):
                    a["passed"] += 1
                if st == "accepted" and inside((crop.get("acceptance") or {}).get("at")):
                    a["accepted"] += 1
                    a["accepted_seconds"] += secs
            for h in crop.get("history") or []:
                if not inside(h.get("at")):
                    continue
                if h.get("decision") == "return" and who:
                    get(who)["annotation"]["returned"] += 1
                key = {"pass": "inspected", "accept": "accepted", "return": "returned"}.get(h.get("decision"))
                if h.get("by") and key:
                    get(h["by"])["review"][key] += 1

    for items in items_of:
        for it in items:
            who, status = it.get("reviewer"), it.get("status")
            if not who or status not in ("accepted", "rejected") or not inside(it.get("updated")):
                continue
            c = get(who)["cleaning"]
            c[status] += 1
            if status == "accepted":
                c["accepted_seconds"] += clip_seconds(it)

    known = {u.username: u for u in users}
    rows = []
    for name in sorted(set(known) | set(per)):
        u = known.get(name)
        row = {"username": name, "name": u.name if u else name, "role": u.role if u else "",
               "active": bool(u.active) if u else False, "deleted": u is None, **per.get(name, _blank())}
        for group in ("annotation", "cleaning"):
            for k, v in row[group].items():
                if k.endswith("_seconds"):
                    row[group][k] = round(v, 1)
        rows.append(row)
    from .roles import ROLES
    rows.sort(key=lambda r: (list(ROLES).index(r["role"]) if r["role"] in ROLES else 99, r["username"]))
    total = lambda group, key: sum(r[group][key] for r in rows)
    return {
        "users": rows, "since": since, "until": until,
        "totals": {"done": total("annotation", "done"), "done_seconds": round(total("annotation", "done_seconds"), 1),
                   "accepted": total("annotation", "accepted"),
                   "accepted_seconds": round(total("annotation", "accepted_seconds"), 1),
                   "returned": total("annotation", "returned"), "in_progress": total("annotation", "in_progress"),
                   "clips_accepted": total("cleaning", "accepted"), "clips_rejected": total("cleaning", "rejected"),
                   "clips_seconds": round(total("cleaning", "accepted_seconds"), 1)},
    }
