"""Package review in a task (annotator -> inspector -> acceptor), dataset members, and Hub reading of big splits."""
import pytest

from backend.annotation import review
from backend.core import hub
from conftest import upload
from test_datasets import ds, wait_job  # noqa: F401  (the imported-dataset fixture)


def _crop(start, end, text, **kw):
    return {"start": start, "end": end, "parts": [{"start": start, "end": end, "role": "Narrator", "text": text}], **kw}


@pytest.fixture
def team(client, add_user):
    """A task of one audio with two packages; ana annotates, ian inspects, acc accepts."""
    people = {name: add_user(name, role) for name, role in
              (("ana", "annotator"), ("ian", "inspector"), ("acc", "acceptor"))}
    a = upload(client)
    client.put(f"/api/audios/{a['id']}/state", json={"segments": [_crop(0, 6, ""), _crop(6, 12, "")]})
    task = client.post("/api/tasks", json={"name": "T", "audio_ids": [a["id"]],
                                           "members": {"annotator": ["ana"], "inspector": ["ian"], "acceptor": ["acc"]}}).json
    return {**people, "admin": client, "task": task["id"], "audio": a["id"]}


def _segments(t):
    return t["admin"].get(f"/api/audios/{t['audio']}").json["segments"]


def _save(t, who, segments, changed=None):
    body = {"segments": segments, **({"changed": changed} if changed is not None else {})}
    return t[who].put(f"/api/audios/{t['audio']}/state", json=body)


def _review(t, who, step, decision, note="", index=0):
    return t[who].post(f"/api/tasks/{t['task']}/review", json={"audio_id": t["audio"], "index": index, "step": step,
                                                               "decision": decision, "note": note})


def test_package_goes_through_inspection_and_acceptance(team):
    t = team
    assert _review(t, "ian", "inspection", "pass").status_code == 400           # not completed yet
    _save(t, "ana", [_crop(0, 6, "សួស្តី", completed=True, annotator="ana"), _crop(6, 12, "")])
    assert _review(t, "acc", "acceptance", "accept").status_code == 400         # inspection first
    assert _review(t, "ana", "inspection", "pass").status_code == 403           # annotators do not inspect
    assert _review(t, "ian", "inspection", "pass", "fine").json["crop"]["inspection"]["by"] == "ian"
    assert review.stage(_segments(t)[0]) == "accepting"

    # the annotator can no longer change a package that passed inspection
    _save(t, "ana", [_crop(0, 6, "changed", completed=False, annotator="ana"), _crop(6, 12, "")])
    assert _segments(t)[0]["parts"][0]["text"] == "សួស្តី"

    crop = _review(t, "acc", "acceptance", "accept").json["crop"]
    assert review.stage(crop) == "accepted" and [h["decision"] for h in crop["history"]] == ["pass", "accept"]
    summary = t["admin"].get("/api/tasks").json["tasks"][0]
    assert summary["stages"]["accepted"] == 1 and summary["stages"]["annotating"] == 1


def test_returned_package_needs_a_note_and_a_resubmit(team):
    t = team
    _save(t, "ana", [_crop(0, 6, "x", completed=True, annotator="ana"), _crop(6, 12, "")])
    assert _review(t, "ian", "inspection", "return").status_code == 400         # needs a note
    returned = _review(t, "ian", "inspection", "return", "Segment 1 is cut off").json["crop"]
    assert review.stage(returned) == "returned" and returned["returned"]["note"] == "Segment 1 is cut off"

    # a browser that has not seen the return cannot complete it again ...
    _save(t, "ana", [_crop(0, 6, "x y", completed=True, annotator="ana"), _crop(6, 12, "")])
    assert review.stage(_segments(t)[0]) == "returned"
    # ... the one that saw it can (resubmit = the time of the return)
    _save(t, "ana", [_crop(0, 6, "x y z", completed=True, annotator="ana", resubmit=returned["returned"]["at"]),
                     _crop(6, 12, "")])
    crop = _segments(t)[0]
    assert review.stage(crop) == "inspecting" and crop["parts"][0]["text"] == "x y z" and "resubmit" not in crop


def test_review_fields_cannot_be_forged_and_saves_are_per_package(team):
    t = team
    _save(t, "ana", [_crop(0, 6, "x", completed=True, annotator="ana",
                           inspection={"status": "passed", "by": "ana"}), _crop(6, 12, "")])
    assert review.stage(_segments(t)[0]) == "inspecting"                       # the forged inspection is dropped

    # ian fixes package 1 while ana's stale copy of the audio saves package 2 only
    _save(t, "ian", [_crop(0, 6, "fixed", completed=True, annotator="ana"), _crop(6, 12, "")], changed=[0])
    _save(t, "ana", [_crop(0, 6, "x", completed=True, annotator="ana"), _crop(6, 12, "two")], changed=[1])
    texts = [s["parts"][0]["text"] for s in _segments(t)]
    assert texts == ["fixed", "two"]


def test_nobody_inspects_their_own_package(team, add_user):
    t = team
    mia = add_user("mia", "manager")
    _save(t, "admin", [_crop(0, 6, "x", completed=True, annotator="mia"), _crop(6, 12, "")])
    assert "another person" in mia.post(f"/api/tasks/{t['task']}/review", json={
        "audio_id": t["audio"], "index": 0, "step": "inspection", "decision": "pass"}).json["error"]


def test_hub_push_keeps_only_accepted_packages(team):
    from backend.annotation import tasks

    t = team
    _save(t, "ana", [_crop(0, 6, "x", completed=True, annotator="ana"), _crop(6, 12, "y", completed=True, annotator="ana")])
    _review(t, "ian", "inspection", "pass", index=0)
    _review(t, "acc", "acceptance", "accept", index=0)
    _review(t, "ian", "inspection", "pass", index=1)
    with t["admin"].application.app_context():
        assert [s["text"] for _, _, s in tasks.hub_segments(t["task"], "accepted")] == ["x"]
        assert [s["text"] for _, _, s in tasks.hub_segments(t["task"], "passed")] == ["x", "y"]
        assert len(tasks.hub_segments(t["task"], "done")) == 2


# ---------- datasets ----------
def test_dataset_members(client, add_user, ds):
    ana, ian = add_user("ana", "annotator"), add_user("ian", "inspector")
    assert ana.get(f"/api/datasets/{ds}").status_code == 403
    assert ana.get("/api/datasets").json["datasets"] == []
    assert client.put(f"/api/datasets/{ds}/members", json={"members": ["ana", "ian"]}).json["members"] == ["ana", "ian"]
    it = ana.patch(f"/api/datasets/{ds}/items/0", json={"status": "rejected", "reviewer": "someone-else"}).json
    assert it["status"] == "rejected" and it["reviewer"] == "ana"            # the logged-in user, not what was sent
    assert ana.post(f"/api/datasets/{ds}/accept-passing", json={}).status_code == 403
    assert ian.post(f"/api/datasets/{ds}/accept-passing", json={}).status_code == 200
    assert ana.post(f"/api/datasets/{ds}/check", json={}).status_code == 403
    assert ana.delete(f"/api/datasets/{ds}").status_code == 403


# ---------- reading big splits from the Hub ----------
def test_partial_viewer_conversion_falls_back_to_the_repo_files(monkeypatch):
    url = "https://huggingface.co/datasets/a/b/resolve/refs%2Fconvert%2Fparquet/default/partial-train/0000.parquet"
    monkeypatch.setattr(hub, "_viewer", lambda *a, **k: {"partial": True, "parquet_files": [
        {"config": "default", "split": "train", "url": url}]})
    monkeypatch.setattr(hub, "_repo_parquet_files", lambda repo, token: {"train": ["data/train-0.parquet"]})
    assert hub.parquet_files("a/b", "default", "train") == ([("main", "data/train-0.parquet")], False)

    monkeypatch.setattr(hub, "_repo_parquet_files", lambda repo, token: {})   # not parquet in the repo itself
    assert hub.parquet_files("a/b", "default", "train") == (
        [("refs/convert/parquet", "default/partial-train/0000.parquet")], True)


def test_import_warns_when_the_source_changed(client, monkeypatch):
    monkeypatch.setattr(hub, "parquet_files", lambda *a: ([("main", "x.parquet")], False))
    monkeypatch.setattr(hub, "iter_rows", lambda *a: iter([]))   # past the end of what can be read
    body = {"repo": "a/b", "audio_column": "audio", "text_column": "text", "max_rows": 10}
    monkeypatch.setattr(hub, "dataset_sha", lambda *a: "1111aaaa")
    first = client.post("/api/datasets", json=body).json
    assert first["warning"] is None
    assert "No rows from row 0" in wait_job(client, first["datasets"][0]["id"])["error"]
    monkeypatch.setattr(hub, "dataset_sha", lambda *a: "2222bbbb")
    second = client.post("/api/datasets", json={**body, "start_row": 10}).json
    assert "changed on the Hub" in second["warning"]


def test_work_dashboard_counts_hours_returns_and_acceptances(team):
    t = team
    _save(t, "ana", [_crop(0, 6, "សួស្តី", completed=True, annotator="ana", updated="2026-01-02 10:00:00"),
                     _crop(6, 12, "ពិភពលោក", completed=True, annotator="ana", updated="2026-01-02 10:00:00")])
    _review(t, "ian", "inspection", "pass")
    _review(t, "ian", "inspection", "return", "fix the spelling", index=1)
    _review(t, "acc", "acceptance", "accept")
    assert t["ana"].get("/api/activity/work").status_code == 403                # Administrator only

    users = {u["username"]: u for u in t["admin"].get("/api/activity/work").json["users"]}
    assert users["ana"]["annotation"] == {"done": 1, "done_seconds": 6.0, "in_progress": 1, "returned": 1,
                                          "accepted": 1, "accepted_seconds": 6.0, "passed": 1}
    assert users["ian"]["review"] == {"inspected": 1, "accepted": 0, "returned": 1}
    assert users["acc"]["review"] == {"inspected": 0, "accepted": 1, "returned": 0}

    later = t["admin"].get("/api/activity/work?since=2999-01-01").json   # nothing happened in that period
    ana = next(u for u in later["users"] if u["username"] == "ana")["annotation"]
    assert ana["done"] == ana["returned"] == ana["accepted"] == 0 and later["totals"]["done_seconds"] == 0
