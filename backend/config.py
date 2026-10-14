"""App settings. Every path can be overridden with an environment variable."""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # project root

OMNI_REPO = "Darayut/Omnilingual-ASR-Khm"
OMNI_LOCAL_DIR = os.path.join(BASE_DIR, "models", "Omnilingual-ASR-Khm")  # model.safetensors + config.json + vocab.json


def _default_model():
    """Prefer the project's own copy; fall back to downloading from Hugging Face if it is missing."""
    if os.path.isfile(os.path.join(OMNI_LOCAL_DIR, "model.safetensors")):
        return OMNI_LOCAL_DIR
    return OMNI_REPO


class Config:
    DATA_DIR = os.environ.get("ASR_DATA_DIR", os.path.join(BASE_DIR, "data"))
    # one folder per uploaded audio: full.wav, meta.json, state.json ("sessions" = name used by earlier versions)
    AUDIO_DIR = os.path.join(DATA_DIR, "sessions")
    TASKS_DIR = os.path.join(DATA_DIR, "tasks")  # one <task_id>.json per task
    OMNI_ASR_MODEL = os.environ.get("OMNI_ASR_MODEL") or _default_model()
    ANNOTATOR_NAME = os.environ.get("ANNOTATOR_NAME", "")  # empty = the computer's user name

    SAMPLE_RATE = 16000
    PEAK_RATE = 200            # waveform min/max pairs per second sent to the browser
    DEFAULT_CHUNK_SECONDS = 30
    MIN_EXPORT_SECONDS = 0.1   # shorter segments are left out of the export

    MAX_CONTENT_LENGTH = 1024 * 1024 * 1024  # 1 GB upload limit
    JSON_AS_ASCII = False
    SEND_FILE_MAX_AGE_DEFAULT = 0  # always serve the latest CSS/JS while developing
