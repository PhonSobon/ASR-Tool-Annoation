"""muyleanging/Sota-ASR-Khmer-ONNX with ONNX Runtime (no PyTorch).

Architecture: a 26M-parameter Conformer (12 blocks, 256 dim) with a CTC head and a 3-layer attention decoder.
The log-Mel front end is inside the encoder graph, so it takes raw 16 kHz audio. Decoding follows the model's own
sota_infer.py: CTC greedy draft, 5-beam attention decoding rescored with CTC (0.7 decoder + 0.3 CTC) and length guards.
Word times come from a CTC forced alignment of the final tokens.
Reference: https://huggingface.co/muyleanging/Sota-ASR-Khmer-ONNX
"""
import json
import os

import numpy as np

DEFAULT_REPO = "muyleanging/Sota-ASR-Khmer-ONNX"
SAMPLE_RATE = 16000
BLANK, BOS, EOS, NSPECIAL = 4, 1, 2, 5   # ids 0-4: <pad> <s> </s> <unk> <blank>
FRAME_SEC = 0.04            # two stride-2 convolutions over 10 ms Mel frames
MAX_PIECE_SEC = 15          # longer audio is cut at the quietest 0.1 s between 8 s and 15 s
PAUSE_SPLIT = 0.3           # seconds of silence that starts a new word even without a space
BEAM, CTC_WEIGHT, GUARD = 5, 0.3, 1.5
FILES = ("encoder.int8.onnx", "decoder.int8.onnx", "tokens.json")


def segment_words(text):
    """Split Khmer text into dictionary words with khmercut; returns [text] if it isn't installed."""
    try:
        from khmercut import tokenize
    except ImportError:
        return [text]
    return tokenize(text)


def _resolve_files(source):
    """`source` = local folder with encoder.int8.onnx, decoder.int8.onnx, tokens.json, or a HF repo id."""
    if os.path.isdir(source):
        paths = [os.path.join(source, n) for n in FILES]
        missing = [p for p in paths if not os.path.isfile(p)]
        if missing:
            raise FileNotFoundError("missing model file(s): " + ", ".join(missing))
        return paths
    from huggingface_hub import hf_hub_download
    return [hf_hub_download(source, n) for n in FILES]


def split(wav, sr=SAMPLE_RATE):
    """Pieces of at most 15 s -> [(start_sample, piece)], cut at the quietest 0.1 s between 8 s and 15 s."""
    parts, s, w = [], 0, sr // 10
    while len(wav) - s > MAX_PIECE_SEC * sr:
        starts = np.arange(s + 8 * sr, s + MAX_PIECE_SEC * sr - w, w // 2)
        energy = [float(np.sum(wav[a:a + w] ** 2)) for a in starts]
        cut = int(starts[int(np.argmin(energy))] + w // 2)
        parts.append((s, wav[s:cut]))
        s = cut
    if len(wav) - s > sr // 10:
        parts.append((s, wav[s:]))
    return parts


def greedy(lp):
    out, prev = [], -1
    for t in lp.argmax(-1).tolist():
        if t != prev and t != BLANK:
            out.append(t)
        prev = t
    return out


def _ext(seq):
    ext = np.full(2 * len(seq) + 1, BLANK, dtype=np.int64)
    ext[1::2] = seq
    skip = np.zeros(len(ext), bool)
    skip[2:] = (ext[2:] != BLANK) & (ext[2:] != ext[:-2])
    return ext, skip


def ctc_score(lp, seq):
    """log P_CTC(seq | audio), forward algorithm."""
    ext, skip = _ext(seq)
    a = np.full(len(ext), -np.inf)
    a[0] = lp[0, BLANK]
    if len(ext) > 1:
        a[1] = lp[0, ext[1]]
    for t in range(1, len(lp)):
        b = a.copy()
        b[1:] = np.logaddexp(b[1:], a[:-1])
        b[2:] = np.where(skip[2:], np.logaddexp(b[2:], a[:-2]), b[2:])
        a = b + lp[t, ext]
    return float(np.logaddexp(a[-1], a[-2])) if len(ext) > 1 else float(a[0])


def align(lp, seq):
    """CTC forced alignment (Viterbi): [(first_frame, last_frame)] for each token of seq."""
    if not seq:
        return []
    ext, skip = _ext(seq)
    T, S = len(lp), len(ext)
    if T < len(seq):  # cannot fit; spread the tokens evenly
        return [(i * T // len(seq), max(i * T // len(seq), (i + 1) * T // len(seq) - 1)) for i in range(len(seq))]
    a = np.full(S, -np.inf)
    a[0] = lp[0, BLANK]
    a[1] = lp[0, ext[1]]
    back = np.zeros((T, S), dtype=np.int8)   # 0 stay, 1 from s-1, 2 from s-2
    for t in range(1, T):
        cand = np.stack([a, np.r_[-np.inf, a[:-1]], np.where(skip, np.r_[-np.inf, -np.inf, a[:-2]], -np.inf)])
        back[t] = cand.argmax(0)
        a = cand.max(0) + lp[t, ext]
    s = S - 1 if S == 1 or a[S - 1] >= a[S - 2] else S - 2
    spans = [None] * len(seq)
    for t in range(T - 1, -1, -1):
        if s % 2:
            k = s // 2
            spans[k] = (t, spans[k][1]) if spans[k] else (t, t)
        s -= int(back[t, s])
    return spans


class SotaASR:
    def __init__(self, source=DEFAULT_REPO):
        import onnxruntime as ort

        enc, dec, tokens = _resolve_files(source)
        providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in ort.get_available_providers()]
        self.enc = ort.InferenceSession(enc, providers=providers)
        self.dec = ort.InferenceSession(dec, providers=providers)
        with open(tokens, encoding="utf-8") as f:
            self.vocab = json.load(f)

    def _beam(self, enc, lp, draft):
        """5 beams, stop when no live beam can win, CTC rescoring, length guards (as in the model's sota_infer.py)."""
        if not draft:
            return draft
        hyps, done = [([BOS], 0.0)], []
        for _ in range(int(GUARD * len(draft)) + 1):
            toks = np.array([h[0] for h in hyps], dtype=np.int64)
            out = self.dec.run(None, {"tokens": toks, "enc": np.repeat(enc, len(hyps), 0)})[0]
            cand = [(hyps[i][0] + [int(t)], hyps[i][1] + float(row[t]))
                    for i, row in enumerate(out) for t in np.argpartition(-row, BEAM)[:BEAM]]
            cand.sort(key=lambda c: -c[1])
            hyps = []
            for seq, sc in cand:
                if seq[-1] == EOS:
                    done.append((seq[1:-1], sc))
                elif len(hyps) < BEAM:
                    hyps.append((seq, sc))
            if not hyps or (done and max(h[1] for h in hyps) < max(d[1] for d in done)):
                break
        if not done:
            return draft
        best = max(done, key=lambda d: (1 - CTC_WEIGHT) * d[1] + CTC_WEIGHT * ctc_score(lp, d[0]))[0]
        if len(best) > GUARD * len(draft) or len(best) * GUARD < len(draft):
            return draft
        return best

    def _tokens(self, wav, beam):
        """[(token_text, first_frame, last_frame)] over the whole audio, frames counted from its start."""
        out = []
        for start, piece in split(wav):
            if len(piece) < 400:
                continue
            lp, enc = self.enc.run(None, {"wav": piece[None]})
            lp = lp[0]
            draft = greedy(lp)
            seq = self._beam(enc, lp, draft) if beam else draft
            seq = [t for t in seq if NSPECIAL <= t < len(self.vocab)]
            off = round(start / SAMPLE_RATE / FRAME_SEC)
            out += [(self.vocab[t], a + off, b + off) for t, (a, b) in zip(seq, align(lp, seq))]
        return out

    def recognize_array(self, audio, beam=True):
        """audio: 1-D float array of 16 kHz mono samples in [-1, 1].

        Returns {"text", "words"}; each word is {"text", "start", "end", "sp"} with times in
        seconds from the CTC alignment, and sp=True when a space preceded it in the text.
        """
        wav = np.asarray(audio, dtype=np.float32).flatten()
        if wav.size < 400:
            return {"text": "", "words": []}
        toks = self._tokens(wav, beam)

        # Runs = text between spaces, also broken at pauses (Khmer often omits spaces)
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

        # Words = each run split into dictionary words (khmercut), timed by their tokens
        words = []
        for run in runs:
            ts = run["toks"]
            text = "".join(t[0] for t in ts)
            pieces = [p for p in segment_words(text) if p.strip()]
            if "".join(pieces) != text:  # segmenter changed characters -> keep the run whole
                pieces = [text]
            owner = [k for k, t in enumerate(ts) for _ in t[0]]  # char offset -> token index
            pos = 0
            for n, p in enumerate(pieces):
                a, b = ts[owner[pos]][1], ts[owner[pos + len(p) - 1]][2]
                pos += len(p)
                words.append({"text": p, "start": round(a * FRAME_SEC, 3),
                              "end": round((b + 1) * FRAME_SEC, 3), "sp": run["sp"] and n == 0})
        return {"text": " ".join("".join(t[0] for t in toks).split()), "words": words}

    def transcribe_array(self, audio):
        return self.recognize_array(audio)["text"]
