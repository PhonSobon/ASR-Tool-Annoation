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
    segments = [{"id": 1, "start": 0, "end": 6, "text": "សួស្តី", "state": "done", "completed": True},
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


def _wait(client, url):
    import time

    for _ in range(200):
        job = client.get(url).json["job"]
        if not job["running"]:
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_push_task_to_hub(client, monkeypatch):
    from pathlib import Path

    import pyarrow.parquet as pq

    from backend.services import hub

    a = upload(client, "talk.wav")
    info = {"language": "Khmer", "accent": "Phnom Penh", "challenges": ["Noise", "Fast"]}
    client.put(f"/api/audios/{a['id']}/state", json={"segments": [
        {"start": 0, "end": 4, "completed": True, "info": info, "speakers": {"Journalist": {"age": "18-35", "gender": "Male"}},
         "parts": [{"start": 0, "end": 2, "role": "Journalist", "text": "លេខ ១០", "norm": ""},
                   {"start": 2, "end": 4, "role": "Guest", "text": "b", "norm": "b!"}]},
        {"start": 4, "end": 8, "parts": [{"start": 4, "end": 6, "role": "Guest", "text": "c"},
                                         {"start": 6, "end": 8, "role": "Guest", "text": ""}]},   # not completed
        {"start": 8, "end": 10, "parts": [{"start": 8, "end": 10, "role": "Guest", "text": "d"}]},  # text, not checked yet
        {"start": 10, "end": 12, "text": "skipped", "deleted": True}]})
    task = client.post("/api/tasks", json={"name": "T", "audio_ids": [a["id"]]}).json
    pushed = {}

    def fake_push(folder, repo_id, split, card_fn, token, private, create_pr, message, prefix=None):
        assert prefix == f"{split}-task-{task['id']}"   # its own files: other tasks in the repo stay
        pushed.update(table=pq.read_table(next(Path(folder, "data").glob(f"{prefix}-00000-of-00001.parquet"))),
                      card=card_fn("", {split}), repo=repo_id)
        return "https://huggingface.co/datasets/me/t/commit/1"

    monkeypatch.setattr(hub, "push", fake_push)
    url = f"/api/tasks/{task['id']}"
    assert client.post(f"{url}/hub-push", json={"repo_id": "not a repo"}).status_code == 400
    r = client.post(f"{url}/hub-push", json={"repo_id": "me/t"})
    assert r.status_code == 400 and "token" in r.json["error"]   # a private repo needs the token
    assert client.post(f"{url}/hub-push", json={"repo_id": "me/t", "token": "hf_x"}).status_code == 200
    job = _wait(client, f"{url}/job")
    assert job["error"] is None and job["result"]["url"].endswith("/commit/1")
    rows = pushed["table"].to_pylist()
    assert [r["id"] for r in rows] == ["talk_0001_01", "talk_0001_02"]
    assert "10" in rows[0]["text_normalized"] and rows[1]["text_normalized"] == "b!"
    assert (rows[0]["role"], rows[0]["speaker_gender"], rows[0]["accent"], rows[0]["challenges"]) == \
        ("Journalist", "Male", "Phnom Penh", "Noise, Fast")
    assert rows[1]["speaker_gender"] is None and rows[0]["duration"] == 2.0 and rows[0]["source_audio"] == "talk"
    assert rows[0]["audio"]["bytes"][:4] == b"RIFF" and "| task T | train | 2 |" in pushed["card"]
    assert rows[0]["task"] == "T"
    assert client.get(url).json["last_push"]["repo"] == "me/t"

    assert (client.get(url).json["done"], client.get(url).json["todo"]) == (2, 2)   # done = completed or skipped
    client.post(f"{url}/hub-push", json={"repo_id": "me/t", "include": "with_text", "split": "test", "private": False})
    _wait(client, f"{url}/job")
    assert [r["id"] for r in pushed["table"].to_pylist()] == ["talk_0001_01", "talk_0001_02", "talk_0002_01", "talk_0003"]
