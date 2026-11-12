---
license: mit
language:
- km
tags:
- automatic-speech-recognition
- khmer
- ctc
---

# Omnilingual-ASR-Khm

A CTC speech-recognition model for Khmer, built on top of Meta's Omnilingual
ASR 300M encoder with a custom cluster-level vocabulary and a self-conditioned
CTC head.

## Training

The model is produced in two phases:

1. **Pretrain** -- the CTC head and encoder are trained from scratch (the
   encoder initialized from the public `omniASR_CTC_300M` checkpoint) on a
   Khmer speech corpus.
2. **Fine-tune** -- the pretrained checkpoint is further trained on
   Khmer-English code-switching data.

Both phases' configs and training scripts are in this model's source
repository.

## Results

CER on held-out evaluation sets (lower is better):

| split | CER | WER |
|---|---|---|
| val | 2.24% | 7.62% |
| test_fleurs | 12.03% | 25.66% |
| test_slr42 | 14.82% | 48.62% |

## Usage

```python
from huggingface_hub import hf_hub_download
from safetensors.torch import load_file

weights = hf_hub_download("Darayut/Omnilingual-ASR-Khm", "model.safetensors")
config = hf_hub_download("Darayut/Omnilingual-ASR-Khm", "config.json")
vocab = hf_hub_download("Darayut/Omnilingual-ASR-Khm", "vocab.json")
```

See `scripts/inference/transcribe.py` in the source repository for a complete
loading + decoding example.

## License

MIT.
