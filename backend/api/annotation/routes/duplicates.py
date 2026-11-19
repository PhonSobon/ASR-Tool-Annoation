"""Duplicate audio across tasks (managers): the report, a scan for audio from before fingerprints, and the actions."""
from flask import Blueprint, jsonify, request

from ...auth import guard
from ...auth.guard import require
from ...core import jobs
from .. import audios, duplicates

bp = Blueprint("duplicates", __name__, url_prefix="/api/duplicates")


@bp.get("")
@require("task.manage")
def report():
    """{pairs: [...], missing: audio without a fingerprint yet, job: the running scan or null}.
    Audio without a fingerprint starts the scan by itself; the report is complete when `missing` is 0."""
    missing = duplicates.missing()
    if missing and not jobs.running(duplicates.JOB_KEY):
        duplicates.start_scan()
    return jsonify(pairs=duplicates.report(), missing=len(missing), job=jobs.get(duplicates.JOB_KEY))


@bp.get("/summary")
@require("task.manage")
def summary():
    return jsonify(duplicates.summary())


@bp.post("/ignore")
@require("task.manage")
def ignore():
    """{a, b}: these two audio are not duplicates (they stay out of the report)."""
    data = request.get_json(force=True) or {}
    a, b = str(data.get("a") or ""), str(data.get("b") or "")
    if not a or not b or a == b:
        return jsonify(error="Give the two audio ids (a, b)"), 400
    duplicates.ignore(a, b, guard.current_user()["username"])
    return jsonify(ok=True)


@bp.post("/skip")
@require("task.manage")
def skip():
    """{audio, packages: [index...], original}: skip these packages of the duplicate audio (accepted ones stay)."""
    data = request.get_json(force=True) or {}
    audio_id, idx = str(data.get("audio") or ""), data.get("packages")
    if not audio_id or not isinstance(idx, list) or not all(isinstance(i, int) for i in idx):
        return jsonify(error="Give the audio id and the package indexes"), 400
    if not audios.get_meta(audio_id)["task_id"]:
        return jsonify(error="This audio is not in a task - delete it instead"), 400
    n = duplicates.skip_packages(audio_id, idx, str(data.get("original") or ""), guard.current_user()["username"])
    return jsonify(skipped=n)
