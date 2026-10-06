"""Khmer ASR Tool - upload audio, auto-cut into crops, transcribe each crop with Gemini."""
import base64
import io
import json
import os
import re
import shutil
import threading
import time
import unicodedata
import uuid
import zipfile

import requests
from flask import Flask, jsonify, render_template, request, send_file, send_from_directory
from pydub import AudioSegment

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CHUNK_DIR = os.path.join(BASE_DIR, "data", "chunks")
os.makedirs(CHUNK_DIR, exist_ok=True)

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_PROMPT = (
    "Transcribe this audio exactly as spoken, in {language}. "
    "Write in the native script of the language. "
    "Return ONLY the transcription text, with no explanation, no timestamps, no quotes. "
    "If there is no speech, return an empty response."
)

OMNI_REPO = "Darayut/Omnilingual-ASR-Khm"
OMNI_LOCAL_DIR = os.path.join(BASE_DIR, "models", "Omnilingual-ASR-Khm")  # model.safetensors + config.json + vocab.json
# Prefer the project's own copy; fall back to downloading from Hugging Face if it is missing
DEFAULT_OMNI_MODEL = os.environ.get(
    "OMNI_ASR_MODEL",
    OMNI_LOCAL_DIR if os.path.isfile(os.path.join(OMNI_LOCAL_DIR, "model.safetensors")) else OMNI_REPO,
)

_omni = {"source": None, "asr": None}
_omni_lock = threading.Lock()  # one inference at a time; model loaded once

app = Flask(__name__)


def omni_transcribe(wav_path, source):
    """Transcribe a WAV with the local Omnilingual-ASR-Khm CTC model (HF repo id or local folder).

    Returns {"text", "words"}; words carry CTC-aligned start/end times used by the cut editor.
    """
    from omni_asr import OmniASR

    with _omni_lock:
        if _omni["source"] != source:
            print(f"[Omni-ASR] loading {source}", flush=True)
            _omni.update(source=None, asr=None)
            _omni.update(asr=OmniASR(source), source=source)
        return _omni["asr"].recognize_file(wav_path)


app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024  # 1 GB upload limit


@app.route("/")
def index():
    return render_template("index.html", omni_model=DEFAULT_OMNI_MODEL)


@app.route("/upload", methods=["POST"])
def upload():
    """Receive audio file, cut it into fixed-length crops (16 kHz mono WAV)."""
    file = request.files.get("audio")
    if not file or not file.filename:
        return jsonify(error="No audio file uploaded"), 400
    chunk_sec = max(1, int(request.form.get("chunk_seconds", 30)))

    session_id = uuid.uuid4().hex[:12]
    session_dir = os.path.join(CHUNK_DIR, session_id)
    os.makedirs(session_dir)
    src_path = os.path.join(session_dir, "source" + os.path.splitext(file.filename)[1])
    file.save(src_path)

    try:
        audio = AudioSegment.from_file(src_path)
    except Exception as e:
        shutil.rmtree(session_dir, ignore_errors=True)
        return jsonify(error=f"Cannot read audio: {e}"), 400
    audio = audio.set_channels(1).set_frame_rate(16000)

    base_name = os.path.splitext(os.path.basename(file.filename))[0]
    step = chunk_sec * 1000
    crops = []
    for i, start in enumerate(range(0, len(audio), step), start=1):
        end = min(start + step, len(audio))
        if end - start < 300:  # skip tiny tail (< 0.3 s)
            continue
        name = f"{base_name}_crop_{i:04d}.wav"
        audio[start:end].export(os.path.join(session_dir, name), format="wav")
        crops.append({"index": i, "file": name, "start": start / 1000, "end": end / 1000})

    os.remove(src_path)
    return jsonify(session_id=session_id, name=base_name, duration=len(audio) / 1000, crops=crops)


@app.route("/chunks/<session_id>/<path:name>")
def chunk_file(session_id, name):
    return send_from_directory(os.path.join(CHUNK_DIR, session_id), name)


@app.route("/transcribe", methods=["POST"])
def transcribe():
    """Transcribe ONE crop (Local Omni-ASR or Gemini). Frontend calls this crop by crop."""
    data = request.get_json(force=True)
    engine = data.get("engine") or "omni"
    language = data.get("language") or "Khmer"

    path = os.path.join(CHUNK_DIR, os.path.basename(data.get("session_id", "")),
                        os.path.basename(data.get("file", "")))
    if not os.path.isfile(path):
        return jsonify(error="Crop file not found"), 404

    if engine == "omni":
        try:
            return jsonify(**omni_transcribe(path, (data.get("omni_model") or "").strip() or DEFAULT_OMNI_MODEL))
        except (OSError, ImportError) as e:  # missing files / bad repo id / missing torch
            return jsonify(error=f"Omni-ASR: {e}", fatal=True), 500
        except Exception as e:
            print(f"[Omni-ASR] error: {e}", flush=True)
            return jsonify(error=f"Omni-ASR: {e}"), 500

    api_key = (data.get("api_key") or "").strip()
    model = (data.get("model") or "gemini-2.5-flash").strip()
    prompt = (data.get("prompt") or DEFAULT_PROMPT).replace("{language}", language)
    if not api_key:
        return jsonify(error="Missing Gemini API key", fatal=True), 400

    with open(path, "rb") as f:
        audio_b64 = base64.b64encode(f.read()).decode()

    body = {
        "contents": [{
            "parts": [
                {"inline_data": {"mime_type": "audio/wav", "data": audio_b64}},
                {"text": prompt},
            ]
        }],
        "generationConfig": {"temperature": 0},
    }

    # Retry on rate-limit / server errors
    last_err = ""
    for attempt in range(4):
        try:
            r = requests.post(
                GEMINI_URL.format(model=model),
                headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
                json=body,
                timeout=180,
            )
        except requests.RequestException as e:
            last_err = str(e)
            time.sleep(2 ** attempt)
            continue
        if r.status_code == 200:
            res = r.json()
            try:
                parts = res["candidates"][0]["content"].get("parts", [])
                text = "".join(p.get("text", "") for p in parts).strip()
            except (KeyError, IndexError):
                text = ""
            return jsonify(text=text)
        try:
            last_err = r.json().get("error", {}).get("message", r.text)
        except ValueError:
            last_err = r.text
        print(f"[Gemini {r.status_code}] model={model}: {last_err}", flush=True)
        if r.status_code in (429, 500, 502, 503, 504):
            time.sleep(2 * (2 ** attempt))
            continue
        # 400/401/403/404 = bad key, wrong model name, etc. -> same for every crop, so stop the batch
        return jsonify(error=f"Gemini {r.status_code}: {last_err}", fatal=True), 502
    return jsonify(error=f"Gemini failed after retries: {last_err}"), 502


@app.route("/split", methods=["POST"])
def split():
    """Cut ONE crop into parts. segments = [{start, end}] in seconds relative to the crop.

    Returns crops = [{seg, file, start, end}] (seg = index into the request, times relative
    to the crop). The original crop file is left on disk; the frontend just stops listing it.
    """
    data = request.get_json(force=True)
    session_dir = os.path.join(CHUNK_DIR, os.path.basename(data.get("session_id", "")))
    name = os.path.basename(data.get("file", ""))
    src = os.path.join(session_dir, name)
    if not os.path.isfile(src):
        return jsonify(error="Crop file not found"), 404

    audio = AudioSegment.from_file(src)
    base = os.path.splitext(name)[0]
    crops = []
    for k, seg in enumerate(data.get("segments", [])):
        start = max(0, int(round(float(seg["start"]) * 1000)))
        end = min(len(audio), int(round(float(seg["end"]) * 1000)))
        if end - start < 100:  # skip slivers (< 0.1 s)
            continue
        part = f"{base}_{len(crops) + 1:02d}.wav"
        audio[start:end].export(os.path.join(session_dir, part), format="wav")
        crops.append({"seg": k, "file": part, "start": start / 1000, "end": end / 1000})
    if not crops:
        return jsonify(error="All parts are shorter than 0.1 s"), 400
    return jsonify(crops=crops)


@app.route("/models", methods=["POST"])
def list_models():
    """List Gemini models available to this API key (that support generateContent)."""
    api_key = (request.get_json(force=True).get("api_key") or "").strip()
    if not api_key:
        return jsonify(error="Missing Gemini API key"), 400
    models, page = [], None
    while True:
        params = {"pageSize": 1000}
        if page:
            params["pageToken"] = page
        r = requests.get("https://generativelanguage.googleapis.com/v1beta/models",
                         headers={"x-goog-api-key": api_key}, params=params, timeout=30)
        if r.status_code != 200:
            try:
                msg = r.json().get("error", {}).get("message", r.text)
            except ValueError:
                msg = r.text
            return jsonify(error=f"Gemini {r.status_code}: {msg}"), 502
        j = r.json()
        models += [m["name"].removeprefix("models/") for m in j.get("models", [])
                   if "generateContent" in m.get("supportedGenerationMethods", [])]
        page = j.get("nextPageToken")
        if not page:
            break
    return jsonify(models=sorted(models, reverse=True))


def segment_text(text):
    """Khmer word segmentation with khmercut: words joined by single spaces."""
    from khmercut import tokenize

    return " ".join(t for t in tokenize(text) if t.strip()) if text.strip() else ""


@app.route("/segment", methods=["POST"])
def segment():
    """Word-segment the given text (preview under each crop)."""
    try:
        return jsonify(segmented=segment_text(request.get_json(force=True).get("text") or ""))
    except ImportError:
        return jsonify(error="khmercut is not installed (pip install khmercut)"), 500


@app.route("/export", methods=["POST"])
def export():
    """Download ZIP with one folder: <name>/wavs/*.wav + <name>/metadata.json (all crops)."""
    data = request.get_json(force=True)
    session_dir = os.path.join(CHUNK_DIR, os.path.basename(data.get("session_id", "")))
    if not os.path.isdir(session_dir):
        return jsonify(error="Session not found"), 404

    # folder name = uploaded file's name, made safe for every OS (Khmer letters are kept)
    name = "".join(ch if ch.isalnum() or ch in "-_" or unicodedata.category(ch).startswith("M") else "_"
                   for ch in data.get("name") or "")
    name = re.sub(r"_+", "_", name).strip("_") or f"asr_{data['session_id']}"
    try:
        from khmercut import tokenize  # noqa: F401
        seg = segment_text
    except ImportError:
        seg = None

    items, zip_buf = [], io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as z:
        for c in data.get("crops", []):
            fname = os.path.basename(c["file"])
            p = os.path.join(session_dir, fname)
            if not os.path.isfile(p):
                continue
            z.write(p, arcname=f"{name}/wavs/{fname}")
            text = (c.get("text") or "").strip()
            start, end = float(c["start"]), float(c["end"])
            item = {"id": os.path.splitext(fname)[0], "file": f"wavs/{fname}",
                    "start": round(start, 3), "end": round(end, 3), "duration": round(end - start, 3),
                    "text": text}
            if seg:
                item["text_segmented"] = seg(text)
            items.append(item)
        z.writestr(f"{name}/metadata.json", json.dumps(items, ensure_ascii=False, indent=2))
    zip_buf.seek(0)
    return send_file(zip_buf, mimetype="application/zip", as_attachment=True, download_name=f"{name}.zip")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
