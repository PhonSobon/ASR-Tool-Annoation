"""The backend serves only the API (/api/...). The web UI is the Next.js app in frontend/ (npm run dev -> port 3000),
which forwards /api to here. Opening the backend itself in a browser goes to the web app (WEB_URL) or says where."""
from flask import Blueprint, current_app, jsonify, redirect

bp = Blueprint("pages", __name__)


@bp.get("/")
def index():
    url = current_app.config.get("WEB_URL")
    if url:
        return redirect(url)
    return jsonify(service="Khmer Audio Annotation Tool API", web="Run the web app in frontend/ (npm run dev) and open it",
                   docs="docs/api.md")
