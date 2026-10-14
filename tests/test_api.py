import base64
import io
import json
import zipfile

from backend.services import recognizer
from conftest import upload


def test_index_page(client):
    r = client.get("/")
    assert r.status_code == 200
    assert b"Data Annotation Platform" in r.data
    assert b"js/main.js" in r.data


# ---------- Upload & Crop ----------
def test_upload_is_not_cut_yet(clip):
    assert clip["name"] == "news" and round(clip["duration"]) == 12
    assert clip["task_id"] is None
    assert [(s["start"], s["end"]) for s in clip["segments"]] == [(0, 12)]


def test_upload_without_file(client):
    r = client.post("/api/audios", data={}, content_type="multipart/form-data")
    assert r.status_code == 400 and "error" in r.json


def test_upload_several_files_lists_drafts(client):
    upload(client, "a.wav")
    upload(client, "b.wav", 3)
    assert sorted(a["name"] for a in client.get("/api/audios").json["audios"]) == ["a", "b"]


def test_recut_saves_segments(client, clip):
    r = client.post(f"/api/audios/{clip['id']}/recut", json={"chunk_seconds": 5})
    assert [(s["start"], s["end"]) for s in r.json["segments"]] == [(0, 5), (5, 10), (10, 12)]
    again = client.get(f"/api/audios/{clip['id']}").json
    assert again["chunk_seconds"] == 5 and len(again["segments"]) == 3


def test_autosave_round_trip(client, clip):
    segments = [{"id": 1, "start": 0, "end": 6, "text": "សួស្តី", "state": "done"},
                {"id": 2, "start": 6, "end": 12, "text": "", "state": "pending", "deleted": False}]
    assert client.put(f"/api/audios/{clip['id']}/state", json={"segments": segments}).status_code == 200
    a = client.get(f"/api/audios/{clip['id']}").json
    assert a["segments"] == segments and (a["count"], a["done"], a["todo"]) == (2, 1, 1)


def test_unknown_audio_is_404(client):
    for url in ("/api/audios/nope", "/api/audios/nope/peaks", "/api/audios/nope/audio", "/api/tasks/nope"):
        r = client.get(url)
        assert r.status_code == 404 and "error" in r.json, url


def test_peaks_full_and_thumbnail(client, clip):
    p = client.get(f"/api/audios/{clip['id']}/peaks").json
    assert p["rate"] == 200 and round(p["duration"]) == 12
    thumb = client.get(f"/api/audios/{clip['id']}/peaks?buckets=120").json
    assert len(base64.b64decode(thumb["peaks"])) == 240  # 120 min/max pairs of int8
    a = client.get(f"/api/audios/{clip['id']}/audio")
    assert a.status_code == 200 and a.mimetype == "audio/wav"
    a.close()


def test_delete_draft(client, clip):
    assert client.delete(f"/api/audios/{clip['id']}").status_code == 200
    assert client.get("/api/audios").json["audios"] == []


# ---------- Push to task ----------
def test_push_moves_audio_into_a_task(client):
    a, b = upload(client, "a.wav"), upload(client, "b.wav", 3)
    client.post(f"/api/audios/{a['id']}/recut", json={"chunk_seconds": 5})
    r = client.post("/api/tasks", json={"name": "Batch 1", "audio_ids": [a["id"], b["id"]]})
    assert r.status_code == 201
    task = r.json
    assert (task["name"], task["audio_count"], task["count"], task["todo"]) == ("Batch 1", 2, 4, 4)

    assert client.get("/api/audios").json["audios"] == []                       # gone from Upload & Crop
    assert [t["id"] for t in client.get("/api/tasks").json["tasks"]] == [task["id"]]
    detail = client.get(f"/api/tasks/{task['id']}").json
    assert sorted(x["name"] for x in detail["audios"]) == ["a", "b"]
    assert sorted(len(x["segments"]) for x in detail["audios"]) == [1, 3]   # the crops of each audio
    assert len(client.get(f"/api/audios?task={task['id']}").json["audios"]) == 2


def test_push_needs_audio(client, clip):
    assert client.post("/api/tasks", json={"name": "x", "audio_ids": []}).status_code == 400
    client.post("/api/tasks", json={"audio_ids": [clip["id"]]})
    assert client.post("/api/tasks", json={"audio_ids": [clip["id"]]}).status_code == 400  # already pushed


def test_delete_task_removes_its_audio(client, clip):
    task = client.post("/api/tasks", json={"audio_ids": [clip["id"]]}).json
    assert client.delete(f"/api/tasks/{task['id']}").status_code == 200
    assert client.get("/api/tasks").json["tasks"] == []
    assert client.get(f"/api/audios/{clip['id']}").status_code == 404


# ---------- Annotate ----------
def test_transcribe_returns_absolute_word_times(client, clip, monkeypatch):
    monkeypatch.setattr(recognizer, "recognize", lambda audio, model: {
        "text": "សួស្តី", "words": [{"text": "សួស្តី", "start": 0.5, "end": 1.0, "sp": False}]})
    r = client.post(f"/api/audios/{clip['id']}/transcribe", json={"start": 5, "end": 10})
    assert r.status_code == 200 and r.json["words"][0]["start"] == 5.5


def test_normalize(client):
    assert client.post("/api/text/normalize", json={"text": "លេខ ១២"}).json["normalized"].endswith("12")


def test_export_audio_zip(client, clip):
    segments = [{"start": 0, "end": 5, "role": "Narrator", "text": "a", "normalized": "a"},
                {"start": 5, "end": 5.05, "text": "too short"}]
    r = client.post(f"/api/audios/{clip['id']}/export", json={"name": "news", "segments": segments})
    z = zipfile.ZipFile(io.BytesIO(r.data))
    assert sorted(z.namelist()) == ["news/metadata.json", "news/wavs/news_0001.wav"]
    meta = json.loads(z.read("news/metadata.json"))
    assert meta[0]["duration"] == 5.0 and meta[0]["role"] == "Narrator"


def test_export_task_zip(client):
    a, b = upload(client, "same.wav"), upload(client, "same.wav", 3)
    client.put(f"/api/audios/{a['id']}/state", json={"segments": [
        {"start": 0, "end": 4, "text": "x", "norm": "x", "role": "Guest"},
        {"start": 4, "end": 12, "text": "noise", "deleted": True}]})
    task = client.post("/api/tasks", json={"name": "My batch", "audio_ids": [a["id"], b["id"]]}).json
    r = client.get(f"/api/tasks/{task['id']}/export")
    assert r.status_code == 200
    names = sorted(zipfile.ZipFile(io.BytesIO(r.data)).namelist())
    assert names == ["My_batch/same/metadata.json", "My_batch/same/wavs/same_0001.wav",
                     "My_batch/same_2/metadata.json", "My_batch/same_2/wavs/same_2_0001.wav"]


def test_push_only_chosen_audio(client):
    cut, *rest = [upload(client, f"a{k}.wav") for k in range(5)]
    client.post(f"/api/audios/{cut['id']}/recut", json={"chunk_seconds": 2})
    task = client.post("/api/tasks", json={"name": "Task 1", "audio_ids": [cut["id"]]}).json
    assert (task["audio_count"], task["count"]) == (1, 6)
    assert sorted(a["id"] for a in client.get("/api/audios").json["audios"]) == sorted(a["id"] for a in rest)


def test_export_dialogue_segments_with_speaker_and_audio_info(client):
    a = upload(client, "talk.wav")
    info = {"language": "Khmer", "accent": "Phnom Penh", "domain": "EDU_GOV", "style": "Read"}
    client.put(f"/api/audios/{a['id']}/state", json={"segments": [
        {"start": 0, "end": 6, "text": "a b", "info": info,
         "speakers": {"Journalist": {"age": "18-35", "gender": "Male", "native": "Yes"}},
         "parts": [{"start": 0, "end": 2, "role": "Journalist", "text": "a", "norm": "a"},
                   {"start": 2, "end": 4, "role": "Guest", "text": "b"},
                   {"start": 4, "end": 6, "role": "Guest", "text": "noise", "deleted": True}]},
        {"start": 6, "end": 12, "text": "c", "role": "Narrator"}]})
    task = client.post("/api/tasks", json={"name": "T", "audio_ids": [a["id"]]}).json
    z = zipfile.ZipFile(io.BytesIO(client.get(f"/api/tasks/{task['id']}/export").data))
    meta = json.loads(z.read("T/talk/metadata.json"))
    assert [m["id"] for m in meta] == ["talk_0001_01", "talk_0001_02", "talk_0002"]
    assert "T/talk/wavs/talk_0001_02.wav" in z.namelist()
    assert meta[0]["speaker"] == {"age": "18-35", "gender": "Male", "native": "Yes"}
    assert meta[0]["audio_info"]["accent"] == "Phnom Penh" and "speaker" not in meta[1]
    assert meta[2]["role"] == "Narrator" and meta[2]["duration"] == 6.0


def test_me_uses_computer_user_or_setting(client, app):
    assert client.get("/api/me").json["name"]
    app.config["ANNOTATOR_NAME"] = "Sobon"
    assert client.get("/api/me").json["name"] == "Sobon"
