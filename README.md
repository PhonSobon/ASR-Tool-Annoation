# Khmer Audio Annotation Tool

An open-source web tool for building and cleaning **Khmer speech datasets** for automatic speech recognition (ASR). It runs on your own computer, transcribes Khmer speech with a local model (no API key, no cloud service), and exports training-ready data as WAV + JSON or straight to the [Hugging Face Hub](https://huggingface.co/datasets).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue)

It covers two jobs:

1. **Annotate your own recordings.** Upload long recordings, cut them into short clips on a waveform, let the model draft a transcript, fix it, add speaker and recording details, and export.
2. **Clean an existing Hugging Face dataset.** Import a Khmer speech dataset (even one with a million rows, in batches of a few hundred), let the model flag clips whose text does not match the audio, review them, and push the cleaned dataset back to the Hub.

## Features

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
- Automatic checks: character error rate (CER) of the local ASR against the dataset text, plus audio and text problems (silence, clipping, duplicates, digits, Latin letters, speaking rate …). Each clip is marked *passed*, *needs review* or *likely bad*.
- Fast review: text and ASR output side by side with the differences highlighted, keyboard shortcuts, trim, cut a clip in two, join parts, reject with a reason.

**Output**
- ZIP with `wavs/` + `metadata.json`.
- Push to the Hugging Face Hub as parquet, to your own repo or as a pull request. **Many tasks or batches can be pushed to the same repo**: each one writes its own files, and the dataset card keeps a table of everything pushed.

## Quick start

**Requirements:** Python 3.10 or newer, and [FFmpeg](https://ffmpeg.org/download.html) on your `PATH`. An NVIDIA GPU is optional but makes recognition much faster.

```bash
git clone https://github.com/PhonSobon/ASR-Tool-Annoation.git
cd ASR-Tool-Annoation
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS / Linux: source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open **http://127.0.0.1:5000** in your browser.

For GPU support, install the CUDA build of PyTorch from [pytorch.org](https://pytorch.org/get-started/locally/) before `pip install -r requirements.txt`.

### Model weights

The model weights (`model.safetensors`, 1.28 GB) are not stored in this repository. Either:

- **Do nothing:** the app downloads the model from Hugging Face the first time you transcribe, or
- **Download them once into the project** (works offline afterwards):

  ```bash
  python -c "from huggingface_hub import snapshot_download; snapshot_download('Darayut/Omnilingual-ASR-Khm', local_dir='models/Omnilingual-ASR-Khm')"
  ```

To use another copy, set `OMNI_ASR_MODEL` to a Hugging Face repo id or to a folder with `model.safetensors`, `config.json` and `vocab.json`.

## How to use it

### Annotate your own recordings

1. **Upload & Crop:** add audio files, cut them (for example every 20 s) and fix the cuts on the waveform.
2. Tick the files that are ready and **push them to a task**.
3. **My Tasks → open the task:** press **Recognize all** to draft every transcript, then go through the packages. Fix the text, split dialogue into speaker turns and fill in the speaker and recording details.
4. **Export task ZIP**, or **Push to Hugging Face**.

### Clean a Hugging Face dataset

1. **Dataset Cleaning:** enter a dataset id such as `seanghay/khmer_mpwt_speech` and click **Load**.
2. Choose the split, the audio and text columns, and for a big dataset the **rows per batch** (for example 200) and how many batches to create.
3. The clips are imported and checked by the ASR. **Accept passing clips** in one click, then review the rest, worst first.
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

All settings are optional environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `OMNI_ASR_MODEL` | `models/Omnilingual-ASR-Khm` if the weights are there, else the Hugging Face repo | The ASR model |
| `ASR_DATA_DIR` | `data/` | Where uploads, tasks and imported datasets are stored |
| `HF_TOKEN` | the login from `hf auth login` | Hugging Face token (a token typed in the app is used instead) |
| `ANNOTATOR_NAME` | the computer's user name | Saved as the annotator / reviewer of your changes |
| `CER_PASS` / `CER_BAD` | `0.10` / `0.50` | Dataset cleaning: CER limits for *passed* / *likely bad* |
| `HOST` / `PORT` | `127.0.0.1` / `5000` | Where the web server listens |
| `FLASK_DEBUG` | `0` | `1` turns on the Flask debugger (only on your own computer) |

### Security

The tool has **no login**. Anyone who can open its web page can read, change and delete the data. Keep the default `HOST=127.0.0.1` (only your computer), or run it only on a network you trust. Never turn on `FLASK_DEBUG=1` when other people can reach the server: the debugger can run any code. Hugging Face tokens typed into the app are used for that request only and are not saved.

## Project structure

```
app.py                  Entry point (python app.py)
backend/                Flask backend
├── routes/             HTTP API, one blueprint per feature (see docs/api.md)
├── services/           Logic: audio, tasks, export, text normalization, quality checks,
│                       Hugging Face Hub (read / write parquet), background jobs
└── asr/omni_asr.py     Omnilingual-ASR-Khm in plain PyTorch, with CTC word timings
frontend/               Web UI served by Flask, plain HTML / CSS / JavaScript, no build step
tests/                  pytest tests (temporary data folder, ASR and Hub mocked)
docs/                   User guide and API reference
models/                 Model config and vocabulary (weights downloaded separately)
data/                   Created at runtime, not in git
```

The [HTTP API](docs/api.md) can also be used from scripts.

## Contributing

Contributions are welcome: bug reports, Khmer text-normalization rules, new quality checks, translations of the interface, and documentation. See **[CONTRIBUTING.md](CONTRIBUTING.md)**.

```bash
pip install -r requirements-dev.txt
python -m pytest
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

## Acknowledgements

Thanks to **Darayut** for training and publishing the Khmer model and its source code, to **Seanghay Yath** for khmercut and Khmer speech datasets, and to **Meta AI** for releasing the Omnilingual ASR encoder.

## License

[MIT](LICENSE) © 2026 Phon Sobon. The ASR model is published separately under its own MIT license by its author.
