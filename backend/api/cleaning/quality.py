"""Automatic quality checks for dataset cleaning: CER against the ASR, text and audio flags, one category per clip.

Category: "pass" (ASR agrees, nothing wrong found), "review" (look at it), "bad" (very likely wrong),
"unchecked" (the ASR has not run yet and nothing is clearly wrong).
"""
import re
import statistics
import unicodedata

import numpy as np

DIGITS = re.compile(r"[0-9០-៩]")
LATIN = re.compile(r"[A-Za-z]")
KHMER = re.compile(r"[ក-៿᧠-᧿]")
PUNCT = set("។៕៖?!,.()[]«»\"'“”‘’-–—:;…")
ZERO_WIDTH = "​‌‍﻿"

# flag -> (severity, explanation). "bad" flags make the clip likely bad, "warn" ones keep it out of auto-pass,
# "info" ones are only shown.
FLAGS = {
    "empty_text": ("bad", "No transcription"),
    "no_speech": ("bad", "Almost no speech in the audio"),
    "too_short": ("bad", "Clip is too short"),
    "dup_audio": ("bad", "Exactly the same audio as an earlier clip"),
    "asr_empty": ("bad", "The ASR heard no speech"),
    "too_long": ("warn", "Clip is too long for training"),
    "digits": ("warn", "Digits in the text - write numbers as they are spoken"),
    "latin": ("warn", "Latin letters in the text"),
    "symbols": ("warn", "Symbols or characters from other scripts in the text"),
    "clipping": ("warn", "Audio is clipped (distorted)"),
    "quiet": ("warn", "Audio is very quiet"),
    "rate": ("warn", "Unusual speaking rate for the text length - text may be cut off or too long"),
    "long_silence": ("info", "Long silence at the start or end (can be trimmed)"),
    "dup_text": ("info", "The same text appears in other clips"),
}


def text_key(text):
    """What is compared: letters, marks and digits only (no spaces, zero-width spaces or punctuation)."""
    return "".join(ch for ch in (text or "").lower() if ch.isalnum() or unicodedata.category(ch).startswith("M"))


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer(ref, hyp):
    """Character error rate of `hyp` (ASR) against `ref` (dataset text), ignoring spaces and punctuation."""
    r, h = text_key(ref), text_key(hyp)
    if not r:
        return 0.0 if not h else 1.0
    return round(edit_distance(r, h) / len(r), 4)


def text_flags(text):
    t = text or ""
    if not text_key(t):
        return ["empty_text"]
    flags = []
    if DIGITS.search(t):
        flags.append("digits")
    if LATIN.search(t):
        flags.append("latin")
    if any(not (KHMER.match(ch) or ch.isspace() or ch in ZERO_WIDTH or ch in PUNCT or ch.isdigit() or LATIN.match(ch))
           for ch in t):
        flags.append("symbols")
    return flags


def audio_stats(x, sr, frame_sec=0.02):
    """Loudness facts about float samples in [-1, 1]: peak, clipped share, voiced share and where speech starts/ends."""
    duration = len(x) / sr
    frame = max(1, int(sr * frame_sec))
    n = len(x) // frame
    if n == 0:
        return {"peak": 0.0, "clipped": 0.0, "voiced": 0.0, "speech_start": 0.0, "speech_end": round(duration, 3)}
    frames = x[:n * frame].reshape(n, frame)
    db = 20 * np.log10(np.sqrt((frames.astype(np.float64) ** 2).mean(1)) + 1e-9)
    voiced = db > max(db.max() - 35, -55)  # quieter than this = silence
    idx = np.flatnonzero(voiced)
    return {"peak": round(float(np.abs(x).max()), 4),
            "clipped": round(float((np.abs(x) >= 0.999).mean()), 5),
            "voiced": round(float(voiced.mean()), 3),
            "speech_start": round(idx[0] * frame_sec, 3) if idx.size else 0.0,
            "speech_end": round(min(duration, (idx[-1] + 1) * frame_sec), 3) if idx.size else round(duration, 3)}


def audio_flags(item, cfg):
    """Flags of the part of the clip that is kept (its trim, or the whole clip)."""
    a = item.get("audio") or {}
    start, end = item.get("trim") or (0, item["duration"])
    d = end - start
    flags = []
    if d < cfg["MIN_CLIP_SECONDS"]:
        flags.append("too_short")
    if d > cfg["MAX_CLIP_SECONDS"]:
        flags.append("too_long")
    if a.get("voiced", 1) < 0.1:
        flags.append("no_speech")
    if a.get("clipped", 0) > 0.001:
        flags.append("clipping")
    if a.get("peak", 1) < 0.05:
        flags.append("quiet")
    if a.get("speech_start", start) - start > cfg["SILENCE_SECONDS"] or end - a.get("speech_end", end) > cfg["SILENCE_SECONDS"]:
        flags.append("long_silence")
    return flags


def speech_rate(item):
    """Characters per second of speech (the silence at both ends left out)."""
    a = item.get("audio") or {}
    speech = max(0.1, a.get("speech_end", item["duration"]) - a.get("speech_start", 0))
    return len(text_key(item.get("text"))) / speech


def categorize(item, cfg):
    severity = {FLAGS[f][0] for f in item["flags"]}
    c = item.get("cer")
    if "bad" in severity or (c is not None and c > cfg["CER_BAD"]):
        return "bad"
    if c is None:
        return "review" if "warn" in severity else "unchecked"
    return "pass" if c <= cfg["CER_PASS"] and "warn" not in severity else "review"


def refresh(items, cfg):
    """Recompute every item's flags and category (duplicates and speaking rate depend on the whole dataset)."""
    texts, hashes = {}, {}
    for it in items:
        texts[text_key(it.get("text"))] = texts.get(text_key(it.get("text")), 0) + 1
    rates = [speech_rate(it) for it in items if text_key(it.get("text"))]
    median = statistics.median(rates) if len(rates) >= 20 else None
    for it in items:
        flags = text_flags(it.get("text")) + audio_flags(it, cfg)
        if it.get("asr_text") is not None and not text_key(it["asr_text"]):
            flags.append("asr_empty")
        if median and text_key(it.get("text")) and not median / 2 <= speech_rate(it) <= median * 2:
            flags.append("rate")
        if it.get("md5"):
            if it["md5"] in hashes:
                flags.append("dup_audio")
            hashes.setdefault(it["md5"], it["idx"])
        if text_key(it.get("text")) and texts[text_key(it.get("text"))] > 1:
            flags.append("dup_text")
        it["flags"] = flags
        it["category"] = categorize(it, cfg)
    return items
