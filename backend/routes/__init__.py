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
    POST   /api/tasks/<id>/hub-push           push the task's annotated segments to a Hub dataset repo (background job)
    GET    /api/tasks/<id>/job                progress of that push
    POST   /api/tasks/<id>/stop               stop it
    POST   /api/text/normalize                normalized text
    GET    /api/me                            annotator name (ANNOTATOR_NAME or the computer user)

    Dataset cleaning (Hugging Face datasets):
    POST   /api/hub/inspect                   configs, splits and columns of a Hub dataset
    POST   /api/hub/whoami                    Hugging Face user name of the token / saved login
    GET    /api/datasets                      imported datasets
    POST   /api/datasets                      import a split (background job)
    GET    /api/datasets/<id>                 dataset + every clip (text, ASR text, CER, flags, status)
    DELETE /api/datasets/<id>                 delete dataset
    GET    /api/datasets/<id>/job             progress of the import / check / push job
    POST   /api/datasets/<id>/stop            stop that job
    GET    /api/datasets/<id>/clips/<n>       one clip as WAV
    PATCH  /api/datasets/<id>/items/<n>       review one clip: text, normalized text, status, reason, trim
    POST   /api/datasets/<id>/items/<n>/split cut one clip in two parts
    POST   /api/datasets/<id>/items/<n>/join  join a part with the next part of its row
    POST   /api/datasets/<id>/items/<n>/recognize  check one clip with the ASR now
    POST   /api/datasets/<id>/accept-passing  accept every clip that passed the checks
    POST   /api/datasets/<id>/check           run the ASR on every clip and score it (background job)
    GET    /api/datasets/<id>/export          download the cleaned clips as one ZIP
    POST   /api/datasets/<id>/push            push the cleaned clips to a Hub dataset repo (background job)
"""
from .asr import bp as asr_bp
from .audios import bp as audios_bp
from .datasets import bp as datasets_bp
from .export import bp as export_bp
from .media import bp as media_bp
from .pages import bp as pages_bp
from .tasks import bp as tasks_bp


def register_blueprints(app):
    for bp in (pages_bp, audios_bp, media_bp, tasks_bp, asr_bp, export_bp, datasets_bp):
        app.register_blueprint(bp)
