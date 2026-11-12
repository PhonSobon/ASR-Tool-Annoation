"""The Project Dashboard (administrators and project managers): GET /api/dashboard?days=14."""
from flask import Blueprint, jsonify, request

from ...auth.guard import require
from .. import dashboard

bp = Blueprint("dashboard", __name__, url_prefix="/api/dashboard")


@bp.get("")
@require("task.manage")
def overview():
    """?days=14 (1-90: the period of the daily chart) -> tasks and their pull status, packages per review stage,
    hours, quality, daily throughput, what needs attention, team and dataset cleaning (see dashboard.py)."""
    return jsonify(dashboard.overview(request.args.get("days", 14, type=int)))
