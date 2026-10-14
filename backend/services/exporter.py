"""Dataset export: ZIP with <name>/wavs/*.wav + <name>/metadata.json (one item per segment)."""
import io
import json
import os
import re
import unicodedata
import zipfile

from . import audio
from .text import normalize_text


def safe_name(name, fallback):
    """Folder name safe for every OS (Khmer letters and their combining marks are kept)."""
    name = "".join(ch if ch.isalnum() or ch in "-_" or unicodedata.category(ch).startswith("M") else "_"
                   for ch in name or "")
    return re.sub(r"_+", "_", name).strip("_") or fallback


def from_saved(segments, name):
    """Crops as saved in state.json -> export segments (skipped ones left out).

    A crop cut into dialogue segments ("parts") gives one clip per part: <name>_0003_01, <name>_0003_02, ...
    Each clip carries its speaker's details (by role) and the crop's overall audio information.
    """
    out = []
    for no, crop in enumerate(segments, 1):
        if crop.get("deleted"):
            continue
        parts = [p for p in (crop.get("parts") or [crop]) if not p.get("deleted")]
        for k, p in enumerate(parts, 1):
            role = (p.get("role") or "").strip()
            out.append({"id": f"{name}_{no:04d}" + (f"_{k:02d}" if len(parts) > 1 else ""),
                        "start": p["start"], "end": p["end"], "role": role, "text": p.get("text"),
                        "normalized": p.get("norm"), "speaker": (crop.get("speakers") or {}).get(role),
                        "audio_info": crop.get("info")})
    return out


def _write_audio(z, folder, name, pcm, sr, segments, min_seconds):
    """<folder>/wavs/<name>_0001.wav ... + <folder>/metadata.json"""
    items = []
    for s in segments:
        part = audio.clip(pcm, s["start"], s["end"], sr)
        if len(part) < sr * min_seconds:  # skip slivers
            continue
        fname = f"{s.get('id') or f'{name}_{len(items) + 1:04d}'}.wav"
        z.writestr(f"{folder}/wavs/{fname}", audio.wav_bytes(part, sr))
        text = (s.get("text") or "").strip()
        items.append({"id": os.path.splitext(fname)[0], "file": f"wavs/{fname}",
                      "start": round(float(s["start"]), 3), "end": round(float(s["end"]), 3),
                      "duration": round(len(part) / sr, 3), "role": (s.get("role") or "").strip(),
                      "text": text,
                      "text_normalized": (s.get("normalized") or "").strip() or normalize_text(text),
                      **{k: s[k] for k in ("speaker", "audio_info") if s.get(k)}})
    z.writestr(f"{folder}/metadata.json", json.dumps(items, ensure_ascii=False, indent=2))


def build_zip(pcm, sr, name, segments, min_seconds=0.1):
    """One audio: <name>/wavs + <name>/metadata.json. Returns a BytesIO positioned at 0."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        _write_audio(z, name, name, pcm, sr, segments, min_seconds)
    buf.seek(0)
    return buf


def build_task_zip(task_name, items, sr, min_seconds=0.1):
    """A task: <task>/<audio>/wavs + metadata.json for every audio.
    `items` yields (audio name, pcm, export segments)."""
    buf, used = io.BytesIO(), set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, pcm, segments in items:
            base, n = name, 2
            while name in used:  # two audio with the same file name
                name, n = f"{base}_{n}", n + 1
            used.add(name)
            if name != base:  # clip ids follow the renamed folder
                segments = [{**s, "id": name + s["id"][len(base):]} if s.get("id", "").startswith(base) else s
                            for s in segments]
            _write_audio(z, f"{task_name}/{name}", name, pcm, sr, segments, min_seconds)
    buf.seek(0)
    return buf


def build_dataset_zip(name, rows, sr):
    """A cleaned Hub dataset: <name>/wavs/<clip id>.wav + <name>/metadata.json.
    `rows` yields (clip id, pcm, record) from services.datasets.output_rows."""
    buf, items = io.BytesIO(), []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for clip_id, pcm, rec in rows:
            z.writestr(f"{name}/wavs/{clip_id}.wav", audio.wav_bytes(pcm, sr))
            items.append({**rec["extra"], "id": clip_id, "file": f"wavs/{clip_id}.wav", "duration": rec["duration"],
                          "text": rec["text"], "text_normalized": rec["norm"],
                          "original_text": rec["original_text"], "asr_text": rec["asr_text"], "cer": rec["cer"],
                          "status": rec["status"], **({"reason": rec["reason"]} if rec["reason"] else {}),
                          "flags": rec["flags"], "source_index": rec["source_index"],
                          **({"part": rec["part"]} if rec["part"] else {})})
        z.writestr(f"{name}/metadata.json", json.dumps(items, ensure_ascii=False, indent=2))
    buf.seek(0)
    return buf
