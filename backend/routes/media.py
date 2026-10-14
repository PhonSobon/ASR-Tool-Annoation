"""Audio for the player and the waveform."""
from flask import Blueprint, current_app, jsonify, request, send_file

from ..services import audio, audios

bp = Blueprint("media", __name__, url_prefix="/api/audios")


@bp.get("/<audio_id>/audio")
def full_audio(audio_id):
    return send_file(audios.wav_path(audio_id), mimetype="audio/wav", conditional=True)


@bp.get("/<audio_id>/peaks")
def peaks(audio_id):
    """Interleaved min/max int8 pairs, base64: PEAK_RATE per second, or ?buckets=<n> pairs in total (thumbnails)."""
    sr = current_app.config["SAMPLE_RATE"]
    pcm = audio.load_pcm(audios.wav_path(audio_id))
    buckets = request.args.get("buckets", type=int)
    per = -(-len(pcm) // max(1, min(buckets, 4000))) if buckets else sr // current_app.config["PEAK_RATE"]
    per = max(1, per)
    return jsonify(rate=sr / per, duration=len(pcm) / sr, peaks=audio.peaks(pcm, per))
