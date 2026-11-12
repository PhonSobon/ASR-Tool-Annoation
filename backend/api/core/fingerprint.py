"""Acoustic fingerprints: find the same recording again, even converted to another format, louder or quieter, or cut
out of a longer recording (a clip that is part of a long upload).

Every 32 ms of 16 kHz audio gets one 32-bit sub-fingerprint (after Haitsma & Kalker, "A Highly Robust Audio
Fingerprinting System", ISMIR 2002): the energy of 33 bands between 300 and 3400 Hz in a 256 ms window, and one bit
per pair of neighbouring bands - does the energy difference between them grow or shrink from one window to the next.
Re-encoding and volume barely change these signs, so the same sound gives (almost) the same bits.

Finding a match: sub-fingerprints that are exactly equal give candidate alignments (recording, time offset); a
candidate is kept when the bits of the aligned windows mostly agree (bit error rate below BER_MATCH), second by
second, for at least MIN_SECONDS. Quiet windows (silence, pauses) have no fingerprint: they would match everywhere.
"""
import numpy as np

SR = 16000
FRAME = 4096                 # 256 ms window
HOP = 512                    # 32 ms between sub-fingerprints
FPS = SR / HOP               # sub-fingerprints per second (31.25)
BANDS = 33                   # -> 32 bits
F_LO, F_HI = 300, 3400       # telephone band: where speech is, robust to low-pass encoders
QUIET_DB = -50               # windows quieter than this (dBFS) are left out
BLOCK = 32                   # ~1 s: bit error rate is judged per block
BER_MATCH = 0.30             # different recordings are near 0.5, the same one converted well below 0.2
MIN_SECONDS = 3.0            # shorter shared sound is not reported
MAX_HITS = 64                # a sub-fingerprint value this common says nothing (skipped when voting)
FLIPS = np.concatenate([[0], 1 << np.arange(32, dtype=np.uint64)]).astype(np.uint32)   # no bit / one bit flipped


def _band_matrix():
    """rfft bins -> BANDS log-spaced bands between F_LO and F_HI"""
    freqs = np.fft.rfftfreq(FRAME, 1 / SR)
    edges = np.geomspace(F_LO, F_HI, BANDS + 1)
    m = np.zeros((len(freqs), BANDS), np.float32)
    for b in range(BANDS):
        m[(freqs >= edges[b]) & (freqs < edges[b + 1]), b] = 1
    return m


_BANDS = _band_matrix()
_WINDOW = np.hanning(FRAME).astype(np.float32)


def compute(pcm):
    """int16 (or float) mono samples at 16 kHz -> uint32 sub-fingerprints, 0 where the audio is quiet."""
    x = pcm.astype(np.float32) / (32768 if pcm.dtype == np.int16 else 1)
    n = 1 + (len(x) - FRAME) // HOP if len(x) >= FRAME else 0
    if n < 2:
        return np.zeros(0, np.uint32)
    windows = np.lib.stride_tricks.sliding_window_view(x, FRAME)[::HOP][:n]
    energy, loud = np.empty((n, BANDS), np.float32), np.empty(n, bool)
    for a in range(0, n, 1024):   # in parts: a long recording would need gigabytes at once
        w = windows[a:a + 1024]
        energy[a:a + 1024] = (np.abs(np.fft.rfft(w * _WINDOW, axis=1)) ** 2).astype(np.float32) @ _BANDS
        loud[a:a + 1024] = 10 * np.log10(np.mean(w * w, axis=1) + 1e-12) > QUIET_DB
    d = energy[:, :-1] - energy[:, 1:]                       # n x 32
    bits = (d[1:] - d[:-1]) > 0                              # (n-1) x 32
    fp = (bits.astype(np.uint64) << np.arange(32, dtype=np.uint64)).sum(axis=1).astype(np.uint32)
    fp[~(loud[1:] & loud[:-1])] = 0
    return fp


def _bit_errors(a, b):
    """bits that differ, per pair of sub-fingerprints"""
    return np.unpackbits((a ^ b).view(np.uint8).reshape(-1, 4), axis=1).sum(axis=1)


class Index:
    """Sub-fingerprints of many recordings, sorted for lookup. add() / remove() are cheap; the sorted arrays are
    rebuilt on the next search."""

    def __init__(self):
        self.fps, self._sorted = {}, None

    def add(self, key, fp):
        self.fps[key] = fp
        self._sorted = None

    def remove(self, key):
        if self.fps.pop(key, None) is not None:
            self._sorted = None

    def __contains__(self, key):
        return key in self.fps

    def _build(self):
        keys = list(self.fps)
        vals, who, at = [], [], []
        for i, k in enumerate(keys):
            fp = self.fps[k]
            idx = np.flatnonzero(fp)
            vals.append(fp[idx]); who.append(np.full(len(idx), i, np.int32)); at.append(idx.astype(np.int32))
        v = np.concatenate(vals) if vals else np.zeros(0, np.uint32)
        order = np.argsort(v, kind="stable")
        self._sorted = (keys, v[order], (np.concatenate(who) if who else np.zeros(0, np.int32))[order],
                        (np.concatenate(at) if at else np.zeros(0, np.int32))[order])

    def search(self, fp, skip=()):
        """Recordings that share at least MIN_SECONDS of sound with `fp`:
        [{key, seconds, start, ref_start, ber}] (start / ref_start: where the shared part begins, in seconds),
        the longest first. Keys in `skip` are left out."""
        if self._sorted is None:
            self._build()
        keys, vals, who, at = self._sorted
        q_idx = np.flatnonzero(fp)
        if not len(q_idx) or not len(vals):
            return []
        # each sub-fingerprint and its 32 one-bit variants: noise flips a bit or two, the alignment still gets votes
        q_val = (fp[q_idx][:, None] ^ FLIPS[None, :]).ravel()
        q_idx = np.repeat(q_idx, len(FLIPS))
        lo = np.searchsorted(vals, q_val, "left")
        hi = np.searchsorted(vals, q_val, "right")
        cnt = hi - lo
        keep = (cnt > 0) & (cnt <= MAX_HITS)
        if not keep.any():
            return []
        q_at, lo, cnt = q_idx[keep], lo[keep], cnt[keep]
        rep = np.repeat(np.arange(len(q_at)), cnt)
        pos = np.repeat(lo - np.cumsum(cnt) + cnt, cnt) + np.arange(cnt.sum())
        r_who, offset = who[pos], at[pos] - q_at[rep]       # ref frame = query frame + offset
        skip_i = {i for i, k in enumerate(keys) if k in skip}
        # vote per (recording, offset); a neighbouring offset is the same alignment (the windows start between hops)
        pairs, votes = np.unique(np.stack([r_who, offset], 1), axis=0, return_counts=True)
        need = max(3, int(MIN_SECONDS * FPS * 0.02))
        found = {}
        for (w, off), n in sorted(zip(map(tuple, pairs), votes), key=lambda p: -p[1]):
            if n < need:
                break
            if w in skip_i or (w in found and any(abs(off - o) < FPS for o in found[w]["_offs"])):
                continue
            hit = self._verify(fp, self.fps[keys[w]], int(off))
            if hit:
                best = found.get(w)
                if not best or hit["seconds"] > best["seconds"]:
                    found[w] = {"key": keys[w], **hit, "_offs": (best or {}).get("_offs", []) + [off]}
                else:
                    best["_offs"].append(off)
        out = [{k: v for k, v in f.items() if k != "_offs"} for f in found.values()]
        return sorted(out, key=lambda f: -f["seconds"])

    @staticmethod
    def _verify(q, r, off):
        """The longest run of ~1 s blocks where q (shifted by off) and r agree; None if under MIN_SECONDS."""
        a, b = max(0, -off), min(len(q), len(r) - off)      # query frames that overlap the reference
        if b - a < BLOCK:
            return None
        qs, rs = q[a:b], r[a + off:b + off]
        both = (qs != 0) & (rs != 0)
        err = np.where(both, _bit_errors(qs, rs), 0)
        nb = len(qs) // BLOCK
        e = err[:nb * BLOCK].reshape(nb, BLOCK).sum(1)
        m = both[:nb * BLOCK].reshape(nb, BLOCK).sum(1)
        good = (m >= BLOCK // 4) & (e <= BER_MATCH * 32 * np.maximum(m, 1))
        quiet = m < BLOCK // 4                               # a pause inside the shared part does not end it
        best, run, start, best_start, errs, best_errs, bits, best_bits = 0, 0, 0, 0, 0, 0, 0, 0
        for i in range(nb):
            if good[i] or (quiet[i] and run):
                if not run:
                    start, errs, bits = i, 0, 0
                run += 1; errs += e[i]; bits += 32 * m[i]
                if good[i] and run > best:
                    best, best_start, best_errs, best_bits = run, start, errs, bits
            else:
                run = 0
        seconds = best * BLOCK / FPS
        if seconds < MIN_SECONDS:
            return None
        q0 = a + best_start * BLOCK
        return {"seconds": round(seconds, 1), "start": round(q0 / FPS, 1), "ref_start": round((q0 + off) / FPS, 1),
                "ber": round(float(best_errs / max(best_bits, 1)), 3)}
