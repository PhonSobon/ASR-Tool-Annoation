# User guide

This guide walks through both workflows of the Khmer Audio Annotation Tool step by step. For installation, see the [README](../README.md#quick-start).

- [Users and roles](#users-and-roles)
- [Workflow 1: Annotate your own recordings](#workflow-1-annotate-your-own-recordings)
- [Workflow 2: Clean a Hugging Face dataset](#workflow-2-clean-a-hugging-face-dataset)
- [Output formats](#output-formats)
- [Pushing to the Hugging Face Hub](#pushing-to-the-hugging-face-hub)
- [Keyboard shortcuts](#keyboard-shortcuts)

---

## Users and roles

There is no sign-up: everyone signs in with an account the administrator made. The administrator comes from `ADMIN_USERNAME` (default `admin`) and `ADMIN_PASSWORD` in `.env`; it is created at start-up and its password can only be changed there (then restart). The administrator adds the other users under **Administration → Users & Roles** with a **default password**; managers, annotators, reviewers and viewers must choose their own password the first time they sign in. **Administration → Activity & Status** shows every user's status (online, never signed in, still on the default password, deactivated), who worked today and who did not, and the full activity log. The **Team** tab of **Workbench → Dashboard** (administrators) shows what each user produced in a period (all time, today, 7 / 30 days or chosen dates): hours annotated, packages completed and in progress, how many times their packages were returned (errors) and how many were accepted, the reviews they made, and the dataset clips they accepted or rejected. Its **Projects** tab (administrators and project managers) shows where the whole project stands: how many tasks are waiting for a pull and how many were pulled, packages completed, waiting for inspection / acceptance (and how long the oldest one has waited), accepted and returned, the first-inspection pass rate and return rate, a daily chart (7 / 14 / 30 days), the tasks that need attention (pushed but not pulled, no save for 3 days, returned packages), the annotators free to pull, dataset cleaning totals and a table of every task. Click a status chip to filter the table, or a task to open it. Every password must be **8 to 12 characters** with an upper-case letter, a lower-case letter, a number and a special character (such as `! @ # $ %`), no spaces, and must not contain the user name.

| Role | What it can do |
|---|---|
| **Administrator** | Everything, and manages users and roles |
| **Project Manager** | Upload & Crop, make tasks, import Hugging Face datasets, assign people, export ZIPs, push to the Hub; can also annotate and review |
| **Annotator** | Annotates the packages of the tasks they are a member of; reviews the clips of the datasets they are assigned to |
| **Reviewer** | Reviews completed packages: **accepts** them or **returns** them to the annotator with a note; may fix the text |

Annotators and reviewers see only the tasks and datasets a manager added them to (the **Members** button). Every package goes through one review:

```
Todo (annotator) --Complete--> Review --Accept--> Done
        ^                        |
        +---- Return + note -----+
```

Nobody can review a package they annotated themselves (except the administrator). An accepted package can no longer be changed by its annotator. When you push a task to the Hub you choose **accepted** packages or all **completed** ones.

Inspection and acceptance used to be two separate steps with two roles (Quality Inspector, Acceptor). They are one review now: at start-up, users who had the Acceptor role become Reviewers (and are signed out once), task members listed as acceptors become reviewers, and a package that had passed the old inspection but was never accepted waits for the review again. Accepted packages and the review history are kept.

Managers add people to a task or a dataset with the **Members** button on its page. Instead of assigning annotators one by one, a manager can press **Push to annotators** on the task card in My Tasks (or on the task page) once the data is loaded: every annotator then sees the task under **Available to pull** in My Tasks and joins it with **Pull dataset**. A pull is exclusive: the first annotator who pulls the task gets it, and it disappears from Available to pull for all other annotators (any number of users can share a role, e.g. 4 administrators and 10 annotators; push several tasks so each annotator can pull one). **Take back** works only until someone pulls it. Once an annotator has pulled the task, the card shows a purple **Pulled by …** status and Take back is disabled (remove that person in **Members** first if they really should stop). The Members dialog has the same switch per role (**Open for pulling**), and for datasets reviewers can be allowed to claim the dataset (**Claim dataset** in Dataset Cleaning). Use the avatar (top right) to change your password or log out.

---

## Workflow 1: Annotate your own recordings

Use this for long recordings (news, interviews, meetings, lectures) that must be cut into short clips and transcribed.

### 1. Load Data → Upload & cut audio

1. Drop or choose one or more audio or video files. Any format FFmpeg can read works; everything is converted to 16 kHz mono WAV.
2. Click an audio file to open its waveform.
3. Pick a cut length (10 s, 20 s, 30 s or any number of seconds) and click **✂ Cut selected audio** or **✂ Cut all audio**.
4. Fix the cuts on the waveform: drag across the waveform to make a crop, drag a boundary to move it, double-click a boundary to merge two crops, and press **Del** to leave a crop out.

This page shows only the waveform and the cut tools, with no text.

### 2. Push to a task

Every audio file has a checkbox, which is ticked automatically once the file is cut. Enter a task name and click **Push N selected audio to task →**. The ticked files become one **task** (a batch of work). Unticked files stay on Load Data for later.

### 3. Annotate the packages

**My Tasks** shows one card per task. Open a task to see its **Task Batch List**: one *package* per crop, named like `news_0003`, in **Todo** and **Processed** tabs, with search, an annotator filter and duration statistics.

- **Recognize all** runs the local Khmer ASR on every package that has no text yet. Text you typed by hand is never overwritten. Recognized packages stay in **Todo** with the status **To check**.
- **Claim Package** opens the next package in Todo.
- A package moves to **Processed** only when you have checked it and press **✓ Complete** on the package page (or skip it). **Back to Todo** reopens a completed package; removing the text of a segment also puts it back in Todo.

On the **package page**:

- The crop is shown in the same waveform editor. If more than one person speaks, cut it into **dialogue segments**, one per speaker turn (press **S** at the playhead, or drag across the waveform).
- The **Dialogue Segments** table has, for each segment: the role (speaker), the annotation text, the normalized text, and ▶ play / ↻ recognize / 🗑 skip buttons.
- **Role Information:** age group, gender and native speaker, for each role.
- **Overall Audio Information:** language, accent, domain, speech style, speaker overlap, background sound, special challenges and code switching. These are pre-filled from the previous package.
- Missing required fields are listed at the bottom of the page. **Annotation Specification** shows the annotation guidelines.

The **normalized text** is made automatically from the annotation text: Khmer word segmentation with [khmercut](https://github.com/seanghay/khmercut), Khmer digits changed to 0-9, and zero-width spaces removed. Edit it if the segmentation is wrong; **↺ Auto-normalize** makes it again.

Every change is saved on the server as you work, so you can close the browser and continue later.

### 4. Export or push

- **⬇ Export task ZIP** downloads WAV files and a `metadata.json` (see [Output formats](#output-formats)).
- **⬆ Push to Hugging Face** appears once every package is completed (Todo is empty). It uploads the completed packages as parquet to a Hub dataset repo (see [Pushing to the Hub](#pushing-to-the-hugging-face-hub)). Many tasks can be pushed to the same repo. A **private** repo needs your access token (write).

---

## Workflow 2: Load a dataset that already has its text

Use this for speech that is already cut into clips with a transcript: a Hugging Face dataset (for example
[seanghay/khmer_mpwt_speech](https://huggingface.co/datasets/seanghay/khmer_mpwt_speech)) or a folder of audio files
with their labels. Open **Load Data** and choose **Hugging Face** or **Local folder**. The clips go straight into a new
**task**: every clip is one package, named after its file, with its **text and normalized text already filled in**.
There is nothing to recognize (the Recognize buttons are hidden for these packages): the annotator listens, fixes the
text if needed and presses **✓ Complete**, then the package goes to the review like any other (see
[Annotate the packages](#3-annotate-the-packages)). Assign the people with **Members** on the task.

### Hugging Face

1. Enter the dataset id (or its URL) and click **Load**. A token is only needed for private or gated datasets.
2. Pick the config, split, audio column and text column. The usual transcript column (`transcription`, `sentence`, `text`, …) is chosen for you.
3. Choose how much to load:
   - **Small dataset:** leave **Clips per task** empty to load the whole split into one task.
   - **Big dataset (thousands to millions of rows):** set **Clips per task** (for example 200) and **Tasks** (how many to make now, up to 100). Each task, such as `… · rows 200–399`, reads **only its own rows** from the Hub. **Start at row** is filled with the first row not loaded yet, and overlapping rows are refused.
4. Click **Load into task**. The clips are downloaded in the background; the task page shows the progress and fills in as they arrive.

### Local folder

Drop the folder on the page (or click to pick it, or choose the files). The labels are matched to the audio in the browser before anything is sent:

- **A text file per audio:** `wavs/a.wav` + `wavs/a.txt` (or `.lab`, or `a.json` with `{"text": "…"}`). The text file may be in another folder if no other audio has the same name.
- **A JSON file:** `metadata.json` as this tool exports it (`[{"file": "wavs/a.wav", "text": "…"}, …]`), a list under a key (`{"data": [...]}`), a map `{"a.wav": "text", …}`, or JSON Lines / NeMo manifests (`.jsonl`, one `{"audio_filepath": "…", "text": "…"}` per line). An audio column such as `{"path": "a.wav"}` works too. Only the text is read.
- **A metadata file:** `metadata.csv`, `.tsv`, `.txt` or Kaldi's `text`, one line per clip, such as `a.wav|text` (LJSpeech), `a.wav<tab>text`, `utt_id text…` or a CSV whose header names the columns (`file_name` / `path` / `audio` / `id` … and `transcription` / `text` / `sentence` …).

Audio formats: WAV, MP3, FLAC, OGG, Opus, M4A, AAC, WMA, WebM and MP4. The table shows each file with its label, the ones without a label first; those are left out unless you tick **Also upload … without a label**. Give the task a name and click **Load … into a task**. The files are sent in small parts (a part that fails is sent again) and the task opens when they are all there.

Every clip is converted to 16 kHz mono WAV. Export and push the task like any other ([Export or push](#4-export-or-push)).

---

## Output formats

### Task ZIP (workflow 1)

```
<task name>/
└── <audio name>/
    ├── wavs/
    │   ├── <audio name>_0001.wav
    │   ├── <audio name>_0003_01.wav     ← a package cut into dialogue segments
    │   └── ...
    └── metadata.json
```

`metadata.json` is a UTF-8 list with one entry per segment. Skipped packages and segments are left out, and `start`/`end` are seconds in the original recording:

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
    "text_normalized": "សូម គោរព ជូន លោក ប្រធាន ការិយាល័យ 12",
    "speaker": {"age": "18-35", "gender": "Male", "native": "Yes"},
    "audio_info": {"language": "Khmer", "accent": "Phnom Penh", "domain": "EDU_GOV"}
  }
]
```


### Hub parquet columns

| Pushed from | Columns |
|---|---|
| A task | `audio`, `text`, `text_normalized`, `id`, `task`, `source_audio`, `start`, `end`, `duration`, `role`, `speaker_age`, `speaker_gender`, `speaker_native`, `language`, `accent`, `domain`, `subdomain`, `speech_style`, `speaker_overlap`, `background_sound`, `code_switching`, `challenges` |
| Dataset cleaning | the source's audio and text column names, `<text>_normalized`, the source's other columns, `original_<text>`, `duration`, `asr_cer`, `review_status` |

---

## Pushing to the Hugging Face Hub

- **Login:** enter a token with *write* access from [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens), or leave the token field empty to use your `hf auth login` (or the `HF_TOKEN` environment variable). Tokens are only used for that request and are not saved by the tool.
- **Your own repo** is created (private by default) if it does not exist yet. You can also open a **pull request** on an existing repo, for example the original dataset, so its owner can decide whether to merge it.
- **Many uploads, one repo.** Each upload writes its own files and replaces only its own earlier files:

  | Upload | Files in the repo |
  |---|---|
  | A whole split | `data/<split>-00000-of-00001.parquet` |
  | A batch of rows | `data/<split>-rows-0000200-0000399-00000-of-00001.parquet` |
  | A task | `data/<split>-task-<task id>-00000-of-00001.parquet` |

  The Hub's dataset viewer reads every file of a split together as one dataset.
- **Dataset card.** The repo's `README.md` keeps its own text and gets a *Cleaning report* with a table of every batch or task pushed (clips, hours, rejected, text fixed, date) and the totals.
- Uploads to one repo are made one at a time. If someone else commits to the repo at the same moment, the upload is retried with the newest dataset card.

---

## Keyboard shortcuts

### Cut editor (Load Data and package page)

| Action | How |
|---|---|
| Crop a range into one segment | Drag across the waveform |
| Select a crop / move the playhead | Click the waveform; ↑ / ↓ or ⏮ / ⏭ for the previous / next crop |
| Step the playhead | ← / → (Shift for 1 s steps) |
| Play / pause | **Space** or ▶ |
| Cut where you click (no need to play first) | Turn on the **✂ Cut** tool (or press **C**), then click the waveform: each click cuts there, the red line shows where. **C** or **Esc** turns it off. On the package page, ✂ in a row turns it on for that segment |
| Cut the selected crop at the playhead (while listening) | **S** |
| Scroll the zoomed timeline | The scrollbar under the waveform, a sideways trackpad swipe, or Shift + mouse wheel (while playing, the view stops following the playhead until it gets there) |
| Move a boundary | Drag the line (snaps to word gaps; hold Alt to place it freely) |
| Merge two crops | Double-click the line between them |
| Undo / redo | **Ctrl+Z** / **Ctrl+Y** |
| Zoom | Timeline zoom slider, or Ctrl + mouse wheel |
| Leave a crop out | **Del** (again to restore) |

On the task page: **Ctrl+Enter** plays or pauses the crop, and **Ctrl+↓** / **Ctrl+↑** go to the next or previous crop.

