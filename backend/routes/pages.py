"""Web UI (a single page; the browser switches between My Tasks, Upload & Crop and the task pages) and who is using it."""
import getpass

from flask import Blueprint, current_app, jsonify, render_template

bp = Blueprint("pages", __name__)


@bp.get("/")
def index():
    return render_template("index.html")


@bp.get("/api/me")
def me():
    """The annotator's name, saved on the packages they edit: ANNOTATOR_NAME, else the computer's user name."""
    name = current_app.config["ANNOTATOR_NAME"]
    if not name:
        try:
            name = getpass.getuser()
        except Exception:
            name = ""
    return jsonify(name=name)
