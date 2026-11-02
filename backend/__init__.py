"""Khmer ASR annotation tool - Flask backend (JSON API; the web UI is the Next.js app in frontend/).

Upload audio, split it into segments on one timeline, transcribe each segment with the local Omnilingual-ASR-Khm
model, have the packages checked (inspection, acceptance), and export a WAV + metadata.json dataset. Imported Hugging
Face datasets are cleaned the same way. Every feature is a package with its logic and its routes:

    core/        storage, audio, text, background jobs, Hugging Face Hub, ZIP export
    auth/        users, roles and permissions, login
    asr/         the model and the recognition routes
    annotation/  Upload & Crop, tasks, packages and their review
    cleaning/    Hugging Face dataset cleaning
"""
import os
import secrets

from flask import Flask

from .config import Config
from .errors import register_error_handlers


def create_app(config=None):
    """Application factory: `config` (a dict) overrides values from Config, e.g. in tests."""
    app = Flask(__name__, static_folder=None)   # API only: the web UI is the Next.js app in frontend/
    app.config.from_object(Config)
    if config:
        app.config.update(config)
    for key in ("AUDIO_DIR", "DATASETS_DIR"):
        os.makedirs(app.config[key], exist_ok=True)
    if not app.config.get("SECRET_KEY"):
        app.config["SECRET_KEY"] = _secret_key(app.config["SECRET_KEY_FILE"])

    from .core import db, legacy
    db.init_app(app)
    app.cli.add_command(legacy.import_json)
    _register_blueprints(app)
    register_error_handlers(app)
    with app.app_context():
        _first_admin(app)
    return app


def _secret_key(path):
    """The key that signs the session cookies, made once (so a restart keeps everyone logged in)."""
    try:
        with open(path, encoding="utf-8") as f:
            if key := f.read().strip():
                return key
    except OSError:
        pass
    key = secrets.token_hex(32)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(key)
    return key


def _first_admin(app):
    """The administrator of .env (ADMIN_USERNAME, default "admin" / ADMIN_PASSWORD): made, or kept in step with .env."""
    from .auth import users

    name, password = app.config.get("ADMIN_USERNAME") or "admin", app.config.get("ADMIN_PASSWORD")
    if password:
        try:
            users.ensure_admin(name, password)
        except ValueError as e:
            raise SystemExit(f"ADMIN_PASSWORD in .env is not accepted: {e}. Change it in .env and start again.")


def _register_blueprints(app):
    from . import pages
    from .annotation.routes import audios, export, media, tasks
    from .asr import routes as asr
    from .auth import activity, guard, routes as auth
    from .cleaning import routes as cleaning

    app.before_request(guard.check_api_login)
    app.after_request(activity.record)
    for bp in (pages.bp, auth.bp, audios.bp, media.bp, tasks.bp, asr.bp, export.bp, cleaning.bp):
        app.register_blueprint(bp)
