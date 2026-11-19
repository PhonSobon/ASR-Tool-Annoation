"""JSON error responses for the API ({"error": "..."} with the right status code)."""
from flask import jsonify
from werkzeug.exceptions import HTTPException

from .core.storage import NotFound


def register_error_handlers(app):
    @app.errorhandler(NotFound)  # missing audio, task, dataset or user
    def not_found(e):
        return jsonify(error=str(e) or "Not found"), 404

    @app.errorhandler(HTTPException)
    def http_error(e):
        return jsonify(error=e.description), e.code
