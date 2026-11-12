"""Dataset download: one audio (from the editor) or a whole task (from the saved segments)."""
import io

from flask import Blueprint, current_app, request, send_file

from ...auth.guard import require
from ...core import audio, exporter
from .. import access, audios, tasks

bp = Blueprint("export", __name__, url_prefix="/api")


def _zip_response(buf, name):
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=f"{name}.zip")


@bp.get("/audios/<audio_id>/download")
@require("data.export")
def download_audio(audio_id):
    """?start=&end= (seconds, optional) &name= -> <name>.wav: one package of the audio, or the whole audio."""
    access.audio(audio_id)
    sr = current_app.config["SAMPLE_RATE"]
    pcm = audio.load_pcm(audios.wav_path(audio_id))
    start, end = request.args.get("start", type=float), request.args.get("end", type=float)
    if start is not None or end is not None:
        pcm = audio.clip(pcm, start or 0, end if end is not None else len(pcm) / sr, sr)
    name = exporter.safe_name(request.args.get("name"), f"audio_{audio_id}")
    return send_file(io.BytesIO(audio.wav_bytes(pcm, sr)), mimetype="audio/wav", as_attachment=True,
                     download_name=f"{name}.wav")


@bp.post("/audios/<audio_id>/export")
@require("data.export")
def export_audio(audio_id):
    """Body: {name, segments: [{start, end, role, text, normalized}]} -> <name>.zip."""
    access.audio(audio_id)
    data = request.get_json(force=True) or {}
    cfg = current_app.config
    pcm = audio.load_pcm(audios.wav_path(audio_id))
    name = exporter.safe_name(data.get("name"), f"asr_{audio_id}")
    return _zip_response(exporter.build_zip(pcm, cfg["SAMPLE_RATE"], name, data.get("segments", []),
                                            cfg["MIN_EXPORT_SECONDS"]), name)


@bp.get("/tasks/<task_id>/export")
@require("data.export")
def export_task(task_id):
    """<task>.zip with a folder per audio, built from the autosaved segments."""
    access.task(task_id)
    cfg = current_app.config
    task = tasks.get(task_id)
    name = exporter.safe_name(task["name"], f"task_{task_id}")
    items = ((n, audio.load_pcm(audios.wav_path(a["id"])), exporter.from_saved(audios.get_segments(a["id"]), n))
             for a in task["audios"] for n in [exporter.safe_name(a["name"], a["id"])])
    return _zip_response(exporter.build_task_zip(name, items, cfg["SAMPLE_RATE"], cfg["MIN_EXPORT_SECONDS"]), name)
