"""Dataset download: one audio (from the editor) or a whole task (from the saved segments)."""
from flask import Blueprint, current_app, request, send_file

from ..services import audio, audios, exporter, tasks

bp = Blueprint("export", __name__, url_prefix="/api")


def _zip_response(buf, name):
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=f"{name}.zip")


@bp.post("/audios/<audio_id>/export")
def export_audio(audio_id):
    """Body: {name, segments: [{start, end, role, text, normalized}]} -> <name>.zip."""
    data = request.get_json(force=True) or {}
    cfg = current_app.config
    pcm = audio.load_pcm(audios.wav_path(audio_id))
    name = exporter.safe_name(data.get("name"), f"asr_{audio_id}")
    return _zip_response(exporter.build_zip(pcm, cfg["SAMPLE_RATE"], name, data.get("segments", []),
                                            cfg["MIN_EXPORT_SECONDS"]), name)


@bp.get("/tasks/<task_id>/export")
def export_task(task_id):
    """<task>.zip with a folder per audio, built from the autosaved segments."""
    cfg = current_app.config
    task = tasks.get(task_id)
    name = exporter.safe_name(task["name"], f"task_{task_id}")
    items = ((n, audio.load_pcm(audios.wav_path(a["id"])), exporter.from_saved(audios.get_segments(a["id"]), n))
             for a in task["audios"] for n in [exporter.safe_name(a["name"], a["id"])])
    return _zip_response(exporter.build_task_zip(name, items, cfg["SAMPLE_RATE"], cfg["MIN_EXPORT_SECONDS"]), name)
