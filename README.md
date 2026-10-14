# Khmer ASR Annotation Tool

A local web tool for building Khmer speech datasets. Upload several recordings, cut each one into crops on its waveform and fix the cuts, push the ones that are ready to a task, then go through the task crop by crop: listen, recognize automatically, fix the text, and export WAV files plus a `metadata.json`.

## Features

- **Upload & Crop:** drop or pick several audio/video files at once (upload progress per file). Each file is listed with a waveform thumbnail, its duration and whether it is cut yet; click one to open its waveform.
- **Cut length:** quick 10 s / 20 s / 30 s buttons or any number of seconds; cut the selected audio or all audio at once, then fix the wrong cuts on the waveform. This page shows only the waveform and cut tools, no text.
- **Choose what to push:** every audio has a checkbox, ticked automatically once it is cut (tick/untick by hand, or *all · cut only · none*). Only ticked audio go to the task; the rest stay on Upload & Crop for later.
- **Push to task:** the ticked audio become one task (a batch). **My Tasks** shows a card per task with audio count, duration, crops, to do / done and dates.
- **Task Batch List:** opening a task lists its packages (one per crop, named like `audio1_0003`) in **Todo / Processed** tabs, with search and annotator filter, Duration Stats, annotator / update time per package, **Claim Package** (next Todo), **Recognize all** and **Export task ZIP**.
- **Package page:** the crop in the same waveform editor (cut it into dialogue segments, one per speaker turn), the **Dialogue Segments** table (role, annotation text, normalized text, ▶ / ↻ recognize / 🗑 per segment), **Role Information** (age group, gender, native speaker per role) and **Overall Audio Information** (language, accent, domain, speech style, overlap, background sound, special challenges, code switching — pre-filled from the previous package). Missing required fields are listed at the bottom; **Annotation Specification** shows the guidelines; ‹ › and **Next package →** move on.
- **Autosave:** every cut and every text change is saved on the server, so you can close the browser and continue later.
- **One timeline for the whole recording:** a waveform with a time ruler, every segment shaded and numbered, the selected segment in blue, and the playhead with its time. Controls underneath: time, previous/next segment, play/pause, undo/redo, playback speed, timeline zoom and waveform height.
- **Cutting:** drag across the waveform to crop that range into its own crop, or select a crop and cut at the playhead (**S**). Drag a boundary to move it, double-click it to merge two crops, **Del** to leave one out.
- **Normalized text:** generated automatically from the annotation text (Khmer word segmentation with [khmercut](https://github.com/seanghay/khmercut), Khmer digits → 0-9, zero-width spaces removed). Edit it by hand any time; **↺ Auto-normalize** regenerates it.
- **Local Khmer recognition:** [Darayut/Omnilingual-ASR-Khm](https://huggingface.co/Darayut/Omnilingual-ASR-Khm) runs on your own GPU or CPU, with no API key and no internet once the model is downloaded. There are no engine, language or model settings to choose.
- **Safe editing:** progress counts (done / to do / errors / deleted, exported duration), a warning before you close the tab while changes are still being saved, hand-edited text is never overwritten by **Recognize all**, and the page doesn't jump while you type.
- **Export:** a ZIP containing one folder, named after the uploaded file, with `wavs/` and a single `metadata.json` (see [Export format](#export-format)).

## Setup

Requirements: Python 3.10+ and [FFmpeg](https://ffmpeg.org/) on your `PATH` (used by pydub to read audio). An NVIDIA GPU is optional but much faster.

```bash
pip install -r requirements.txt
```

For GPU support, install the CUDA build of PyTorch from [pytorch.org](https://pytorch.org/get-started/locally/).

### Model weights

The model weights (`model.safetensors`, 1.28 GB) are too large for GitHub and are not in this repo. You can either:

- **Download them once into the project folder** (recommended, works offline afterwards):

  ```bash
  python -c "from huggingface_hub import snapshot_download; snapshot_download('Darayut/Omnilingual-ASR-Khm', local_dir='models/Omnilingual-ASR-Khm')"
  ```

- **Do nothing.** If `models/Omnilingual-ASR-Khm/model.safetensors` is missing, the app downloads the model from Hugging Face the first time you transcribe.

To use a different copy, set the `OMNI_ASR_MODEL` environment variable to a Hugging Face repo id or a local folder containing `model.safetensors`, `config.json` and `vocab.json`.

## Usage

```bash
python app.py
```

Open http://127.0.0.1:5000, then:

1. **Upload & Crop:** drop or choose one or more audio files.
2. Click an audio, pick a cut length and click **✂ Cut selected audio** (or **✂ Cut all audio**).
3. Fix its cuts on the waveform (drag to crop, drag a line to move it, double-click to merge, **Del** to leave a crop out).
4. Check the boxes of the audio that are ready (cut audio are ticked automatically), enter a task name and click **Push N selected audio to task →**. The other audio stay on Upload & Crop.
5. **My Tasks:** click the task card. Click **Crop 1**, listen, press **↻ Recognize** (or **▶ Recognize all crops** once), fix the text, then **Next crop →**.
6. Click **⬇ Export task ZIP**.

### Cut editor controls (Upload & Crop)

| Action | How |
|---|---|
| Crop a range into one segment | Drag across the waveform |
| Select a crop / move playhead | Click the waveform; ↑ / ↓ or ⏮ / ⏭ for previous / next crop |
| Step the playhead | ← / → (Shift for 1 s steps) |
| Play / pause | **Space** or ▶ |
| Cut the selected crop | **S** or ✂ Cut at playhead |
| Move a boundary | Drag the dark line (snaps to word gaps; hold Alt to place freely) |
| Merge two crops | Double-click the line between them |
| Undo / redo | **Ctrl+Z** / **Ctrl+Y**, or ↶ / ↷ |
| Zoom | Timeline zoom slider, or Ctrl + mouse wheel |
| Leave a crop out | **Del** (again to restore) |

On the task page: **Ctrl+Enter** play / pause the crop, **Ctrl+↓** / **Ctrl+↑** next / previous crop, click the crop's waveform to play from there.

### Export format

**⬇ Export task ZIP** downloads `<task name>/` with one folder like this per audio (skipped packages and segments are left out). A package cut into dialogue segments gives one clip per segment (`<audio>_0003_01`, `_02`, …), and each entry also carries `speaker` (age group, gender, native speaker) and `audio_info` when they are filled in:

```
<audio name>/
├── wavs/
│   ├── <audio name>_0001.wav
│   ├── <audio name>_0002.wav
│   └── ...
└── metadata.json
```

`metadata.json` is a UTF-8 list with one entry per segment (deleted segments are left out). `start`/`end` are seconds in the original recording:

```json
[
  {
    "id": "news_0001",
    "file": "wavs/news_0001.wav",
    "start": 0.0,
    "end": 8.0,
    "duration": 8.0,
    "role": "Narrator",
    "text": "សូមគោរពជូនលោកប្រធានការិយាល័យ ១២",
    "text_normalized": "សូម គោរព ជូន លោក ប្រធាន ការិយាល័យ 12"
  }
]
```

## Project layout

```
app.py                      Entry point: `python app.py` (or `flask run`)
backend/                    Flask backend (Python package)
├── __init__.py             create_app() - application factory
├── config.py               Settings: paths, sample rate, upload limit, model (env-overridable)
├── errors.py               JSON error responses ({"error": ...})
├── routes/                 HTTP layer, one blueprint per feature
│   ├── pages.py            GET /  (web UI)
│   ├── audios.py           /api/audios: list, upload, open, autosave, cut length, delete
│   ├── media.py            /api/audios/<id>/audio, /peaks
│   ├── tasks.py            /api/tasks: push to task, list, open, delete
│   ├── asr.py              /api/audios/<id>/transcribe, /api/text/normalize
│   └── export.py           /api/audios/<id>/export, /api/tasks/<id>/export
├── services/               Logic, independent of HTTP
│   ├── audios.py           Audio folders: full.wav, meta.json (task_id), state.json
│   ├── tasks.py            Tasks: a named batch of audio (data/tasks/<id>.json)
│   ├── audio.py            Convert uploads, cut PCM, waveform peaks, WAV encoding
│   ├── recognizer.py       Loads the ASR model once, one inference at a time
│   ├── text.py             Khmer normalization (khmercut, digits)
│   └── exporter.py         Dataset ZIP: wavs/ + metadata.json (one audio or a whole task)
└── asr/omni_asr.py         Omnilingual-ASR-Khm in plain PyTorch + CTC word timings
frontend/                   Web UI (served by Flask, no build step)
├── templates/
│   ├── base.html           Page shell: head, header, sidebar, breadcrumb
│   ├── index.html          Puts the pages and scripts together
│   ├── partials/           header, sidebar, breadcrumb, editor (cut editor of Upload & Crop)
│   └── pages/              tasks.html (My Tasks), upload.html (Upload & Crop), task.html (crops of one task)
└── static/
    ├── css/                base, layout, tasks, audio-list, editor, crops, package
    └── js/                 Loaded in this order (they share top-level variables):
                            api, format, state, autosave, session (open audio), waveform, editor,
                            audio-list, upload (Upload & Crop), tasks (My Tasks), crops (Task Batch List),
                            package (package page), router, main
tests/                      pytest API tests (temporary data folder, ASR mocked)
models/Omnilingual-ASR-Khm/ config.json, vocab.json (weights downloaded separately)
data/sessions/              One folder per uploaded audio (created at runtime, not in git)
data/tasks/                 One JSON file per task
```

### API

| Method | URL | Purpose |
|---|---|---|
| GET | `/api/audios` | Audio still in Upload & Crop (`?task=<id>`: the audio of a task) |
| POST | `/api/audios` | Upload one audio file (`multipart`: `audio`) |
| GET / DELETE | `/api/audios/<id>` | Open an audio with its segments / delete it |
| PUT | `/api/audios/<id>/state` | Autosave segments |
| POST | `/api/audios/<id>/recut` | Cut into fixed-length segments `{chunk_seconds}` |
| GET | `/api/audios/<id>/audio`, `/peaks` | Audio for the player / waveform (`?buckets=n` for a thumbnail) |
| POST | `/api/audios/<id>/transcribe` | Recognize one segment `{start, end}` |
| POST | `/api/audios/<id>/export` | Download one audio's dataset ZIP (API only) |
| GET | `/api/tasks` | List tasks (My Tasks) |
| POST | `/api/tasks` | Push audio into a new task `{name, audio_ids}` |
| GET / DELETE | `/api/tasks/<id>` | Open a task with its audio and their crops / delete it (and its audio) |
| GET | `/api/tasks/<id>/export` | Download the whole task as one ZIP |
| POST | `/api/text/normalize` | Normalized text for `{text}` |

### Configuration

| Variable | Default |
|---|---|
| `OMNI_ASR_MODEL` | `models/Omnilingual-ASR-Khm` if the weights are there, else the Hugging Face repo |
| `ASR_DATA_DIR` | `data/` |
| `ANNOTATOR_NAME` | the computer's user name (saved as Annotator on the packages you edit) |
| `HOST` / `PORT` | `127.0.0.1` / `5000` |
| `FLASK_DEBUG` | `1` (set `0` to turn off the debugger) |

### Tests

```bash
pip install -r requirements-dev.txt
python -m pytest
```

## About the model

[Darayut/Omnilingual-ASR-Khm](https://huggingface.co/Darayut/Omnilingual-ASR-Khm) is a 0.3B-parameter Khmer CTC model:

- **Encoder:** Meta's Omnilingual ASR 300M (wav2vec 2.0) encoder.
- **Vocabulary:** 2,233 Khmer grapheme clusters, such as `ភ្ញី` as one unit.
- **Self-conditioned CTC:** intermediate predictions at layers 8 and 16 are fed back into the encoder.
- **Training:** fine-tuned on Khmer speech, then on Khmer-English code-switching data.

Results reported on the model card:

| Split | CER | WER |
|---|---|---|
| val | 2.24% | 7.62% |
| test_fleurs | 12.03% | 25.66% |
| test_slr42 | 14.82% | 48.62% |

The official inference code depends on [fairseq2](https://github.com/facebookresearch/fairseq2), which has no native Windows build. `backend/asr/omni_asr.py` re-implements the same architecture in plain PyTorch, following the [model's source repository](https://github.com/NDarayut/Omnilingual-ASR-Khm). It loads the published weights with a strict check, so every tensor in the checkpoint must match.

## References

### Models and code
- **Omnilingual-ASR-Khm** (model used by this tool): https://huggingface.co/Darayut/Omnilingual-ASR-Khm (MIT license)
- **Omnilingual-ASR-Khm source code** (training, tokenizer, reference inference): https://github.com/NDarayut/Omnilingual-ASR-Khm
- **Meta Omnilingual ASR** (base encoder `omniASR_CTC_300M`): https://github.com/facebookresearch/omnilingual-asr
- **fairseq2** (Meta's sequence modeling toolkit the original model is built on): https://github.com/facebookresearch/fairseq2
- **khmercut** (Khmer word segmentation, by Seanghay Yath): https://github.com/seanghay/khmercut

### Papers
- Baevski, A., Zhou, H., Mohamed, A., & Auli, M. (2020). *wav2vec 2.0: A Framework for Self-Supervised Learning of Speech Representations.* NeurIPS 2020. https://arxiv.org/abs/2006.11477
- Graves, A., Fernández, S., Gomez, F., & Schmidhuber, J. (2006). *Connectionist Temporal Classification: Labelling Unsegmented Sequence Data with Recurrent Neural Networks.* ICML 2006.
- Nozaki, J., & Komatsu, T. (2021). *Relaxing the Conditional Independence Assumption of CTC-based ASR by Conditioning on Intermediate Predictions* (self-conditioned CTC). Interspeech 2021. https://arxiv.org/abs/2104.02724
- Meta AI Omnilingual ASR team (2025). *Omnilingual ASR: Open-Source Multilingual Speech Recognition for 1600+ Languages.* https://ai.meta.com/research/publications/omnilingual-asr-open-source-multilingual-speech-recognition-for-1600-languages/

### Libraries
[Flask](https://flask.palletsprojects.com/) · [khmercut](https://github.com/seanghay/khmercut) · [PyTorch](https://pytorch.org/) · [safetensors](https://github.com/huggingface/safetensors) · [huggingface_hub](https://github.com/huggingface/huggingface_hub) · [pydub](https://github.com/jiaaro/pydub) · [NumPy](https://numpy.org/) · [Requests](https://requests.readthedocs.io/) · [Noto Sans Khmer](https://fonts.google.com/noto/specimen/Noto+Sans+Khmer)

## Acknowledgements

Thanks to **Darayut** for training and publishing the Khmer model and its source code, and to **Meta AI** for releasing the Omnilingual ASR encoder.
