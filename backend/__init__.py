"""Khmer ASR annotation tool - Flask backend.

Upload audio, split it into segments on one timeline, transcribe each segment with the
local Omnilingual-ASR-Khm model, review and export a WAV + metadata.json dataset.
"""
import os

from flask import Flask

from .config import BASE_DIR, Config
from .errors import register_error_handlers
from .routes import register_blueprints

FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")


def create_app(config=None):
    """Application factory: `config` (a dict) overrides values from Config, e.g. in tests."""
    app = Flask(__name__,
                template_folder=os.path.join(FRONTEND_DIR, "templates"),
                static_folder=os.path.join(FRONTEND_DIR, "static"))
    app.config.from_object(Config)
    if config:
        app.config.update(config)
    for key in ("AUDIO_DIR", "TASKS_DIR"):
        os.makedirs(app.config[key], exist_ok=True)

    register_blueprints(app)
    register_error_handlers(app)
    return app
