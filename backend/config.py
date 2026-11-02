"""App settings, from environment variables. A .env file in the project root is read first (see .env.example);
variables already set in the environment win over it."""
import os

from dotenv import load_dotenv

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # project root
load_dotenv(os.path.join(BASE_DIR, ".env"))

OMNI_REPO = "Darayut/Omnilingual-ASR-Khm"
OMNI_LOCAL_DIR = os.path.join(BASE_DIR, "models", "Omnilingual-ASR-Khm")  # model.safetensors + config.json + vocab.json


def _default_model():
    """Prefer the project's own copy; fall back to downloading from Hugging Face if it is missing."""
    if os.path.isfile(os.path.join(OMNI_LOCAL_DIR, "model.safetensors")):
        return OMNI_LOCAL_DIR
    return OMNI_REPO


def database_url(url, data_dir):
    """DATABASE_URL for SQLAlchemy: postgresql://... uses the psycopg 3 driver; empty = SQLite file in data_dir."""
    if not url:
        return "sqlite:///" + os.path.join(data_dir, "app.db").replace("\\", "/")
    for old in ("postgres://", "postgresql://"):
        if url.startswith(old):
            return "postgresql+psycopg://" + url[len(old):]
    return url


class Config:
    DATA_DIR = os.environ.get("ASR_DATA_DIR") or os.path.join(BASE_DIR, "data")
    # Users, tasks, segments and dataset reviews are in the database; audio files stay on disk below DATA_DIR.
    # PostgreSQL: postgresql://user:password@host:5432/dbname. Not set: a SQLite file data/app.db (one computer).
    DATABASE_URL = database_url(os.environ.get("DATABASE_URL"), DATA_DIR)
    AUDIO_DIR = os.path.join(DATA_DIR, "sessions")  # one folder per uploaded audio: full.wav
    DATASETS_DIR = os.path.join(DATA_DIR, "datasets")  # one folder per Hugging Face batch: clips/*.wav
    # where versions before the database kept their JSON files (flask import-json reads them)
    TASKS_DIR = os.path.join(DATA_DIR, "tasks")
    USERS_FILE = os.path.join(DATA_DIR, "users.json")
    OMNI_ASR_MODEL = os.environ.get("OMNI_ASR_MODEL") or _default_model()

    # Login: the session cookie is signed with SECRET_KEY (made once and kept in DATA_DIR/secret_key if not set).
    # ADMIN_USERNAME (default "admin") + ADMIN_PASSWORD: the administrator, made at start-up and kept in step with these
    # values (it cannot change its password in the app). It adds every other user; there is no sign-up.
    SECRET_KEY = os.environ.get("SECRET_KEY")
    WEB_URL = os.environ.get("WEB_URL")   # the Next.js app (e.g. http://127.0.0.1:3000): / of the API redirects there
    SECRET_KEY_FILE = os.path.join(DATA_DIR, "secret_key")
    ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME") or "admin"
    ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE", "0") == "1"   # 1 behind HTTPS
    PERMANENT_SESSION_LIFETIME = 7 * 24 * 3600

    SAMPLE_RATE = 16000
    PEAK_RATE = 200            # waveform min/max pairs per second sent to the browser
    DEFAULT_CHUNK_SECONDS = 30
    MIN_EXPORT_SECONDS = 0.1   # shorter segments are left out of the export

    # Dataset cleaning: a clip passes when the ASR's character error rate against its text is at most CER_PASS
    # (and nothing else looks wrong); above CER_BAD it is likely bad.
    CER_PASS = float(os.environ.get("CER_PASS") or 0.10)
    CER_BAD = float(os.environ.get("CER_BAD") or 0.50)
    MIN_CLIP_SECONDS = 0.5
    MAX_CLIP_SECONDS = 30
    SILENCE_SECONDS = 1.0      # longer silence at the start / end of a clip is flagged (and trimmed on export)

    MAX_CONTENT_LENGTH = 1024 * 1024 * 1024  # 1 GB upload limit
    JSON_AS_ASCII = False
    SEND_FILE_MAX_AGE_DEFAULT = 0  # always serve the latest CSS/JS while developing
