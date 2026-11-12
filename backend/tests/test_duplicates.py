"""Duplicate audio across tasks: fingerprints on upload, the report, skip / ignore, and the fingerprint itself."""
import io
import wave

import numpy as np

from api.core import fingerprint

SR = 16000


def speechlike(seconds, seed):
    """Synthetic 'speech': noise through moving resonances, in syllables with pauses. Different seeds = different
    recordings."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    out = np.zeros(n, np.float32)
    t = 0
    while t < n:
        length = int(rng.uniform(0.12, 0.35) * SR)
        f = rng.uniform(300, 2500, 3)
        k = np.arange(length) / SR
        syl = sum(np.sin(2 * np.pi * fi * k + rng.uniform(0, 6)) * rng.uniform(0.2, 1) for fi in f)
        syl *= np.hanning(length) * rng.uniform(0.2, 0.6)
        out[t:t + length] = syl[:max(0, min(length, n - t))]
        t += length + int(rng.uniform(0.02, 0.25) * SR)
    return out


def wav(x):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())
    return buf.getvalue()


def upload(client, x, name):
    r = client.post("/api/audios", data={"audio": (io.BytesIO(wav(x)), name)}, content_type="multipart/form-data")
    assert r.status_code == 201, r.json
    return r.json


def test_fingerprint_finds_a_quieter_part_and_not_another_recording():
    a, b = speechlike(40, 1), speechlike(40, 2)
    idx = fingerprint.Index()
    idx.add("a", fingerprint.compute(a)); idx.add("b", fingerprint.compute(b))
    part = a[int(12.3 * SR):int(24.3 * SR)] * 0.4          # 12 s cut at an odd place, 8 dB quieter
    hits = idx.search(fingerprint.compute(part))
    assert [h["key"] for h in hits] == ["a"]
    assert abs(hits[0]["ref_start"] - hits[0]["start"] - 12.3) < 0.2 and hits[0]["seconds"] >= 9
    assert idx.search(fingerprint.compute(speechlike(20, 3))) == []


def test_upload_reports_duplicate_and_report_lists_the_pair(client):
    x = speechlike(20, 7)
    first = upload(client, x, "interview.wav")
    assert first["duplicates"] == []
    assert upload(client, speechlike(20, 8), "other.wav")["duplicates"] == []
    again = upload(client, x * 0.5, "interview copy.wav")
    assert [(d["id"], d["kind"]) for d in again["duplicates"]] == [(first["id"], "identical")]

    r = client.get("/api/duplicates").json
    assert r["missing"] == 0 and len(r["pairs"]) == 1
    pair = r["pairs"][0]
    assert pair["duplicate"]["id"] == again["id"] and pair["original"]["id"] == first["id"]
    assert pair["kind"] == "identical" and pair["seconds"] >= 15

    # not a duplicate after all: the pair leaves the report
    assert client.post("/api/duplicates/ignore", json={"a": again["id"], "b": first["id"]}).status_code == 200
    assert client.get("/api/duplicates").json["pairs"] == []


def test_skip_duplicate_packages_in_a_task(client):
    x = speechlike(30, 11)
    first = upload(client, x, "long.wav")
    part = upload(client, x[10 * SR:20 * SR], "part.wav")
    assert [d["kind"] for d in part["duplicates"]] == ["part_of"]
    client.post(f"/api/audios/{part['id']}/recut", json={"chunk_seconds": 5})
    client.post("/api/tasks", json={"name": "Batch", "audio_ids": [part["id"]]})

    pair = client.get("/api/duplicates").json["pairs"][0]
    pkgs = pair["duplicate"]["packages"]
    assert pair["duplicate"]["id"] == part["id"] and len(pkgs) == 2 and {p["stage"] for p in pkgs} == {"annotating"}
    r = client.post("/api/duplicates/skip", json={"audio": part["id"], "packages": [p["index"] for p in pkgs],
                                                  "original": first["id"]})
    assert r.json == {"skipped": 2}
    assert {p["stage"] for p in client.get("/api/duplicates").json["pairs"][0]["duplicate"]["packages"]} == {"skipped"}
    assert client.get("/api/duplicates/summary").json["packages_open"] == 0
    # an audio still in Upload & Crop is deleted instead
    assert client.post("/api/duplicates/skip", json={"audio": first["id"], "packages": [0]}).status_code == 400


def test_deleted_audio_leaves_the_report(client):
    x = speechlike(15, 21)
    upload(client, x, "a.wav")
    b = upload(client, x, "b.wav")
    assert len(client.get("/api/duplicates").json["pairs"]) == 1
    client.delete(f"/api/audios/{b['id']}")
    assert client.get("/api/duplicates").json["pairs"] == []


def test_only_managers_see_duplicates(add_user):
    ana = add_user("ana", "annotator")
    assert ana.get("/api/duplicates").status_code == 403


def test_three_copies_are_two_pairs_and_upload_list_warns(client):
    x = speechlike(15, 31)
    a = upload(client, x, "a.wav")
    b = upload(client, x, "b.wav")
    c = upload(client, x * 0.7, "c.wav")
    pairs = client.get("/api/duplicates").json["pairs"]
    assert sorted((p["duplicate"]["id"], p["original"]["id"]) for p in pairs) == sorted([(b["id"], a["id"]), (c["id"], a["id"])])
    listed = {r["id"]: r["duplicates"] for r in client.get("/api/audios").json["audios"]}
    assert listed[a["id"]] == [] and [d["id"] for d in listed[b["id"]]] == [a["id"]]
