import io
import wave

import numpy as np
import pytest

from backend import create_app

SR = 16000


@pytest.fixture
def app(tmp_path):
    return create_app({"TESTING": True, "AUDIO_DIR": str(tmp_path / "audio"), "TASKS_DIR": str(tmp_path / "tasks")})


@pytest.fixture
def client(app):
    return app.test_client()


def make_wav(seconds=12.0, sr=SR):
    """A 440 Hz tone as WAV bytes."""
    t = np.arange(int(seconds * sr)) / sr
    pcm = (np.sin(2 * np.pi * 440 * t) * 8000).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def upload(client, name="news.wav", seconds=12.0):
    r = client.post("/api/audios", data={"audio": (io.BytesIO(make_wav(seconds)), name)},
                    content_type="multipart/form-data")
    assert r.status_code == 201, r.json
    return r.json


@pytest.fixture
def clip(client):
    """An uploaded 12 s audio, still in Upload & Crop (not cut yet)."""
    return upload(client)
