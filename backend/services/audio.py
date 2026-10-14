"""Audio helpers: convert uploads, read/cut 16 kHz PCM, waveform peaks, WAV encoding."""
import base64
import io
import threading
import wave

import numpy as np

_cache = {"path": None, "pcm": None}  # the last task's samples stay in memory
_lock = threading.Lock()


def convert_to_wav(src, dst, sr):
    """Any audio/video file (via pydub + FFmpeg) -> mono 16-bit WAV at `sr`. Returns the duration in seconds."""
    from pydub import AudioSegment

    seg = AudioSegment.from_file(src)
    seg.set_channels(1).set_frame_rate(sr).set_sample_width(2).export(dst, format="wav")
    return len(seg) / 1000


def load_pcm(path):
    """int16 samples of a WAV file (cached for the most recently used file)."""
    with _lock:
        if _cache["path"] != path:
            with wave.open(path, "rb") as w:
                pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
            _cache.update(path=path, pcm=pcm)
        return _cache["pcm"]


def forget(path):
    with _lock:
        if _cache["path"] == path:
            _cache.update(path=None, pcm=None)


def clip(pcm, start, end, sr):
    a = max(0, int(round(float(start) * sr)))
    b = min(len(pcm), int(round(float(end) * sr)))
    return pcm[a:max(a, b)]


def peaks(pcm, per):
    """Waveform overview: interleaved min/max int8 pairs, one pair per `per` samples, base64."""
    per = max(1, int(per))
    n = -(-len(pcm) // per)
    blocks = np.zeros(n * per, np.int16)
    blocks[:len(pcm)] = pcm
    blocks = blocks.reshape(n, per)
    mm = np.stack([blocks.min(1), blocks.max(1)], 1).astype(np.int32) * 127 // 32767
    return base64.b64encode(mm.astype(np.int8).tobytes()).decode()


def wav_bytes(pcm, sr):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()
