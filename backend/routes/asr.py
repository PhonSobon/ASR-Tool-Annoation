"""Speech recognition and text normalization."""
import numpy as np
from flask import Blueprint, current_app, jsonify, request

from ..services import audio, audios, recognizer
from ..services.text import normalize_text

bp = Blueprint("asr", __name__, url_prefix="/api")


@bp.post("/audios/<audio_id>/transcribe")
def transcribe(audio_id):
    """Transcribe ONE segment {start, end} of an audio. Word times in the reply are absolute."""
    data = request.get_json(force=True) or {}
    sr = current_app.config["SAMPLE_RATE"]
    pcm = audio.load_pcm(audios.wav_path(audio_id))
    start = float(data.get("start", 0))
    clip = audio.clip(pcm, start, data.get("end", 0), sr).astype(np.float32) / 32768
    try:
        res = recognizer.recognize(clip, current_app.config["OMNI_ASR_MODEL"])
    except (OSError, ImportError) as e:  # missing model files / bad repo id / missing torch
        return jsonify(error=f"Omni-ASR: {e}", fatal=True), 500
    except Exception as e:
        current_app.logger.exception("Omni-ASR failed")
        return jsonify(error=f"Omni-ASR: {e}"), 500
    for w in res["words"]:
        w["start"] = round(w["start"] + start, 3)
        w["end"] = round(w["end"] + start, 3)
    return jsonify(**res)


@bp.post("/text/normalize")
def normalize():
    """Normalized text for one segment (the Normalized Text column)."""
    return jsonify(normalized=normalize_text((request.get_json(force=True) or {}).get("text") or ""))
