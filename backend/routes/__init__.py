"""HTTP layer. Each module is one Flask blueprint; the logic lives in backend.services.

    GET    /                                  web UI
    GET    /api/audios[?task=<id>]            audio in Upload & Crop (or of one task)
    POST   /api/audios                        upload one audio file
    GET    /api/audios/<id>                   audio + segments
    DELETE /api/audios/<id>                   delete audio
    PUT    /api/audios/<id>/state             autosave segments
    POST   /api/audios/<id>/recut             cut into fixed-length segments
    GET    /api/audios/<id>/audio             full 16 kHz WAV
    GET    /api/audios/<id>/peaks[?buckets=n] waveform overview / thumbnail
    POST   /api/audios/<id>/transcribe        recognize one segment
    POST   /api/audios/<id>/export            download one audio's dataset ZIP
    GET    /api/tasks                         list tasks (My Tasks)
    POST   /api/tasks                         push audio into a new task
    GET    /api/tasks/<id>                    task + its audio and their crops (segments)
    DELETE /api/tasks/<id>                    delete task and its audio
    GET    /api/tasks/<id>/export             download the whole task as one ZIP
    POST   /api/text/normalize                normalized text
    GET    /api/me                            annotator name (ANNOTATOR_NAME or the computer user)
"""
from .asr import bp as asr_bp
from .audios import bp as audios_bp
from .export import bp as export_bp
from .media import bp as media_bp
from .pages import bp as pages_bp
from .tasks import bp as tasks_bp


def register_blueprints(app):
    for bp in (pages_bp, audios_bp, media_bp, tasks_bp, asr_bp, export_bp):
        app.register_blueprint(bp)
