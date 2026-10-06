"""Darayut/Omnilingual-ASR-Khm in plain PyTorch (no fairseq2, which has no Windows build).

Architecture = Meta's omniASR_CTC_300M wav2vec2 encoder (pre-LN, 24 layers, 1024 dim)
+ a Khmer cluster-level CTC head with self-conditioning at layers 8 and 16.
Module names mirror the checkpoint keys so model.safetensors loads strictly.
Reference: https://github.com/NDarayut/Omnilingual-ASR-Khm (omnilingual_asr_khm/model/ctc_model.py)
"""
import json
import os

import torch
import torch.nn as nn
import torch.nn.functional as F

DEFAULT_REPO = "Darayut/Omnilingual-ASR-Khm"
SAMPLE_RATE = 16000
BLANK_ID = 0
SPECIALS = {"<pad>", "<unk>", "<sos>", "<eos>", "<mask>"}
_RMS_EPS = 1e-6
FRAME_SEC = 320 / SAMPLE_RATE  # conv frontend stride: 5*2*2*2*2*2*2 samples per output frame
PAUSE_SPLIT = 0.3  # seconds of silence that starts a new word even without a space

# wav2vec2 conv frontend: (channels, kernel, stride)
_CONV_LAYERS = [(512, 10, 5)] + [(512, 3, 2)] * 4 + [(512, 2, 2)] * 2


class _ConvLayer(nn.Module):
    def __init__(self, cin, cout, k, s):
        super().__init__()
        self.conv = nn.Conv1d(cin, cout, k, stride=s)
        self.layer_norm = nn.LayerNorm(cout)

    def forward(self, x):  # (N, C, T)
        x = self.conv(x)
        x = self.layer_norm(x.transpose(1, 2)).transpose(1, 2)
        return F.gelu(x)


class _FeatureExtractor(nn.Module):
    def __init__(self):
        super().__init__()
        layers, cin = [], 1
        for cout, k, s in _CONV_LAYERS:
            layers.append(_ConvLayer(cin, cout, k, s))
            cin = cout
        self.layers = nn.ModuleList(layers)

    def forward(self, wav):  # (N, S) -> (N, T, 512)
        x = wav.unsqueeze(1)
        for layer in self.layers:
            x = layer(x)
        return x.transpose(1, 2)


class _PosConv(nn.Module):
    """Weight-normed grouped conv positional encoder (weight_g/weight_v, dim=2)."""

    def __init__(self, dim=1024, kernel=128, groups=16):
        super().__init__()
        self.kernel, self.groups = kernel, groups
        self.weight_g = nn.Parameter(torch.ones(1, 1, kernel))
        self.weight_v = nn.Parameter(torch.empty(dim, dim // groups, kernel))
        self.bias = nn.Parameter(torch.zeros(dim))

    def forward(self, x):  # (N, C, T)
        v = self.weight_v
        w = self.weight_g * v / v.norm(dim=(0, 1), keepdim=True)
        return F.conv1d(x, w, self.bias, padding=self.kernel // 2, groups=self.groups)


class _PositionEncoder(nn.Module):
    def __init__(self, dim=1024):
        super().__init__()
        self.conv = _PosConv(dim)

    def forward(self, x):  # (N, T, C)
        enc = self.conv(x.transpose(1, 2))[:, :, :-1]  # even kernel -> drop the extra frame
        return x + F.gelu(enc).transpose(1, 2)


class _Frontend(nn.Module):
    def __init__(self, dim=1024):
        super().__init__()
        self.feature_extractor = _FeatureExtractor()
        self.post_extract_layer_norm = nn.LayerNorm(512)
        self.model_dim_proj = nn.Linear(512, dim)
        self.pos_encoder = _PositionEncoder(dim)

    def forward(self, wav):
        x = self.post_extract_layer_norm(self.feature_extractor(wav))
        return self.pos_encoder(self.model_dim_proj(x))


class _Attention(nn.Module):
    def __init__(self, dim, heads):
        super().__init__()
        self.heads = heads
        self.q_proj = nn.Linear(dim, dim)
        self.k_proj = nn.Linear(dim, dim)
        self.v_proj = nn.Linear(dim, dim)
        self.output_proj = nn.Linear(dim, dim)

    def forward(self, x):
        n, t, d = x.shape
        split = lambda y: y.view(n, t, self.heads, d // self.heads).transpose(1, 2)
        out = F.scaled_dot_product_attention(split(self.q_proj(x)), split(self.k_proj(x)), split(self.v_proj(x)))
        return self.output_proj(out.transpose(1, 2).reshape(n, t, d))


class _FFN(nn.Module):
    def __init__(self, dim, inner):
        super().__init__()
        self.inner_proj = nn.Linear(dim, inner)
        self.output_proj = nn.Linear(inner, dim)

    def forward(self, x):
        return self.output_proj(F.gelu(self.inner_proj(x)))


class _EncoderLayer(nn.Module):  # pre-LN
    def __init__(self, dim, heads, inner):
        super().__init__()
        self.self_attn_layer_norm = nn.LayerNorm(dim)
        self.self_attn = _Attention(dim, heads)
        self.ffn_layer_norm = nn.LayerNorm(dim)
        self.ffn = _FFN(dim, inner)

    def forward(self, x):
        x = x + self.self_attn(self.self_attn_layer_norm(x))
        return x + self.ffn(self.ffn_layer_norm(x))


class _Encoder(nn.Module):
    def __init__(self, dim, n_layers, heads, inner):
        super().__init__()
        self.layers = nn.ModuleList(_EncoderLayer(dim, heads, inner) for _ in range(n_layers))
        self.layer_norm = nn.LayerNorm(dim)


class OmniKhmerCTC(nn.Module):
    def __init__(self, vocab_size=2233, dim=1024, n_layers=24, heads=16, inner=4096,
                 self_cond_layers=(), self_cond_fb_scale=0.0):
        super().__init__()
        self.encoder_frontend = _Frontend(dim)
        self.encoder = _Encoder(dim, n_layers, heads, inner)
        self.ctc_head = nn.Linear(dim, vocab_size)
        self.taps = sorted(self_cond_layers)
        if self.taps:
            self.self_cond_fb = nn.Linear(vocab_size, dim)
            if self_cond_fb_scale > 0:
                self.self_cond_gain = nn.Parameter(torch.zeros(len(self.taps)))
            else:
                self.register_parameter("self_cond_gain", None)

    def forward(self, wav):  # (N, S) normalized waveform -> (N, T, V) logits
        x = self.encoder_frontend(wav)
        for i, layer in enumerate(self.encoder.layers, start=1):
            x = layer(x)
            if i in self.taps:  # self-conditioning: feed intermediate CTC posterior back in
                fb = self.self_cond_fb(self.ctc_head(x).softmax(-1))
                if self.self_cond_gain is not None:
                    target = x.pow(2).mean(-1, keepdim=True).sqrt()
                    current = fb.pow(2).mean(-1, keepdim=True).sqrt().clamp_min(_RMS_EPS)
                    fb = fb * (target / current) * self.self_cond_gain[self.taps.index(i)]
                x = x + fb
        return self.ctc_head(self.encoder.layer_norm(x))


def segment_words(text):
    """Split Khmer text into dictionary words with khmercut; returns [text] if it isn't installed."""
    try:
        from khmercut import tokenize
    except ImportError:
        return [text]
    return tokenize(text)


def _resolve_files(source):
    """`source` = local folder with model.safetensors/config.json/vocab.json, or a HF repo id."""
    names = ("model.safetensors", "config.json", "vocab.json")
    if os.path.isdir(source):
        return [os.path.join(source, n) for n in names]
    from huggingface_hub import hf_hub_download
    return [hf_hub_download(source, n) for n in names]


class OmniASR:
    def __init__(self, source=DEFAULT_REPO, device=None):
        from safetensors.torch import load_file

        weights, config_path, vocab_path = _resolve_files(source)
        with open(config_path, encoding="utf-8") as f:
            cfg = json.load(f)
        with open(vocab_path, encoding="utf-8") as f:
            vocab = json.load(f)
        self.inv_vocab = {i: s for s, i in vocab.items()}
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
        self.model = OmniKhmerCTC(
            vocab_size=cfg.get("vocab_size", len(vocab)), dim=cfg.get("encoder_dim", 1024),
            self_cond_layers=cfg.get("self_cond_layers", []),
            self_cond_fb_scale=cfg.get("self_cond_fb_scale", 0.0),
        )
        self.model.load_state_dict(load_file(weights), strict=True)
        self.model.to(self.device).eval()

    @torch.inference_mode()
    def recognize_array(self, audio):
        """audio: 1-D float array/tensor of 16 kHz mono samples.

        Returns {"text", "words"}; each word is {"text", "start", "end", "sp"} with times in
        seconds from the CTC alignment, and sp=True when a space preceded it in the text.
        """
        wav = torch.as_tensor(audio, dtype=torch.float32).flatten()
        if wav.numel() < 400:  # shorter than one conv receptive field
            return {"text": "", "words": []}
        wav = (wav - wav.mean()) / wav.std(unbiased=False).clamp_min(1e-7)
        ids = self.model(wav.unsqueeze(0).to(self.device))[0].argmax(-1).tolist()

        # CTC greedy: merge repeats, drop blanks; keep each token's [first, last] frame
        toks, prev, cur = [], None, None
        for f, t in enumerate(ids):
            if t == prev:
                if cur:
                    cur[2] = f
            else:
                cur = None
                s = self.inv_vocab.get(t) if t != BLANK_ID else None
                if s is not None and s not in SPECIALS:
                    cur = [s, f, f]
                    toks.append(cur)
            prev = t

        # Runs = clusters between spaces, also broken at pauses (Khmer often omits spaces)
        runs, run, space = [], None, False
        for s, a, b in toks:
            if not s.strip():
                run, space = None, True
                continue
            if run is None or (a - run["toks"][-1][2]) * FRAME_SEC >= PAUSE_SPLIT:
                run = {"toks": [], "sp": space and bool(runs)}
                runs.append(run)
                space = False
            run["toks"].append((s, a, b))

        # Words = each run split into dictionary words (khmercut), timed by their clusters
        words = []
        for run in runs:
            ts = run["toks"]
            text = "".join(t[0] for t in ts)
            pieces = [p for p in segment_words(text) if p.strip()]
            if "".join(pieces) != text:  # segmenter changed characters -> keep the run whole
                pieces = [text]
            owner = [k for k, t in enumerate(ts) for _ in t[0]]  # char offset -> cluster index
            pos = 0
            for n, p in enumerate(pieces):
                a, b = ts[owner[pos]][1], ts[owner[pos + len(p) - 1]][2]
                pos += len(p)
                words.append({"text": p, "start": round(a * FRAME_SEC, 3),
                              "end": round((b + 1) * FRAME_SEC, 3), "sp": run["sp"] and n == 0})
        return {"text": " ".join("".join(t[0] for t in toks).split()), "words": words}

    def transcribe_array(self, audio):
        return self.recognize_array(audio)["text"]

    def recognize_file(self, path):
        import numpy as np
        from pydub import AudioSegment

        seg = AudioSegment.from_file(path).set_channels(1).set_frame_rate(SAMPLE_RATE)
        samples = np.array(seg.get_array_of_samples(), dtype=np.float32)
        return self.recognize_array(samples / float(1 << (8 * seg.sample_width - 1)))

    def transcribe_file(self, path):
        return self.recognize_file(path)["text"]
