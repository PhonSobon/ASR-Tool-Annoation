import io
import wave

import numpy as np
import pytest

from api import create_app

SR = 16000


ADMIN = ("admin", "Chief#Key12")
DEFAULT_PASSWORD = "Default#123"   # what the admin gives a new user
PASSWORD = "Secret#123"           # what the users made by add_user chose at their first sign-in


@pytest.fixture(autouse=True)
def no_hub(monkeypatch):
    """Tests never ask the Hugging Face Hub for a dataset's commit."""
    from api.core import hub
    monkeypatch.setattr(hub, "dataset_sha", lambda *a, **k: None)


@pytest.fixture
def app(tmp_path):
    return create_app(app_config(tmp_path, ADMIN_USERNAME=ADMIN[0], ADMIN_PASSWORD=ADMIN[1]))


def app_config(tmp_path, **kw):
    """A fresh SQLite database and data folders per test (TEST_DATABASE_URL: run the tests on PostgreSQL)."""
    import os

    from api.config import database_url

    url = os.environ.get("TEST_DATABASE_URL")
    if url:   # one PostgreSQL database for every test: start each test with empty tables
        from sqlalchemy import create_engine

        from api.core.db import Base

        engine = create_engine(database_url(url, ""))
        Base.metadata.drop_all(engine)
        engine.dispose()
    return {"TESTING": True, "SECRET_KEY": "test", "AUDIO_DIR": str(tmp_path / "audio"),
            "DATASETS_DIR": str(tmp_path / "datasets"), "TASKS_DIR": str(tmp_path / "tasks"),
            "USERS_FILE": str(tmp_path / "users.json"),
            "DATABASE_URL": database_url(url, "") if url else "sqlite:///" + (tmp_path / "app.db").as_posix(), **kw}


def login(client, username, password=PASSWORD):
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.json
    return client


@pytest.fixture
def client(app):
    """Logged in as the administrator."""
    return login(app.test_client(), *ADMIN)


@pytest.fixture
def anon(app):
    """Not logged in."""
    return app.test_client()


@pytest.fixture
def add_user(app, client):
    """add_user("ana", "annotator") -> a new test client logged in as that user, who has chosen PASSWORD."""
    def make(username, role):
        r = client.post("/api/users", json={"username": username, "password": DEFAULT_PASSWORD, "role": role})
        assert r.status_code == 201, r.json
        c = login(app.test_client(), username, DEFAULT_PASSWORD)
        if role != "admin":
            r = c.post("/api/auth/password", json={"current": DEFAULT_PASSWORD, "new": PASSWORD})
            assert r.status_code == 200, r.json
        return c
    return make


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
