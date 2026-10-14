# User guide

This guide walks through both workflows of the Khmer Audio Annotation Tool step by step. For installation, see the [README](../README.md#quick-start).

- [Workflow 1: Annotate your own recordings](#workflow-1-annotate-your-own-recordings)
- [Workflow 2: Clean a Hugging Face dataset](#workflow-2-clean-a-hugging-face-dataset)
- [Output formats](#output-formats)
- [Pushing to the Hugging Face Hub](#pushing-to-the-hugging-face-hub)
- [Keyboard shortcuts](#keyboard-shortcuts)

---

## Workflow 1: Annotate your own recordings

Use this for long recordings (news, interviews, meetings, lectures) that must be cut into short clips and transcribed.

### 1. Upload & Crop

1. Drop or choose one or more audio or video files. Any format FFmpeg can read works; everything is converted to 16 kHz mono WAV.
2. Click an audio file to open its waveform.
3. Pick a cut length (10 s, 20 s, 30 s or any number of seconds) and click **✂ Cut selected audio** or **✂ Cut all audio**.
4. Fix the cuts on the waveform: drag across the waveform to make a crop, drag a boundary to move it, double-click a boundary to merge two crops, and press **Del** to leave a crop out.

This page shows only the waveform and the cut tools, with no text.

### 2. Push to a task

Every audio file has a checkbox, which is ticked automatically once the file is cut. Enter a task name and click **Push N selected audio to task →**. The ticked files become one **task** (a batch of work). Unticked files stay on Upload & Crop for later.

### 3. Annotate the packages

**My Tasks** shows one card per task. Open a task to see its **Task Batch List**: one *package* per crop, named like `news_0003`, in **Todo** and **Processed** tabs, with search, an annotator filter and duration statistics.

- **Recognize all** runs the local Khmer ASR on every package that has no text yet. Text you typed by hand is never overwritten.
- **Claim Package** opens the next package in Todo.

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
- **⬆ Push to Hugging Face** uploads the task as parquet to a Hub dataset repo (see [Pushing to the Hub](#pushing-to-the-hugging-face-hub)). Choose whether only **completed packages** (every segment has text) or **every segment with text** goes up. Many tasks can be pushed to the same repo.

---

## Workflow 2: Clean a Hugging Face dataset

Use this for datasets that are already cut into clips with a transcript, for example [seanghay/khmer_mpwt_speech](https://huggingface.co/datasets/seanghay/khmer_mpwt_speech). Open **Dataset Cleaning**.

### 1. Import

1. Enter the dataset id (or its URL) and click **Load**. A token is only needed for private or gated datasets.
2. Pick the config, split, audio column and text column. The usual transcript column (`transcription`, `sentence`, `text`, …) is chosen for you.
3. Choose how much to import:
   - **Small dataset:** leave **Rows per batch** empty to import the whole split as one dataset.
   - **Big dataset (thousands to millions of rows):** set **Rows per batch** (for example 200) and **Batches** (how many to create now, up to 100). Each batch becomes its own card, such as `… · rows 200–399`, and reads **only its own rows** from the Hub, so the rest of the dataset is never downloaded. **Start at row** is filled with the first row not imported yet, and overlapping batches are refused. Keep importing the next batches until the split is done. Clip ids use the source row number (`train_000250`), so they never clash between batches.
4. Leave **Check with the ASR after import** ticked to run step 2 automatically.

Every clip is converted to 16 kHz mono WAV in `data/datasets/<id>/`. The list of imported datasets has search (by name, repo, or a row number to find its batch), a filter (*still to review*, *reviewed, not pushed*, *pushed*) and pages.

### 2. Automatic checks

**Run checks** makes the local Omnilingual-ASR-Khm model recognize every clip and compares its output with the dataset text using the **character error rate (CER)**, ignoring spaces and punctuation. Audio and text problems are found during import:

| Problem | Severity | Meaning |
|---|---|---|
| No text, No speech, Too short (< 0.5 s), Duplicate audio, ASR heard nothing | likely bad | The clip is very likely unusable |
| Digits, Latin letters, Symbols | review | The text does not show how it is spoken (`#១`, `125cc`, `១០`) |
| Clipping, Quiet, Too long (> 30 s), Speaking rate | review | Bad audio, or text that is cut off or too long for the audio (rate far from the dataset median) |
| Long silence, Same text | info | Silence at the ends can be trimmed; repeated sentences are shown |

Each clip gets a check result: **Passed** (CER ≤ 10 % and no problem), **Needs review**, **Likely bad** (CER > 50 % or a "likely bad" problem) or **Not checked**. The limits can be changed with `CER_PASS` and `CER_BAD`.

> The ASR is a guide, not a judge. If the model was trained on the dataset you are cleaning, its CER on that dataset looks better than it really is. Listen to a sample of the passed clips too.

### 3. Review

- **Accept passing clips** accepts every passed clip at once (the CER limit can be changed).
- The rest are listed worst first. The **review panel** shows the waveform and the dataset text next to what the ASR heard, with the differences highlighted (red = in the text but not heard, green = heard but missing from the text).
- Fix the **Final text**, take the ASR text (**U**), or reject the clip with a reason (**R**).
- **Trim:** *Keep* sets the start and end of the clip; **Trim silence** (**T**) cuts the silence at both ends.
- **Cut:** if a clip holds two sentences, click the waveform where it should be cut and press **✂ Cut here** (**S**). The row becomes two parts (`row · 1`, `row · 2`); the first keeps the text and the second starts empty. Both go back to review. **Join next part** puts them back together.
- **Check this clip** runs the ASR on the open clip only, with its trim applied.
- **Normalized text** is made automatically from the final text. Type in it to correct it; **↺ Auto-normalize** goes back to the automatic one.

Every change is saved at once.

### 4. Output

Choose what goes out (*accepted clips only*, *everything except rejected*, or *all clips with their review status*) and whether long silence at the ends is trimmed. Then:

- **Export ZIP:** `<name>/wavs/*.wav` and `metadata.json`.
- **Push to Hugging Face:** uploads parquet to a Hub repo. All batches of a big dataset can go to the **same repo**: each batch writes its own files and replaces only its own earlier upload. The dialog offers the repo that the other batches were pushed to.

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

### Dataset cleaning ZIP (workflow 2)

`<name>/wavs/<split>_<row>.wav` (`<split>_<row>_<part>.wav` for a cut row) and `metadata.json` with `text`, `text_normalized`, `original_text`, `asr_text`, `cer`, `status`, `reason`, `flags`, `source_index` and the source's other columns.

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

### Cut editor (Upload & Crop and package page)

| Action | How |
|---|---|
| Crop a range into one segment | Drag across the waveform |
| Select a crop / move the playhead | Click the waveform; ↑ / ↓ or ⏮ / ⏭ for the previous / next crop |
| Step the playhead | ← / → (Shift for 1 s steps) |
| Play / pause | **Space** or ▶ |
| Cut the selected crop at the playhead | **S** or ✂ |
| Move a boundary | Drag the line (snaps to word gaps; hold Alt to place it freely) |
| Merge two crops | Double-click the line between them |
| Undo / redo | **Ctrl+Z** / **Ctrl+Y** |
| Zoom | Timeline zoom slider, or Ctrl + mouse wheel |
| Leave a crop out | **Del** (again to restore) |

On the task page: **Ctrl+Enter** plays or pauses the crop, and **Ctrl+↓** / **Ctrl+↑** go to the next or previous crop.

### Dataset review panel

| Key | Action |
|---|---|
| Space | Play / pause |
| A, or Ctrl+Enter while typing | Accept and go to the next clip |
| U | Use the ASR text |
| R | Reject (with the selected reason) |
| T | Trim the silence at both ends |
| S | Cut the clip in two at the playhead |
| J / K (or ↓ / ↑) | Next / previous clip |
| E / Esc | Edit the text / leave the text box |
