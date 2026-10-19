"""Dataset cleaning: quality checks, import (Hub mocked), review, checks (ASR mocked), export, parquet for the Hub."""
import io
import json
import time
import wave
import zipfile
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import pytest

from backend.services import hub, quality, recognizer
from conftest import make_wav

TEXTS = ["សួស្តី ពិភពលោក", "លេខ ១០ ម៉ែត្រ", "សួស្តី ពិភពលោក", "", "abc #1"]
CFG = {"CER_PASS": 0.1, "CER_BAD": 0.5, "MIN_CLIP_SECONDS": 0.5, "MAX_CLIP_SECONDS": 30, "SILENCE_SECONDS": 1.0}


# ---------- quality ----------
def test_cer_ignores_spaces_and_punctuation():
    assert quality.cer("សួស្តី ពិភពលោក។", "សួស្តីពិភពលោក") == 0
    assert quality.cer("abcd", "abxd") == 0.25
    assert quality.cer("", "") == 0 and quality.cer("", "x") == 1


def test_text_flags():
    assert quality.text_flags("") == ["empty_text"]
    assert quality.text_flags("លេខ ១០") == ["digits"]
    assert quality.text_flags("abc #1") == ["digits", "latin", "symbols"]
    assert quality.text_flags("សួស្តី? «ពិភពលោក»។") == []


def test_audio_stats_find_speech_bounds():
    sr = 16000
    x = np.zeros(sr * 4, np.float32)
    x[sr * 2:sr * 3] = 0.5 * np.sin(np.arange(sr) / 3)
    a = quality.audio_stats(x, sr)
    assert 1.95 <= a["speech_start"] <= 2.05 and 2.95 <= a["speech_end"] <= 3.05
    item = {"duration": 4.0, "audio": a, "text": "x"}
    assert "long_silence" in quality.audio_flags(item, CFG)


def test_categories():
    items = [{"idx": i, "duration": 2.0, "text": t, "md5": "same" if i < 2 else str(i), "audio": {}, "asr_text": a,
              "cer": c} for i, (t, a, c) in enumerate([("ក", "ក", 0.0), ("ខ", "ខ", 0.05), ("គ", "ឃ", 0.3),
                                                       ("ង", None, None), ("១", None, None)])]
    quality.refresh(items, CFG)
    assert [it["category"] for it in items] == ["pass", "bad", "review", "unchecked", "review"]
    assert "dup_audio" in items[1]["flags"] and "dup_audio" not in items[0]["flags"]


# ---------- import / review / checks / export ----------
def fake_rows(n=len(TEXTS), start=0):
    for k in range(start, n):
        yield {"audio": {"bytes": make_wav(1.0 + k, sr=22050), "path": f"c{k}.wav"}, "transcription": TEXTS[k],
               "raw": f"raw {k}"}


def wait_job(client, ds_id):
    for _ in range(200):
        job = client.get(f"/api/datasets/{ds_id}/job").json["job"]
        if not job["running"]:
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


@pytest.fixture
def ds(client, monkeypatch):
    monkeypatch.setattr(hub, "parquet_files", lambda *a: [("main", "x.parquet")])
    monkeypatch.setattr(hub, "iter_rows", lambda repo, files, cols, token, start, max_rows, on_file:
                        fake_rows(min(len(TEXTS), start + max_rows) if max_rows else len(TEXTS), start))
    r = client.post("/api/datasets", json={"repo": "someone/khmer", "split": "train", "audio_column": "audio",
                                           "text_column": "transcription", "rows": 5,
                                           "columns": [{"name": "audio", "type": "audio"},
                                                       {"name": "transcription", "type": "string"},
                                                       {"name": "raw", "type": "string"}]})
    assert r.status_code == 201, r.json
    ds_id = r.json["datasets"][0]["id"]
    job = wait_job(client, ds_id)
    assert job["error"] is None and job["result"] == {"count": 5, "failed": 0}
    return ds_id


def test_import_resamples_and_flags(client, ds):
    d = client.get(f"/api/datasets/{ds}").json
    assert d["count"] == 5 and d["extra_columns"] == ["raw"]
    it = d["items"]
    assert [round(i["duration"]) for i in it] == [1, 2, 3, 4, 5]
    assert it[1]["extra"] == {"raw": "raw 1"} and it[0]["source_file"] == "c0.wav"
    assert "digits" in it[1]["flags"] and it[3]["category"] == "bad" and "dup_text" in it[2]["flags"]
    wav = client.get(f"/api/datasets/{ds}/clips/0")
    assert wav.status_code == 200 and wav.data[:4] == b"RIFF"
    assert client.get("/api/datasets").json["datasets"][0]["id"] == ds


def test_bad_import_requests(client):
    assert client.post("/api/datasets", json={"repo": "not a repo"}).status_code == 400
    assert client.post("/api/datasets", json={"repo": "a/b", "audio_column": "x", "text_column": "x"}).status_code == 400


def test_review_text_status_trim(client, ds):
    url = f"/api/datasets/{ds}/items/1"
    it = client.patch(url, json={"text": "លេខ ដប់ ម៉ែត្រ", "status": "accepted", "reviewer": "me"}).json
    assert it["status"] == "accepted" and it["reviewer"] == "me" and "digits" not in it["flags"]
    assert client.patch(url, json={"trim": [0.2, 1.5]}).json["trim"] == [0.2, 1.5]
    assert client.patch(url, json={"trim": [1, 1.05]}).status_code == 400
    assert client.patch(url, json={"status": "maybe"}).status_code == 400
    assert client.patch(f"/api/datasets/{ds}/items/99", json={"status": "accepted"}).status_code == 404


def test_normalized_text(client, ds):
    url = f"/api/datasets/{ds}/items/1"
    assert client.get(f"/api/datasets/{ds}").json["items"][1]["norm"] is None   # made from the text
    client.patch(url, json={"status": "accepted"})
    meta = json.loads(zipfile.ZipFile(io.BytesIO(client.get(f"/api/datasets/{ds}/export").data))
                      .read("khmer_train/metadata.json"))
    assert "10" in meta[0]["text_normalized"] and "១០" in meta[0]["text"]
    assert client.patch(url, json={"norm": "លេខ ដប់ ម៉ែត្រ"}).json["norm"] == "លេខ ដប់ ម៉ែត្រ"
    meta = json.loads(zipfile.ZipFile(io.BytesIO(client.get(f"/api/datasets/{ds}/export").data))
                      .read("khmer_train/metadata.json"))
    assert meta[0]["text_normalized"] == "លេខ ដប់ ម៉ែត្រ"
    assert client.patch(url, json={"norm": "  "}).json["norm"] is None   # back to automatic


def test_split_and_join(client, ds, monkeypatch):
    url = f"/api/datasets/{ds}/items/2"                      # row 2: 3 s
    client.patch(url, json={"status": "accepted"})
    assert client.post(f"{url}/split", json={"at": 0.05}).status_code == 400
    assert client.post(f"{url}/split", json={"at": "x"}).status_code == 400
    a, b = client.post(f"{url}/split", json={"at": 1.2, "reviewer": "me"}).json["items"]
    assert (a["idx"], a["part"], a["trim"], a["text"]) == (2, 1, [0, 1.2], TEXTS[2])
    assert (b["idx"], b["part"], b["trim"], b["text"]) == (2, 2, [1.2, 3.0], "")
    assert a["status"] == b["status"] == "todo" and "empty_text" in b["flags"] and "dup_audio" not in b["flags"]
    items = client.get(f"/api/datasets/{ds}").json["items"]
    assert len(items) == 6 and [it["idx"] for it in items] == [0, 1, 2, 2, 3, 4]

    heard = iter(["ពិភពលោក"])
    monkeypatch.setattr(recognizer, "recognize", lambda audio, model: {"text": next(heard), "words": []})
    it = client.post(f"/api/datasets/{ds}/items/3/recognize").json
    assert it["asr_text"] == "ពិភពលោក" and it["cer"] == 1.0
    assert client.post(f"/api/datasets/{ds}/items/99/recognize").status_code == 404

    client.patch(f"/api/datasets/{ds}/items/3", json={"text": "ពិភពលោក", "status": "accepted"})
    client.patch(f"/api/datasets/{ds}/items/2", json={"text": "សួស្តី", "status": "accepted"})
    z = zipfile.ZipFile(io.BytesIO(client.get(f"/api/datasets/{ds}/export").data))
    meta = json.loads(z.read("khmer_train/metadata.json"))
    assert [(m["id"], m["text"], m["duration"]) for m in meta] == [("train_000002_01", "សួស្តី", 1.2),
                                                                    ("train_000002_02", "ពិភពលោក", 1.8)]
    assert meta[1]["part"] == 2 and meta[1]["source_index"] == 2

    r = client.get(f"/api/datasets/{ds}/items/3/audio")       # one clip, its trim applied
    assert r.status_code == 200 and "train_000002_02.wav" in r.headers["Content-Disposition"]
    with wave.open(io.BytesIO(r.data)) as w:
        assert w.getnframes() == int(1.8 * 16000)
    with wave.open(io.BytesIO(client.get(f"/api/datasets/{ds}/items/3/audio?trim=0").data)) as w:
        assert w.getnframes() == 3 * 16000
    assert client.get(f"/api/datasets/{ds}/items/99/audio").status_code == 404

    assert client.post(f"/api/datasets/{ds}/items/3/join").status_code == 400   # the last part
    it = client.post(f"/api/datasets/{ds}/items/2/join").json
    assert (it["part"], it["trim"], it["text"], it["asr_text"]) == (0, None, "សួស្តី ពិភពលោក", None)
    assert len(client.get(f"/api/datasets/{ds}").json["items"]) == 5


def test_checks_score_and_accept_passing(client, ds, monkeypatch):
    heard = iter(["សួស្តី ពិភពលោក", "លេខដប់ម៉ែត្រ", "ខុសទាំងស្រុង", "", "abc"])
    monkeypatch.setattr(recognizer, "recognize", lambda audio, model: {"text": next(heard), "words": []})
    assert client.post(f"/api/datasets/{ds}/check", json={}).status_code == 200
    assert wait_job(client, ds)["result"] == {"checked": 5}
    it = client.get(f"/api/datasets/{ds}").json["items"]
    assert it[0]["cer"] == 0 and it[0]["category"] == "pass"
    assert it[2]["category"] == "bad"            # the ASR heard something else
    assert client.post(f"/api/datasets/{ds}/accept-passing", json={"max_cer": 0.1}).json["accepted"] == 1
    assert client.get(f"/api/datasets/{ds}").json["status_counts"]["accepted"] == 1


def test_export_zip(client, ds):
    client.patch(f"/api/datasets/{ds}/items/0", json={"status": "accepted", "text": "សួស្តី"})
    client.patch(f"/api/datasets/{ds}/items/4", json={"status": "rejected", "reason": "Other"})
    z = zipfile.ZipFile(io.BytesIO(client.get(f"/api/datasets/{ds}/export").data))
    meta = json.loads(z.read("khmer_train/metadata.json"))
    assert [m["id"] for m in meta] == ["train_000000"] and meta[0]["original_text"] == TEXTS[0]
    assert meta[0]["text"] == "សួស្តី" and meta[0]["raw"] == "raw 0"
    assert "khmer_train/wavs/train_000000.wav" in z.namelist()
    z = zipfile.ZipFile(io.BytesIO(client.get(f"/api/datasets/{ds}/export?include=not_rejected").data))
    assert len(json.loads(z.read("khmer_train/metadata.json"))) == 4


def test_push_writes_parquet_and_card(client, ds, monkeypatch):
    client.patch(f"/api/datasets/{ds}/items/0", json={"status": "accepted"})
    client.patch(f"/api/datasets/{ds}/items/1", json={"status": "accepted", "text": "លេខ ដប់ ម៉ែត្រ"})
    pushed = {}

    def fake_push(folder, repo_id, split, card_fn, token, private, create_pr, message, prefix=None):
        assert prefix == "train"   # a whole split: data/train-00000-of-00001.parquet
        table = pq.read_table(next(Path(folder, "data").glob("train-00000-of-00001.parquet")))
        pushed.update(table=table, card=card_fn("---\nlicense: mit\n---\n# Old card\n", {split}), repo=repo_id,
                      meta=json.loads(table.schema.metadata[b"huggingface"]))
        return "https://huggingface.co/datasets/me/khmer_clean/commit/1"

    monkeypatch.setattr(hub, "push", fake_push)
    r = client.post(f"/api/datasets/{ds}/push", json={"repo_id": "me/khmer_clean"})
    assert r.status_code == 200, r.json
    job = wait_job(client, ds)
    assert job["error"] is None and job["result"]["url"].endswith("/commit/1")
    t = pushed["table"]
    assert t.column_names == ["audio", "transcription", "transcription_normalized", "raw", "original_transcription",
                              "duration", "asr_cer", "review_status"]
    assert t.column("transcription").to_pylist() == [TEXTS[0], "លេខ ដប់ ម៉ែត្រ"]
    assert "".join(t.column("transcription_normalized").to_pylist()[1].split()) == "លេខដប់ម៉ែត្រ"
    assert pushed["meta"]["info"]["features"]["audio"] == {"_type": "Audio"}
    assert "license: mit" in pushed["card"] and "# Old card" in pushed["card"] and "| all rows | train | 2 |" in pushed["card"]
    assert "path: data/train-*" in pushed["card"]
    assert client.get(f"/api/datasets/{ds}").json["last_push"]["repo"] == "me/khmer_clean"


def test_push_needs_accepted_clips(client, ds):
    client.post(f"/api/datasets/{ds}/push", json={"repo_id": "me/x"})
    assert "Nothing to push" in wait_job(client, ds)["error"]


def test_delete_dataset(client, ds):
    assert client.delete(f"/api/datasets/{ds}").status_code == 200
    assert client.get(f"/api/datasets/{ds}").status_code == 404


def test_card_keeps_a_row_per_batch():
    cols = [("audio", "audio"), ("text", "string")]
    row = lambda name, clips, hours: {"Batch": name, "Split": "train", "Clips": clips, "Hours": hours, "Rejected": 1,
                                      "Text fixed": 2, "Pushed": "2026-10-15"}
    card = hub.dataset_card("", "me/x", {"train", "test"}, cols, "report 1", row("rows 0–199", 180, "0.25"))
    card = hub.dataset_card(card, "me/x", {"train"}, cols, "report 2", row("rows 200–399", 190, "0.30"))
    card = hub.dataset_card(card, "me/x", {"train"}, cols, "report 2", row("rows 0–199", 185, "0.26"))  # pushed again
    assert "report 1" not in card and card.count(hub.CARD_START) == 1 and "report 2" in card
    assert "| rows 0–199 | train | 185 | 0.26 |" in card and "| rows 200–399 | train | 190 |" in card
    assert "180" not in card and "| **Total** |  | **375** | **0.56** | 2 | 4 |  |" in card
    assert card.index("rows 0–199") < card.index("rows 200–399")


def test_push_replaces_only_its_own_files():
    import fnmatch

    batch = hub.replace_pattern("train-rows-0000200-0000399")
    whole = hub.replace_pattern("train")
    files = ["data/train-00000-of-00001.parquet", "data/train-rows-0000000-0000199-00000-of-00001.parquet",
             "data/train-rows-0000200-0000399-00000-of-00002.parquet", "data/test-00000-of-00001.parquet"]
    assert [f for f in files if fnmatch.fnmatch(f, batch)] == [files[2]]
    assert [f for f in files if fnmatch.fnmatch(f, whole)] == [files[0]]


# ---------- batches of a big split ----------
def test_read_row_range(monkeypatch, tmp_path):
    """Rows 3..7 of two files of 5 rows (row groups of 2): only the row groups that hold them are read."""
    import pyarrow as pa

    paths = []
    for f in range(2):
        paths.append(str(tmp_path / f"f{f}.parquet"))
        pq.write_table(pa.table({"n": list(range(5 * f, 5 * f + 5))}), paths[-1], row_group_size=2)
    read = []

    class Spy(pq.ParquetFile):
        def read_row_group(self, g, **kw):
            read.append((self.metadata.num_rows, g))
            return super().read_row_group(g, **kw)

    hub._row_groups_cache.clear()
    monkeypatch.setattr(hub, "_open_parquet", lambda repo, rev, path, token: Spy(path))
    files = [("main", p) for p in paths]
    assert [r["n"] for r in hub.iter_rows("a/b", files, ["n"], start=3, max_rows=5)] == [3, 4, 5, 6, 7]
    assert read == [(5, 1), (5, 2), (5, 0), (5, 1)]          # file 0: groups 1-2, file 1: groups 0-1
    assert [r["n"] for r in hub.iter_rows("a/b", files, ["n"], start=8, max_rows=10)] == [8, 9]


def test_import_batches(client, monkeypatch):
    monkeypatch.setattr(hub, "parquet_files", lambda *a: [("main", "x.parquet")])
    monkeypatch.setattr(hub, "iter_rows", lambda repo, files, cols, token, start, max_rows, on_file:
                        fake_rows(min(len(TEXTS), start + max_rows), start))
    body = {"repo": "someone/khmer", "split": "train", "audio_column": "audio", "text_column": "transcription",
            "rows": 5, "columns": [{"name": "audio", "type": "audio"}, {"name": "transcription", "type": "string"},
                                   {"name": "raw", "type": "string"}]}
    r = client.post("/api/datasets", json={**body, "start_row": 1, "max_rows": 2, "batches": 5})
    assert r.status_code == 201, r.json
    made = r.json["datasets"]
    assert [d["name"] for d in made] == ["khmer (train) · rows 1–2", "khmer (train) · rows 3–4"]  # only 5 rows
    assert [d["batch"]["prefix"] for d in made] == ["rows-0000001-0000002", "rows-0000003-0000004"]
    for d in made:
        assert wait_job(client, d["id"])["error"] is None
    items = client.get(f"/api/datasets/{made[1]['id']}").json["items"]
    assert [it["idx"] for it in items] == [3, 4] and items[1]["text"] == TEXTS[4]
    assert client.get("/api/datasets").json["datasets"][0]["count"] == 2

    again = client.post("/api/datasets", json={**body, "start_row": 2, "max_rows": 2})
    assert again.status_code == 400 and "start at row 5" in again.json["error"]
    assert client.post("/api/datasets", json={**body, "max_rows": 2, "batches": "x"}).status_code == 400
    assert client.post("/api/datasets", json={**body, "batches": 2}).status_code == 400   # no rows per batch


def test_batches_push_to_one_repo(client, monkeypatch):
    monkeypatch.setattr(hub, "parquet_files", lambda *a: [("main", "x.parquet")])
    monkeypatch.setattr(hub, "iter_rows", lambda repo, files, cols, token, start, max_rows, on_file:
                        fake_rows(min(len(TEXTS), start + max_rows), start))
    made = client.post("/api/datasets", json={
        "repo": "someone/khmer", "split": "train", "audio_column": "audio", "text_column": "transcription",
        "columns": [{"name": "audio", "type": "audio"}, {"name": "transcription", "type": "string"}],
        "max_rows": 2, "batches": 2}).json["datasets"]
    repo = {"card": "", "files": {}}

    def fake_push(folder, repo_id, split, card_fn, token, private, create_pr, message, prefix=None):
        import fnmatch

        repo["files"] = {f: v for f, v in repo["files"].items() if not fnmatch.fnmatch(f, hub.replace_pattern(prefix))}
        for p in Path(folder, "data").glob("*.parquet"):
            repo["files"][f"data/{p.name}"] = pq.read_table(p).column("transcription").to_pylist()
        repo["card"] = card_fn(repo["card"], {split})
        return "https://huggingface.co/datasets/me/khmer_clean/commit/1"

    monkeypatch.setattr(hub, "push", fake_push)
    for d in made:
        wait_job(client, d["id"])
        client.patch(f"/api/datasets/{d['id']}/items/0", json={"status": "accepted"})
        client.post(f"/api/datasets/{d['id']}/push", json={"repo_id": "me/khmer_clean"})
        assert wait_job(client, d["id"])["error"] is None
    client.patch(f"/api/datasets/{made[0]['id']}/items/1", json={"status": "accepted"})
    client.post(f"/api/datasets/{made[0]['id']}/push", json={"repo_id": "me/khmer_clean"})   # the first batch again
    wait_job(client, made[0]["id"])
    assert repo["files"] == {"data/train-rows-0000000-0000001-00000-of-00001.parquet": TEXTS[0:2],
                             "data/train-rows-0000002-0000003-00000-of-00001.parquet": TEXTS[2:3]}
    assert "| rows 0–1 | train | 2 |" in repo["card"] and "| rows 2–3 | train | 1 |" in repo["card"]
    assert "| **Total** |  | **3** |" in repo["card"]
    assert client.get(f"/api/datasets/{made[1]['id']}").json["sibling_push"]["repo"] == "me/khmer_clean"
