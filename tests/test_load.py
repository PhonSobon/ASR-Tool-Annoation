"""Load Data: a local folder or a Hugging Face dataset (Hub mocked) goes straight into a task, one package per clip
with its text filled in."""
import io
import json
import time

import pytest

from backend.core import hub
from conftest import make_wav

TEXTS = ["សួស្តី ពិភពលោក", "លេខ ១០ ម៉ែត្រ", "អរគុណ"]


def send(client, task_id, files):
    """files: [(path, bytes, text)] -> POST /api/tasks/<id>/files"""
    return client.post(f"/api/tasks/{task_id}/files", content_type="multipart/form-data", data={
        "audio": [(io.BytesIO(data), path.split("/")[-1]) for path, data, _ in files],
        "names": json.dumps([p for p, _, _ in files]), "texts": json.dumps([t for _, _, t in files])})


def wait_job(client, task_id):
    for _ in range(200):
        job = client.get(f"/api/tasks/{task_id}/job").json["job"]
        if job and not job["running"]:
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_local_folder_becomes_a_task(client):
    r = client.post("/api/tasks/load/local", json={"name": "News folder"})
    assert r.status_code == 201, r.json
    task_id = r.json["id"]
    assert r.json["source"]["kind"] == "local" and r.json["source"]["state"] == "loading"
    r = send(client, task_id, [("wavs/a.wav", make_wav(1.0, sr=22050), TEXTS[0]), ("wavs/b.wav", make_wav(2.0), TEXTS[1])])
    assert r.status_code == 200 and r.json["added"] == 2 and r.json["count"] == 2
    r = send(client, task_id, [("wavs/b.wav", make_wav(2.0), TEXTS[1]), ("wavs/c.wav", make_wav(1.5), TEXTS[2]),
                               ("wavs/bad.wav", b"not audio", "x"), ("notes.pdf", b"%PDF", "x")])
    assert r.json["added"] == 1 and r.json["skipped"] == ["wavs/b.wav"]
    assert [f["file"] for f in r.json["failed"]] == ["wavs/bad.wav", "notes.pdf"]
    r = client.post(f"/api/tasks/{task_id}/finish")
    assert r.status_code == 200 and r.json["source"]["state"] == "ready" and r.json["source"]["failed"] == 2

    task = client.get(f"/api/tasks/{task_id}").json
    assert [a["name"] for a in task["audios"]] == ["a", "b", "c"] and task["count"] == 3
    crop = task["audios"][1]["segments"][0]
    assert crop["imported"] and crop["start"] == 0 and crop["end"] == 2.0 and not crop.get("completed")
    part = crop["parts"][0]
    assert part["text"] == TEXTS[1] and part["state"] == "done" and part["wordsText"] is None   # typed, not recognized
    assert "".join(part["norm"].split()) == "លេខ10ម៉ែត្រ"                                         # normalized already
    assert task["stages"]["annotating"] == 3                                                    # all in Todo

    # the annotator checks it and presses Complete -> inspection, like any package
    crop["completed"] = True
    r = client.put(f"/api/audios/{task['audios'][1]['id']}/state", json={"segments": task["audios"][1]["segments"]})
    assert r.status_code == 200, r.json
    assert client.get(f"/api/tasks/{task_id}").json["stages"]["inspecting"] == 1


def test_local_load_errors(client, add_user):
    assert client.post("/api/tasks/load/local", json={"name": " "}).status_code == 400
    task_id = client.post("/api/tasks/load/local", json={"name": "x"}).json["id"]
    assert client.post(f"/api/tasks/{task_id}/finish").status_code == 400                     # no clip yet
    r = client.post(f"/api/tasks/{task_id}/files", content_type="multipart/form-data",
                    data={"audio": [(io.BytesIO(make_wav(1.0)), "a.wav")], "texts": "[]"})
    assert r.status_code == 400 and "one text" in r.json["error"]
    worker = add_user("ana", "annotator")
    assert worker.post("/api/tasks/load/local", json={"name": "x"}).status_code == 403
    assert send(worker, task_id, [("a.wav", make_wav(1.0), "x")]).status_code == 403


def fake_rows(start, n):
    for k in range(start, start + n):
        yield {"audio": {"bytes": make_wav(1.0 + k % 2, sr=22050), "path": f"clip_{k}.wav"}, "transcription": f"អត្ថបទ {k}"}


@pytest.fixture
def hubmock(monkeypatch):
    monkeypatch.setattr(hub, "parquet_files", lambda *a: ([("main", "x.parquet")], False))
    monkeypatch.setattr(hub, "iter_rows", lambda repo, files, cols, token, start, max_rows, on_file:
                        fake_rows(start, min(max_rows or 5, 5 - start)))


def test_hub_dataset_in_batches_becomes_tasks(client, hubmock):
    body = {"repo": "someone/khmer", "split": "train", "audio_column": "audio", "text_column": "transcription",
            "rows": 5, "start_row": 0, "max_rows": 2, "batches": 2}
    r = client.post("/api/tasks/load/hub", json=body)
    assert r.status_code == 201, r.json
    ids = [t["id"] for t in r.json["tasks"]]
    assert [t["name"] for t in r.json["tasks"]] == ["khmer (train) · rows 0–1", "khmer (train) · rows 2–3"]
    for task_id in ids:
        assert wait_job(client, task_id)["error"] is None
    task = client.get(f"/api/tasks/{ids[1]}").json
    assert [a["name"] for a in task["audios"]] == ["clip_2", "clip_3"]
    assert task["audios"][0]["segments"][0]["parts"][0]["text"] == "អត្ថបទ 2"
    assert task["source"] == {**task["source"], "kind": "hub", "repo": "someone/khmer", "start_row": 2, "max_rows": 2,
                              "state": "ready", "loaded": 2}
    # the next batch starts after the loaded rows; overlapping rows are refused
    r = client.post("/api/hub/inspect", json={"repo": "someone/khmer"})
    r = client.post("/api/tasks/load/hub", json={**body, "batches": 1, "start_row": 2})
    assert r.status_code == 400 and "start at row 4" in r.json["error"]
    from backend.annotation import importer
    with client.application.app_context():
        assert importer.next_row("someone/khmer", "default", "train") == 4
