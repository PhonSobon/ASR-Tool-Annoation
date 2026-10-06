# Khmer ASR Annotation Tool

A local web tool for building Khmer speech datasets. Upload a long recording, cut it into short crops, transcribe each crop automatically, fix the text and the cut points by hand, and export the result as WAV files plus a CSV.

## Features

- **Upload and auto-cut:** accepts any audio or video file and cuts it into 10 s, 20 s, 30 s or custom-length crops (16 kHz mono WAV).
- **Two recognition engines:**
  - **Local Omnilingual-ASR Khmer** ([Darayut/Omnilingual-ASR-Khm](https://huggingface.co/Darayut/Omnilingual-ASR-Khm)) runs on your own GPU or CPU, with no API key and no internet once the model is downloaded.
  - **Google Gemini** (needs an API key) handles Khmer or English, with a model picker.
- **Cut editor for each crop:**
  - waveform with a time ruler and zoom
  - playhead, play/pause, and the current word highlighted during playback
  - recognized words placed on the timeline using CTC alignment timestamps, split into real Khmer words with [khmercut](https://github.com/seanghay/khmercut)
  - cuts between words (click ┊), at the playhead (**S**), or automatically at pauses
  - drag cut lines to adjust them; double-click a line to remove it
  - keep or drop each part, so noise and silence can be trimmed
  - each new part takes its share of the recognized text
- **Khmer word segmentation:** every crop shows its text split into words (khmercut), and the export includes it as `text_segmented`.
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

1. Choose an audio file and a cut length, then click **Upload & Cut**.
2. Pick an engine and click **Auto Recognition**. Crops are transcribed one by one.
3. Correct the text in each box. Click **✂ Edit cut** on any crop to split or trim it, then **✓ Apply cut**.
4. Click **Export ZIP (folder + JSON)**.

### Cut editor controls

| Action | How |
|---|---|
| Move playhead | Click the waveform, or use ← / → (Shift for 1 s steps) |
| Play / pause | **Space** or ▶ Play |
| Cut at playhead | **S** or ✂ Split at playhead |
| Cut between two words | Click ┊ in the word row |
| Cut at every pause | ✂ Cut at pauses ≥ *n* s |
| Move a cut | Drag the red line (it snaps to word gaps; hold Alt to place freely) |
| Remove a cut | Double-click the red line, or ⤒ Join with previous |
| Zoom | Zoom − / Zoom +, or Ctrl + mouse wheel |
| Drop a part | Untick **keep** in the parts list |

Word timings come only from the local Omnilingual model. Gemini results can still be cut, but without word positions.

### Export format

```
<audio name>/
├── wavs/
│   ├── <audio name>_crop_0001.wav
│   ├── <audio name>_crop_0002.wav
│   └── ...
└── metadata.json
```

`metadata.json` is a UTF-8 list with one entry per crop. `start`/`end` are seconds in the original recording, and `text_segmented` is generated from the final (edited) text:

```json
[
  {
    "id": "news_crop_0001",
    "file": "wavs/news_crop_0001.wav",
    "start": 0.0,
    "end": 8.0,
    "duration": 8.0,
    "text": "សូមគោរពជូនលោកប្រធានការិយាល័យ",
    "text_segmented": "សូម គោរព ជូន លោក ប្រធាន ការិយាល័យ"
  }
]
```

## Project layout

```
app.py                  Flask server: upload, cut, transcribe, split, export
omni_asr.py             Omnilingual-ASR-Khm in plain PyTorch + CTC word timings
templates/index.html    Web UI, including the cut editor
models/Omnilingual-ASR-Khm/
                        config.json, vocab.json (weights downloaded separately)
data/chunks/            Uploaded sessions and crops (created at runtime, not in git)
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

The official inference code depends on [fairseq2](https://github.com/facebookresearch/fairseq2), which has no native Windows build. `omni_asr.py` re-implements the same architecture in plain PyTorch, following the [model's source repository](https://github.com/NDarayut/Omnilingual-ASR-Khm). It loads the published weights with a strict check, so every tensor in the checkpoint must match.

## References

### Models and code
- **Omnilingual-ASR-Khm** (model used by this tool): https://huggingface.co/Darayut/Omnilingual-ASR-Khm (MIT license)
- **Omnilingual-ASR-Khm source code** (training, tokenizer, reference inference): https://github.com/NDarayut/Omnilingual-ASR-Khm
- **Meta Omnilingual ASR** (base encoder `omniASR_CTC_300M`): https://github.com/facebookresearch/omnilingual-asr
- **fairseq2** (Meta's sequence modeling toolkit the original model is built on): https://github.com/facebookresearch/fairseq2
- **Google Gemini API** (optional cloud engine): https://ai.google.dev/gemini-api/docs
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
