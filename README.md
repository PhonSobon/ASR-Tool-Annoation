# Khmer Audio Annotation Tool

An open-source web tool for building and cleaning **Khmer speech datasets** for automatic speech recognition (ASR). It runs on your own computer, transcribes Khmer speech with a local model (no API key, no cloud service), and exports training-ready data as WAV + JSON or straight to the [Hugging Face Hub](https://huggingface.co/datasets).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue)

It covers two jobs:

1. **Annotate your own recordings.** Upload long recordings, cut them into short clips on a waveform, let the model draft a transcript, fix it, add speaker and recording details, and export.
2. **Clean an existing Hugging Face dataset.** Import a Khmer speech dataset (even one with a million rows, in batches of a few hundred), let the model flag clips whose text does not match the audio, review them, and push the cleaned dataset back to the Hub.

## Features

**Team work**
- Log in with your own account. Roles: **Administrator**, **Project Manager**, **Annotator**, **Quality Inspector**, **Acceptor** and **Viewer**.
- Managers assign people to each task and dataset; everyone else sees only their own work.
- Every package is checked twice: the quality inspector passes it or returns it with a note, then the acceptor gives the final acceptance. The task page shows who annotated, inspected and accepted each package.

**Annotation**
- Upload many audio or video files at once; anything FFmpeg can read is converted to 16 kHz mono.
- Waveform cut editor: fixed-length cuts (10 / 20 / 30 s), drag to crop, move boundaries (snapping to pauses), merge, skip, undo / redo, zoom.
- Work is organised in **tasks** and **packages**, with Todo / Processed tabs, annotator tracking and duration statistics.
- Dialogue support: cut a package into speaker turns, with a role per segment, speaker details (age group, gender, native speaker) and recording details (accent, domain, speech style, background sound, code switching …).
- **Local Khmer ASR** drafts the text: [Darayut/Omnilingual-ASR-Khm](https://huggingface.co/Darayut/Omnilingual-ASR-Khm) runs on your GPU or CPU.
- **Normalized text** for training, made automatically: Khmer word segmentation with [khmercut](https://github.com/seanghay/khmercut), Khmer digits written 0-9, zero-width spaces removed. You can correct it by hand.
- Autosave: close the browser and continue later.

**Dataset cleaning**
- Import any Hugging Face audio dataset with a transcript column (public, private or gated).
- **Batches for big datasets:** each batch reads only its own rows from the Hub, so a million-row dataset never has to be downloaded in full.
  The Hub's own parquet copy of a split bigger than about 5 GB is only partial; the tool then reads the repo's parquet files instead, or warns which rows cannot be reached. Each batch remembers the dataset's commit, and the tool warns if the dataset changed between batches.
- Automatic checks: character error rate (CER) of the local ASR against the dataset text, plus audio and text problems (silence, clipping, duplicates, digits, Latin letters, speaking rate …). Each clip is marked *passed*, *needs review* or *likely bad*.
- Fast review: text and ASR output side by side with the differences highlighted, keyboard shortcuts, trim, cut a clip in two, join parts, reject with a reason.

**Output**
- ZIP with `wavs/` + `metadata.json`.
- Push to the Hugging Face Hub as parquet, to your own repo or as a pull request. **Many tasks or batches can be pushed to the same repo**: each one writes its own files, and the dataset card keeps a table of everything pushed.

## Quick start

The tool has two parts: a **Flask API** (Python, `backend/`) that stores everything in **PostgreSQL**, and a
**Next.js web app** (`frontend/`) that the browser opens.

**Requirements:** Python 3.10 or newer, [Node.js](https://nodejs.org/) 20 or newer, PostgreSQL 14 or newer (or
Docker), and [FFmpeg](https://ffmpeg.org/download.html) on your `PATH`. An NVIDIA GPU is optional but makes
recognition much faster.

**1. Settings.** Copy `.env.example` to `.env` and set the database password and a `SECRET_KEY`:

```bash
git clone https://github.com/PhonSobon/ASR-Tool-Annoation.git
cd ASR-Tool-Annoation
cp .env.example .env            # Windows PowerShell: Copy-Item .env.example .env
```

**2. PostgreSQL.** Either start the one in `docker-compose.yml` (it uses the `POSTGRES_*` values of `.env`):

```bash
docker compose up -d
```

or use your own server: create a database and a user, and put them in `DATABASE_URL`, for example
`postgresql://khmer_asr:secret@localhost:5432/khmer_asr`. The tables are created at the first start.

**3. The API** (port 5100):

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS / Linux: source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

**4. The web app** (port 3000), in a second terminal:

```bash
cd frontend
npm install
npm run dev                     # for a team: npm run build && npm start
```

Open **http://localhost:3000**. The first time, it asks you to create the administrator account.

**Coming from an earlier version** (data in JSON files in `data/`)? Copy it into the database once — users, tasks,
segments and dataset reviews; the audio files stay where they are:

```bash
flask --app app import-json
```

For GPU support, install the CUDA build of PyTorch from [pytorch.org](https://pytorch.org/get-started/locally/) before `pip install -r requirements.txt`.

### Model weights

The model weights (`model.safetensors`, 1.28 GB) are not stored in this repository. Either:

- **Do nothing:** the app downloads the model from Hugging Face the first time you transcribe, or
- **Download them once into the project** (works offline afterwards):

  ```bash
  python -c "from huggingface_hub import snapshot_download; snapshot_download('Darayut/Omnilingual-ASR-Khm', local_dir='models/Omnilingual-ASR-Khm')"
  ```

To use another copy, set `OMNI_ASR_MODEL` to a Hugging Face repo id or to a folder with `model.safetensors`, `config.json` and `vocab.json`.

## Users and roles

There is no sign-up: everyone signs in with an account the administrator made. The administrator comes from `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD` in `.env`; it is created at start-up and its password can only be changed there (then restart). The administrator adds the other users under **Administration → Users & Roles** with a **default password**; managers, annotators, inspectors, acceptors and viewers must choose their own password the first time they sign in. **Administration → Activity & Status** shows every user's status (online, never signed in, still on the default password, deactivated), who worked today and who did not, and the full activity log. **Administration → Work Dashboard** shows what each user produced in a period (all time, today, 7 / 30 days or chosen dates): hours annotated, packages completed and in progress, how many times their packages were returned (errors) and how many were accepted, the reviews they made, and the dataset clips they accepted or rejected. Every password must be **8 to 12 characters** with an upper-case letter, a lower-case letter, a number and a special character (such as `! @ # $ %`), no spaces, and must not contain the user name.

| Role | What it can do |
|---|---|
| **Administrator** | Everything, and manages users and roles |
| **Project Manager** | Upload & Crop, make tasks, import Hugging Face datasets, assign people, export ZIPs, push to the Hub; can also annotate, inspect and accept |
| **Annotator** | Annotates the packages of the tasks they are a member of; reviews the clips of the datasets they are assigned to |
| **Quality Inspector** | Checks completed packages: **passes** them or **returns** them to the annotator with a note; may fix the text |
| **Acceptor** | Final acceptance of the packages that passed inspection (or returns them) |
| **Viewer** | Sees every task and dataset, changes nothing |

Annotators, inspectors and acceptors see only the tasks and datasets a manager added them to (the **Members** button). Every package goes through:

```
Todo (annotator) --Complete--> Inspection --Pass--> Acceptance --Accept--> Done
        ^                          |                    |
        +------ Return + note -----+--------------------+
```

Nobody can inspect or accept a package they annotated themselves (except the administrator). A package that passed inspection can no longer be changed by its annotator. When you push a task to the Hub you choose **accepted** packages, packages that **passed inspection**, or all **completed** ones.

## How to use it

### Annotate your own recordings

1. **Upload & Crop:** add audio files, cut them (for example every 20 s) and fix the cuts on the waveform.
2. Tick the files that are ready and **push them to a task**. Open the task and press **Members** to choose its annotators, inspectors and acceptors.
3. **Annotators:** press **Recognize all** to draft every transcript, then go through the packages. Fix the text, split dialogue into speaker turns, fill in the speaker and recording details, and press **Complete**.
4. **Quality inspectors** open the **Inspection** tab: **Pass inspection**, or **Return to annotator** with a note. **Acceptors** do the same in the **Acceptance** tab.
5. **Export task ZIP**, or **Push to Hugging Face** (accepted packages).

### Clean a Hugging Face dataset

1. **Dataset Cleaning** (project manager): enter a dataset id such as `seanghay/khmer_mpwt_speech` and click **Load**.
2. Choose the split, the audio and text columns, and for a big dataset the **rows per batch** (for example 200) and how many batches to create.
3. The clips are imported and checked by the ASR. Open a batch and press **Members** to choose its reviewers. **Accept passing clips** in one click, then review the rest, worst first.
4. **Push to Hugging Face.** Every batch goes to the same repo and together they form one dataset.

The **[user guide](docs/user-guide.md)** explains every page, the quality checks, the output formats and all keyboard shortcuts.

## Output

A task ZIP holds one folder per recording with `wavs/` and a `metadata.json` like this:

```json
{
  "id": "news_0001",
  "file": "wavs/news_0001.wav",
  "start": 0.0, "end": 8.0, "duration": 8.0,
  "role": "Narrator",
  "text": "សូមគោរពជូនលោកប្រធានការិយាល័យ ១២",
  "text_normalized": "សូម គោរព ជូន លោក ប្រធាន ការិយាល័យ 12"
}
```

On the Hugging Face Hub, each task or batch is stored as `data/<split>-<task or rows>-*.parquet` with an `audio` column the dataset viewer can play. See [Output formats](docs/user-guide.md#output-formats) for every column.

## Configuration

Settings are environment variables, read from `.env` in the project root (see [.env.example](.env.example));
variables set in the real environment win over the file. `.env` is not committed.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | SQLite file `data/app.db` | The database: `postgresql://user:password@host:5432/dbname`. Without it a SQLite file is used (fine for one person trying the tool) |
| `OMNI_ASR_MODEL` | `models/Omnilingual-ASR-Khm` if the weights are there, else the Hugging Face repo | The ASR model |
| `ASR_DATA_DIR` | `data/` | Where the audio files and dataset clips are stored (everything else is in the database) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / (none, required) | The administrator: made at start-up and kept in step with these values (its password cannot be changed in the app) |
| `SECRET_KEY` | made once in `data/secret_key` | Signs the login cookies. Set the same value on every server behind a load balancer |
| `SESSION_COOKIE_SECURE` | `0` | `1` when the tool is served over HTTPS |
| `HF_TOKEN` | the login from `hf auth login` | Hugging Face token (a token typed in the app is used instead) |
| `CER_PASS` / `CER_BAD` | `0.10` / `0.50` | Dataset cleaning: CER limits for *passed* / *likely bad* |
| `HOST` / `PORT` | `127.0.0.1` / `5100` | Where the API listens |
| `WEB_URL` | (none) | The web app's address; opening the API's `/` in a browser goes there |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | | Used by `docker-compose.yml` to create the database container |

The web app has its own `frontend/.env.local` (see [frontend/.env.example](frontend/.env.example)): `API_URL`, where the Flask API
listens (default `http://127.0.0.1:5100`). The browser only talks to the web app, which forwards `/api/*` to Flask,
so the login cookie stays on one address.
| `FLASK_DEBUG` | `0` | `1` turns on the Flask debugger (only on your own computer) |

### Security

Every page and API call needs a login. Passwords are stored as salted hashes in the database; after 5 wrong passwords a user name has to wait a minute. Changing a password or deactivating a user logs them out everywhere.

To let a team use it, run the web app with `npm run build && npm start`, put it behind HTTPS (for example a reverse proxy such as nginx or Caddy) with `SESSION_COOKIE_SECURE=1`, and keep the Flask API on `127.0.0.1` so only the web app reaches it. Run the API as **one** process: background jobs (imports, checks, pushes) live in its memory. Never turn on `FLASK_DEBUG=1` when other people can reach the server: the debugger can run any code. Hugging Face tokens typed into the app are used for that request only and are not saved.

## Project structure

The code is organised by feature: each backend package holds its logic and its HTTP routes; the web app has one
page per screen and shared components.

```
app.py                      Entry point of the API (python app.py)
.env.example                Settings template (copy to .env)
docker-compose.yml          PostgreSQL in Docker
backend/                    Flask JSON API
├── __init__.py             create_app(): config, database, login check, blueprints
├── config.py               Settings (environment variables / .env)
├── pages.py                / of the API (points to the web app)
├── core/                   Shared: database (db.py: tables), JSON-import of old data (legacy.py), audio,
│                           text normalization, background jobs, Hugging Face Hub (parquet), ZIP export
├── auth/                   Users and roles
│   ├── roles.py            Roles and their permissions (change what a role may do here)
│   ├── users.py            Accounts (hashed passwords)
│   ├── guard.py            Logged-in user, permission checks, wrong-password limit
│   ├── activity.py         Activity log and user status
│   └── routes.py           /api/auth/* (sign in, password), /api/users and /api/activity (admin)
├── asr/                    Omnilingual-ASR-Khm in plain PyTorch, model loader, /transcribe
├── annotation/             Workflow 1: Upload & Crop, tasks, packages
│   ├── audios.py, tasks.py Audio and tasks, members, access
│   ├── review.py           Package review: annotating -> inspection -> acceptance
│   ├── access.py           Access checks shared by the routes
│   └── routes/             audios, media, tasks, export
└── cleaning/               Workflow 2: Hugging Face dataset cleaning
    ├── datasets.py         Imported batches, review, members
    ├── quality.py          CER and audio / text checks
    └── routes.py
frontend/                   Next.js web app (TypeScript, App Router)
├── next.config.ts          Forwards /api/* to the Flask API (API_URL)
└── src/
    ├── app/                login/, and behind the login (app)/: tasks/, tasks/[id]/, upload/,
    │                       datasets/, datasets/[id]/, users/
    ├── components/         Shell (menu, header), session (user, permissions), notify, dialogs,
    │                       CutEditorPanel, task/ (package view, review bar)
    ├── lib/                api client, types, review stages, task store, cut-editor.ts (the waveform editor)
    └── styles/             CSS
tests/                      pytest (SQLite per test, or TEST_DATABASE_URL=postgresql://...; ASR and Hub mocked)
docs/                       User guide and API reference
models/                     Model config and vocabulary (weights downloaded separately)
data/                       Created at runtime, not in git (audio files, dataset clips)
```

The [HTTP API](docs/api.md) can also be used from scripts.

## Contributing

Contributions are welcome: bug reports, Khmer text-normalization rules, new quality checks, translations of the interface, and documentation. See **[CONTRIBUTING.md](CONTRIBUTING.md)**.

```bash
pip install -r requirements-dev.txt
python -m pytest                                   # SQLite
TEST_DATABASE_URL=postgresql://... python -m pytest  # on PostgreSQL (an empty test database: its tables are dropped)
cd frontend && npm run typecheck && npm run build
```

## About the model

[Darayut/Omnilingual-ASR-Khm](https://huggingface.co/Darayut/Omnilingual-ASR-Khm) is a 0.3B-parameter Khmer CTC model (MIT license):

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

The official inference code depends on [fairseq2](https://github.com/facebookresearch/fairseq2), which has no native Windows build. `backend/asr/omni_asr.py` re-implements the same architecture in plain PyTorch, following the [model's source repository](https://github.com/NDarayut/Omnilingual-ASR-Khm), and loads the published weights with a strict check.

## References

**Models and code**
- Omnilingual-ASR-Khm: https://huggingface.co/Darayut/Omnilingual-ASR-Khm · source: https://github.com/NDarayut/Omnilingual-ASR-Khm
- Meta Omnilingual ASR (base encoder `omniASR_CTC_300M`): https://github.com/facebookresearch/omnilingual-asr
- fairseq2: https://github.com/facebookresearch/fairseq2
- khmercut (Khmer word segmentation, by Seanghay Yath): https://github.com/seanghay/khmercut

**Papers**
- Baevski, A., Zhou, H., Mohamed, A., & Auli, M. (2020). *wav2vec 2.0: A Framework for Self-Supervised Learning of Speech Representations.* NeurIPS 2020. https://arxiv.org/abs/2006.11477
- Graves, A., Fernández, S., Gomez, F., & Schmidhuber, J. (2006). *Connectionist Temporal Classification: Labelling Unsegmented Sequence Data with Recurrent Neural Networks.* ICML 2006.
- Nozaki, J., & Komatsu, T. (2021). *Relaxing the Conditional Independence Assumption of CTC-based ASR by Conditioning on Intermediate Predictions.* Interspeech 2021. https://arxiv.org/abs/2104.02724
- Meta AI Omnilingual ASR team (2025). *Omnilingual ASR: Open-Source Multilingual Speech Recognition for 1600+ Languages.* https://ai.meta.com/research/publications/omnilingual-asr-open-source-multilingual-speech-recognition-for-1600-languages/

**Libraries:** [Flask](https://flask.palletsprojects.com/) · [PyTorch](https://pytorch.org/) · [safetensors](https://github.com/huggingface/safetensors) · [huggingface_hub](https://github.com/huggingface/huggingface_hub) · [PyArrow](https://arrow.apache.org/docs/python/) · [pydub](https://github.com/jiaaro/pydub) · [soundfile](https://github.com/bastibe/python-soundfile) · [soxr](https://github.com/dofuuz/python-soxr) · [NumPy](https://numpy.org/) · [PyYAML](https://pyyaml.org/) · [khmercut](https://github.com/seanghay/khmercut) · [Noto Sans Khmer](https://fonts.google.com/noto/specimen/Noto+Sans+Khmer)

## Author

**Phon Sobon** · [@PhonSobon](https://github.com/PhonSobon) · [phon.sobon02@gmail.com](mailto:phon.sobon02@gmail.com)

## Acknowledgements

Thanks to **Darayut** for training and publishing the Khmer model and its source code, to **Seanghay Yath** for khmercut and Khmer speech datasets, and to **Meta AI** for releasing the Omnilingual ASR encoder.

## License

[MIT](LICENSE) © 2026 Phon Sobon. The ASR model is published separately under its own MIT license by its author.
