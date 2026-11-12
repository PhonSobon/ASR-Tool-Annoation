"""Duplicate audio across tasks: the same recording uploaded or loaded twice (also converted, louder / quieter, or a
clip that is part of a longer recording), so nobody annotates - and is paid for - the same speech twice.

Every audio gets an acoustic fingerprint (core/fingerprint.py) when it is uploaded or loaded, kept next to its WAV:

    AUDIO_DIR/<audio_id>/fingerprint.npy

All fingerprints are held in one in-memory index (the API runs as one process). Audio from before this feature gets
its fingerprint from a scan (a background job). A pair is reported once: the newer audio is "the duplicate", the
older one "the original". A manager can skip the duplicate's packages (they leave the work and the pay), delete a
duplicate that is still in Upload & Crop, or mark a pair as not a duplicate (table "duplicate_ignores").
"""
import os
import threading

import numpy as np
from flask import current_app
from sqlalchemy import select

from ..core import audio, db, fingerprint, jobs
from ..core.db import Audio, DuplicateIgnore, Task
from ..core.storage import now
from . import audios, review

JOB_KEY = "duplicates"
_index = fingerprint.Index()
_lock = threading.Lock()
_loaded = {"dir": None}
_pairs = {"version": None, "found": None}   # all-vs-all result, kept until an audio is added / removed
_version = [0]


def _path(audio_id):
    return os.path.join(audios.audio_dir(audio_id), "fingerprint.npy")


def _ensure_loaded():
    """Read every saved fingerprint into the index once (and again when AUDIO_DIR changes, e.g. in tests)."""
    d = current_app.config["AUDIO_DIR"]
    if _loaded["dir"] == d:
        return
    _index.__init__()
    for audio_id in os.listdir(d) if os.path.isdir(d) else []:
        try:
            _index.add(audio_id, np.load(_path(audio_id)))
        except (OSError, ValueError):
            pass
    _loaded["dir"] = d
    _version[0] += 1


def add(audio_id, samples):
    """Fingerprint a new audio (int16 / float samples at 16 kHz), save and index it. Returns its matches."""
    fp = fingerprint.compute(samples)
    np.save(_path(audio_id), fp)
    with _lock:
        _ensure_loaded()
        hits = _index.search(fp, skip={audio_id})
        _index.add(audio_id, fp)
        _version[0] += 1
    return _describe(audio_id, hits)


def forget(audio_id):
    with _lock:
        _index.remove(audio_id)
        _version[0] += 1


def missing():
    """Ids of audio without a fingerprint yet (from before this feature)."""
    with db.transaction() as s:
        ids = list(s.scalars(select(Audio.id)))
    return [i for i in ids if not os.path.isfile(_path(i))]


def scan(job):
    """Background job: fingerprint every audio that has none. Returns how many were done."""
    todo = missing()
    for n, audio_id in enumerate(todo, 1):
        if job.stopped:
            break
        try:
            fp = fingerprint.compute(audio.read_wav(audios.wav_path(audio_id)))
        except Exception as e:   # a missing or broken WAV: skipped, the rest go on
            current_app.logger.warning("fingerprint of %s failed: %s", audio_id, e)
            continue
        np.save(_path(audio_id), fp)
        with _lock:
            _ensure_loaded()
            _index.add(audio_id, fp)
            _version[0] += 1
        job.progress(n, len(todo), f"Fingerprinted {n} / {len(todo)} recordings")
    return {"done": len(todo)}


def start_scan():
    return jobs.start(JOB_KEY, "duplicate scan", scan)


# ---------- the report ----------
def _infos(ids):
    """{audio id: name, duration, created, task id + name, packages} for the given audio."""
    with db.transaction() as s:
        rows = s.scalars(select(Audio).where(Audio.id.in_(list(ids)))).all()
        names = dict(s.execute(select(Task.id, Task.name).where(Task.id.in_({r.task_id for r in rows if r.task_id}))).all())
        return {r.id: {"id": r.id, "name": r.name, "duration": r.duration, "created": r.created, "task_id": r.task_id,
                       "task": names.get(r.task_id), "packages": audios._segments(r), "_order": (r.created, _mtime(r.id))}
                for r in rows}


def _mtime(audio_id):
    """when the WAV was written, to the nanosecond: orders audio created in the same second (a multi-file upload)"""
    try:
        return os.stat(os.path.join(audios.audio_dir(audio_id), "full.wav")).st_mtime_ns
    except OSError:
        return 0


def _packages(info, start, seconds):
    """The packages of an audio that lie (mostly) inside [start, start + seconds]: index + review stage."""
    out = []
    for i, p in enumerate(info["packages"]):
        a, b = max(p["start"], start), min(p["end"], start + seconds)
        if b - a >= 0.5 * (p["end"] - p["start"]):
            out.append({"index": i, "start": p["start"], "end": p["end"], "stage": review.stage(p)})
    return out


def _kind(seconds, dur, other_dur):
    """identical: the whole of both; part_of: the whole of this one is inside the other; overlap: some of both"""
    whole, whole_other = seconds >= 0.85 * dur - 1, seconds >= 0.85 * other_dur - 1
    return "identical" if whole and whole_other else "part_of" if whole else "contains" if whole_other else "overlap"


def _describe(audio_id, hits):
    """Matches of one audio for the upload answer: [{id, name, task, kind, seconds, start, ref_start}]"""
    if not hits:
        return []
    info = _infos([audio_id] + [h["key"] for h in hits])
    me = info.get(audio_id)
    out = []
    for h in hits:
        o = info.get(h["key"])
        if o and me:
            out.append({"id": o["id"], "name": o["name"], "task_id": o["task_id"], "task": o["task"],
                        "kind": _kind(h["seconds"], me["duration"], o["duration"]),
                        "seconds": h["seconds"], "start": h["start"], "ref_start": h["ref_start"]})
    return out


def _ignored():
    with db.transaction() as s:
        return {(r.a, r.b) for r in s.scalars(select(DuplicateIgnore))}


def _key(a, b):
    return (a, b) if a < b else (b, a)


def report():
    """Every pair of audio that share speech: [{duplicate, original, kind, seconds, ...}], the longest first.
    The duplicate is the newer one; its packages inside the shared part are listed with their review stage."""
    with _lock:
        _ensure_loaded()
        if _pairs["version"] != _version[0]:
            found = {}
            for a, fp in _index.fps.items():
                for h in _index.search(fp, skip={a}):
                    k = _key(a, h["key"])
                    if k not in found or h["seconds"] > found[k]["seconds"]:
                        found[k] = {"a": a, **h}
            _pairs.update(version=_version[0], found=found)
        found = dict(_pairs["found"])
    ignored = _ignored()
    found = {k: v for k, v in found.items() if k not in ignored}
    info = _infos({x for k in found for x in k})
    pairs = []
    for (x, y), h in found.items():
        if x not in info or y not in info:
            continue
        # h: audio h["a"] from h["start"] matches h["key"] from h["ref_start"]
        pos = {h["a"]: h["start"], h["key"]: h["ref_start"]}
        dup, orig = sorted((info[x], info[y]), key=lambda i: i["_order"], reverse=True)
        packages = _packages(dup, pos[dup["id"]], h["seconds"])
        pairs.append({
            "kind": _kind(h["seconds"], dup["duration"], orig["duration"]), "seconds": h["seconds"],
            "duplicate": {**{k: v for k, v in dup.items() if k not in ("packages", "_order")}, "start": pos[dup["id"]],
                          "packages": packages, "_order": dup["_order"]},
            "original": {**{k: v for k, v in orig.items() if k not in ("packages", "_order")}, "start": pos[orig["id"]],
                         "_order": orig["_order"]},
        })
    # one pair per copy: against its oldest original (the same recording three times is two copies, not three pairs)
    best = {}
    for p in pairs:
        d = p["duplicate"]["id"]
        if d not in best or p["original"]["_order"] < best[d]["original"]["_order"]:
            best[d] = {**p, "also": best.get(d, {}).get("also", 0)}
        best[d]["also"] = sum(1 for q in pairs if q["duplicate"]["id"] == d) - 1
    pairs = sorted(best.values(), key=lambda p: (-p["seconds"], p["duplicate"]["_order"]))
    for p in pairs:
        p["duplicate"].pop("_order"); p["original"].pop("_order")
    return pairs


def of_audio(ids):
    """{audio id: its match as in the upload answer} for the given audio that are copies (newer side of a pair)."""
    out = {}
    for p in report():
        d, o = p["duplicate"], p["original"]
        if d["id"] in ids:
            out[d["id"]] = [{"id": o["id"], "name": o["name"], "task_id": o["task_id"], "task": o["task"], "kind": p["kind"],
                             "seconds": p["seconds"], "start": d["start"], "ref_start": o["start"]}]
    return out


def summary():
    """For the dashboard: pairs and duplicate speech still to annotate (packages not skipped or accepted)."""
    pairs, todo = report(), 0
    for p in pairs:
        todo += sum(1 for k in p["duplicate"]["packages"] if k["stage"] not in ("skipped", "accepted"))
    return {"pairs": len(pairs), "packages_open": todo, "seconds": round(sum(p["seconds"] for p in pairs), 1)}


# ---------- actions ----------
def ignore(a, b, user):
    with db.transaction() as s:
        x, y = _key(a, b)
        if not s.get(DuplicateIgnore, (x, y)):
            s.add(DuplicateIgnore(a=x, b=y, by=user, at=now()))


def skip_packages(audio_id, indexes, original, user):
    """Leave the given packages of a duplicate out (skipped), with a note pointing to the original. Accepted
    packages are kept (they are done). Returns how many were skipped."""
    stamp = now()

    def change(segs):
        nonlocal skipped
        for i in indexes:
            if 0 <= i < len(segs) and review.stage(segs[i]) not in ("accepted", "skipped"):
                segs[i]["deleted"] = True
                segs[i]["duplicate_of"] = {"audio": original, "by": user, "at": stamp}
                skipped += 1
        return segs

    skipped = 0
    audios.update_segments(audio_id, change)
    return skipped
