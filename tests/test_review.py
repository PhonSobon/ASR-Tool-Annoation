"""Package review in a task (annotator -> reviewer, one step), dataset members, and Hub reading of big splits."""
import pytest

from backend.annotation import review
from backend.core import hub
from conftest import upload
from test_datasets import ds, wait_job  # noqa: F401  (the imported-dataset fixture)


def _crop(start, end, text, **kw):
    return {"start": start, "end": end, "parts": [{"start": start, "end": end, "role": "Narrator", "text": text}], **kw}


@pytest.fixture
def team(client, add_user):
    """A task of one audio with two packages; ana annotates, ian and rex review (both reviewers)."""
    people = {name: add_user(name, role) for name, role in
              (("ana", "annotator"), ("ian", "inspector"), ("rex", "inspector"))}
    a = upload(client)
    client.put(f"/api/audios/{a['id']}/state", json={"segments": [_crop(0, 6, ""), _crop(6, 12, "")]})
    task = client.post("/api/tasks", json={"name": "T", "audio_ids": [a["id"]],
                                           "members": {"annotator": ["ana"], "inspector": ["ian", "rex"]}}).json
    return {**people, "admin": client, "task": task["id"], "audio": a["id"]}


def _segments(t):
    return t["admin"].get(f"/api/audios/{t['audio']}").json["segments"]


def _save(t, who, segments, changed=None):
    body = {"segments": segments, **({"changed": changed} if changed is not None else {})}
    return t[who].put(f"/api/audios/{t['audio']}/state", json=body)


def _review(t, who, decision, note="", index=0):
    return t[who].post(f"/api/tasks/{t['task']}/review", json={"audio_id": t["audio"], "index": index,
                                                               "decision": decision, "note": note})


def test_one_review_step_accepts_the_package(team):
    t = team
    assert _review(t, "ian", "accept").status_code == 400                       # not completed yet
    _save(t, "ana", [_crop(0, 6, "សួស្តី", completed=True, annotator="ana"), _crop(6, 12, "")])
    assert review.stage(_segments(t)[0]) == "inspecting"                       # waiting for review
    assert _review(t, "ana", "accept").status_code == 403                       # annotators do not review
    assert _review(t, "ian", "maybe").status_code == 400                        # unknown decision
    crop = _review(t, "ian", "accept", "fine").json["crop"]
    assert review.stage(crop) == "accepted" and crop["acceptance"]["by"] == "ian"
    assert [(h["stage"], h["decision"]) for h in crop["history"]] == [("review", "accept")]
    assert _review(t, "rex", "accept").status_code == 400                       # one review is enough

    # the annotator can no longer change an accepted package
    _save(t, "ana", [_crop(0, 6, "changed", completed=False, annotator="ana"), _crop(6, 12, "")])
    assert _segments(t)[0]["parts"][0]["text"] == "សួស្តី"
    summary = t["admin"].get("/api/tasks").json["tasks"][0]
    assert summary["stages"]["accepted"] == 1 and summary["stages"]["annotating"] == 1
    assert set(summary["stages"]) == {"annotating", "returned", "inspecting", "accepted", "skipped"}


def test_old_two_step_data_needs_one_review(team):
    """A package that only passed the old inspection step waits for the review; "pass" from an old client = accept."""
    t = team
    _save(t, "ana", [_crop(0, 6, "x", completed=True, annotator="ana"), _crop(6, 12, "")])

    def old_pass(segs):
        segs[0].update(inspection={"status": "passed", "by": "ian", "at": "2026-01-01 10:00:00", "note": ""},
                       history=[{"stage": "inspection", "decision": "pass", "by": "ian", "at": "2026-01-01 10:00:00"}])
        return segs
    with t["admin"].application.app_context():
        from backend.annotation import audios
        audios.update_segments(t["audio"], old_pass)
    assert review.stage(_segments(t)[0]) == "inspecting"
    crop = t["rex"].post(f"/api/tasks/{t['task']}/review", json={"audio_id": t["audio"], "index": 0, "step": "inspection",
                                                                 "decision": "pass"}).json["crop"]
    assert review.stage(crop) == "accepted" and crop["inspection"]["by"] == "ian"   # the old record is kept


def test_old_acceptors_become_reviewers(client, add_user):
    from backend.auth import users
    from backend.core import db
    from backend.core.db import Task, User

    acc = add_user("acc", "annotator")
    a = upload(client)
    task = client.post("/api/tasks", json={"name": "T", "audio_ids": [a["id"]]}).json["id"]
    with client.application.app_context():
        with db.transaction() as s:
            s.get(User, "acc").role = "acceptor"                               # as saved before the change
            s.get(Task, task).members = {"annotator": [], "inspector": [], "acceptor": ["acc"]}
        assert users.merge_old_roles() == 1
    assert client.get("/api/users").json["users"][[u["username"] for u in client.get("/api/users").json["users"]].index("acc")]["role"] == "inspector"
    assert client.get(f"/api/tasks/{task}").json["members"] == {"annotator": [], "inspector": ["acc"]}
    assert "acceptor" not in {r["id"] for r in client.get("/api/users").json["roles"]}
    assert acc.get("/api/auth/me").json["user"] is None                         # signed out: permissions changed


def test_old_viewers_become_annotators(client, add_user):
    from backend.auth import users
    from backend.core import db
    from backend.core.db import User

    vic = add_user("vic", "annotator")
    with client.application.app_context():
        with db.transaction() as s:
            s.get(User, "vic").role = "viewer"                                 # as saved before the change
        assert users.merge_old_roles() == 1
    listed = {u["username"]: u["role"] for u in client.get("/api/users").json["users"]}
    assert listed["vic"] == "annotator"
    assert "viewer" not in {r["id"] for r in client.get("/api/users").json["roles"]}
    assert vic.get("/api/auth/me").json["user"] is None                         # signed out: permissions changed


def test_returned_package_needs_a_note_and_a_resubmit(team):
    t = team
    _save(t, "ana", [_crop(0, 6, "x", completed=True, annotator="ana"), _crop(6, 12, "")])
    assert _review(t, "ian", "return").status_code == 400                       # needs a note
    returned = _review(t, "ian", "return", "Segment 1 is cut off").json["crop"]
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
        "audio_id": t["audio"], "index": 0, "decision": "accept"}).json["error"]


def test_hub_push_keeps_only_accepted_packages(team):
    from backend.annotation import tasks

    t = team
    _save(t, "ana", [_crop(0, 6, "x", completed=True, annotator="ana"), _crop(6, 12, "y", completed=True, annotator="ana")])
    _review(t, "ian", "accept", index=0)
    with t["admin"].application.app_context():
        assert [s["text"] for _, _, s in tasks.hub_segments(t["task"], "accepted")] == ["x"]
        assert [s["text"] for _, _, s in tasks.hub_segments(t["task"], "passed")] == ["x"]     # old name = accepted
        assert len(tasks.hub_segments(t["task"], "done")) == 2


def test_task_claim(client, add_user):
    ana, ian = add_user("ana", "annotator"), add_user("ian", "inspector")
    a = upload(client)
    task = client.post("/api/tasks", json={"name": "T", "audio_ids": [a["id"]]}).json["id"]
    assert ana.get("/api/tasks").json["tasks"] == []                                # assign-only by default
    assert ana.post(f"/api/tasks/{task}/claim").status_code == 400
    assert ana.put(f"/api/tasks/{task}/members", json={"open_roles": ["annotator"]}).status_code == 403
    r = client.put(f"/api/tasks/{task}/members", json={"open_roles": ["annotator", "bogus"]}).json
    assert r["open_roles"] == ["annotator"]
    [card] = ana.get("/api/tasks").json["tasks"]
    assert card["can_claim"] and not card["access"]["view"]
    assert ana.get(f"/api/tasks/{task}").status_code == 403                         # only the card until claimed
    assert ian.get("/api/tasks").json["tasks"] == []                                # inspectors are not open
    assert ian.post(f"/api/tasks/{task}/claim").status_code == 400
    assert ana.post(f"/api/tasks/{task}/claim").json["members"]["annotator"] == ["ana"]
    assert ana.post(f"/api/tasks/{task}/claim").status_code == 400                  # already in
    [card] = ana.get("/api/tasks").json["tasks"]
    assert not card["can_claim"] and card["access"]["edit"]
    r = client.put(f"/api/tasks/{task}/members", json={"annotator": ["ana"]}).json
    assert r["open_roles"] == ["annotator"]                                         # left out: unchanged


def test_task_push_and_pull(client, add_user):
    ana = add_user("ana", "annotator")
    a = upload(client)
    task = client.post("/api/tasks", json={"name": "T", "audio_ids": [a["id"]]}).json["id"]
    client.put(f"/api/tasks/{task}/members", json={"open_roles": ["inspector"]})
    assert ana.put(f"/api/tasks/{task}/share", json={"annotator": True}).status_code == 403   # managers only
    assert ana.post(f"/api/tasks/{task}/pull").status_code == 400                          # not pushed yet
    r = client.put(f"/api/tasks/{task}/share", json={"annotator": True}).json
    assert r["open_roles"] == ["annotator", "inspector"]                                    # inspector kept
    [card] = ana.get("/api/tasks").json["tasks"]
    assert card["can_claim"]
    assert ana.post(f"/api/tasks/{task}/pull").json["members"]["annotator"] == ["ana"]
    assert ana.post(f"/api/tasks/{task}/pull").status_code == 400                          # already pulled
    [card] = client.get("/api/tasks").json["tasks"]
    assert [(p["username"], p["role"]) for p in card["pulled"]] == [("ana", "annotator")]
    r = client.put(f"/api/tasks/{task}/share", json={"annotator": False})
    assert r.status_code == 409 and "ana" in r.json["error"]                               # pulled: no take back
    r = client.put(f"/api/tasks/{task}/members", json={"annotator": ["ana"], "open_roles": ["inspector"]})
    assert r.status_code == 409                                                             # nor through Members
    assert client.get(f"/api/tasks/{task}").json["open_roles"] == ["annotator", "inspector"]
    client.put(f"/api/tasks/{task}/members", json={"annotator": []})                       # manager removes ana
    assert client.get(f"/api/tasks/{task}").json["pulled"] == []                           # her pull no longer counts
    r = client.put(f"/api/tasks/{task}/share", json={"annotator": False}).json
    assert r["open_roles"] == ["inspector"]


def test_pull_is_exclusive_among_many_users_of_a_role(client, add_user):
    admins = [client] + [add_user(f"admin{i}", "admin") for i in range(1, 4)]          # 4 administrators
    anns = {f"ann{i:02d}": add_user(f"ann{i:02d}", "annotator") for i in range(12)}    # 12 annotators
    ids = []
    for k in range(3):
        a = upload(admins[k])
        ids.append(admins[k].post("/api/tasks", json={"name": f"T{k}", "audio_ids": [a["id"]]}).json["id"])
        assert admins[k + 1].put(f"/api/tasks/{ids[-1]}/share", json={"annotator": True}).status_code == 200
    for c in anns.values():                                                            # every annotator sees all 3
        assert sorted(t["id"] for t in c.get("/api/tasks").json["tasks"] if t["can_claim"]) == sorted(ids)

    assert anns["ann00"].post(f"/api/tasks/{ids[0]}/pull").status_code == 200
    for name, c in anns.items():                                                       # gone for the other 11
        if name != "ann00":
            assert ids[0] not in [t["id"] for t in c.get("/api/tasks").json["tasks"]]
    r = anns["ann01"].post(f"/api/tasks/{ids[0]}/pull")                                # a stale card
    assert r.status_code == 409 and r.json["pulled"] and "ann00" in r.json["error"]
    assert anns["ann01"].post(f"/api/tasks/{ids[1]}/pull").status_code == 200        # takes another one
    assert anns["ann02"].post(f"/api/tasks/{ids[2]}/pull").status_code == 200
    assert [t for t in anns["ann03"].get("/api/tasks").json["tasks"]] == []           # nothing left for the rest

    for c in admins:                                                                   # every admin sees who has what
        pulled = {t["id"]: [p["username"] for p in t["pulled"]] for t in c.get("/api/tasks").json["tasks"]}
        assert pulled == {ids[0]: ["ann00"], ids[1]: ["ann01"], ids[2]: ["ann02"]}
    admins[3].put(f"/api/tasks/{ids[0]}/members", json={"annotator": []})            # an admin frees T0 again
    assert [t["id"] for t in anns["ann05"].get("/api/tasks").json["tasks"] if t["can_claim"]] == [ids[0]]
    assert anns["ann05"].post(f"/api/tasks/{ids[0]}/pull").status_code == 200


def test_take_back_before_anyone_pulls(client, add_user):
    a = upload(client)
    task = client.post("/api/tasks", json={"name": "T", "audio_ids": [a["id"]]}).json["id"]
    client.put(f"/api/tasks/{task}/share", json={"annotator": True})
    assert client.put(f"/api/tasks/{task}/share", json={"annotator": False}).json["open_roles"] == []


def test_task_push_refused_while_loading(client):
    task = client.post("/api/tasks/load/local", json={"name": "L"}).json["id"]
    r = client.put(f"/api/tasks/{task}/share", json={"annotator": True})
    assert r.status_code == 400 and "loading" in r.json["error"]


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


def test_dataset_claim(client, add_user, ds):
    ana = add_user("ana", "annotator")
    assert ana.post(f"/api/datasets/{ds}/claim").status_code == 400               # not open
    r = client.put(f"/api/datasets/{ds}/members", json={"members": [], "open": True}).json
    assert r == {"members": [], "open": True}
    [card] = ana.get("/api/datasets").json["datasets"]
    assert card["can_claim"] and not card["access"]["view"]
    assert ana.post(f"/api/datasets/{ds}/claim").json["members"] == ["ana"]
    assert ana.post(f"/api/datasets/{ds}/claim").status_code == 400               # already in
    assert ana.get(f"/api/datasets/{ds}").status_code == 200
    assert client.put(f"/api/datasets/{ds}/members", json={"members": ["ana"]}).json["open"] is True   # kept


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
    _review(t, "ian", "return", "fix the spelling", index=1)
    _review(t, "rex", "accept")
    assert t["ana"].get("/api/activity/work").status_code == 403                # Administrator only

    users = {u["username"]: u for u in t["admin"].get("/api/activity/work").json["users"]}
    assert users["ana"]["annotation"] == {"done": 1, "done_seconds": 6.0, "in_progress": 1, "returned": 1,
                                          "accepted": 1, "accepted_seconds": 6.0, "passed": 1}
    assert users["ian"]["review"] == {"inspected": 0, "accepted": 0, "returned": 1}
    assert users["rex"]["review"] == {"inspected": 0, "accepted": 1, "returned": 0}

    later = t["admin"].get("/api/activity/work?since=2999-01-01").json   # nothing happened in that period
    ana = next(u for u in later["users"] if u["username"] == "ana")["annotation"]
    assert ana["done"] == ana["returned"] == ana["accepted"] == 0 and later["totals"]["done_seconds"] == 0


# ---------- project dashboard ----------
def test_dashboard(team, add_user):
    t = team
    mia = add_user("mia", "manager")
    free = add_user("fay", "annotator")                                          # in no task: free to pull
    _save(t, "ana", [_crop(0, 6, "x", completed=True, annotator="ana"), _crop(6, 12, "y", completed=True, annotator="ana")])
    _review(t, "ian", "accept", index=0)
    _review(t, "rex", "return", note="typo", index=1)
    assert t["ana"].get("/api/dashboard").status_code == 403                    # managers and admins only
    assert t["ian"].get("/api/dashboard").status_code == 403
    d = mia.get("/api/dashboard?days=7").json
    assert d["days"] == 7 and len(d["daily"]) == 7
    assert d["tasks"] == {"total": 1, "not_shared": 0, "waiting_pull": 0, "pulled": 0, "assigned": 1, "finished": 0}
    assert d["packages"] == {"total": 2, "completed": 1, "todo": 1}
    assert d["pipeline"]["accepted"] == 1 and d["pipeline"]["returned"] == 1
    q = d["quality"]
    assert (q["accepted"], q["returned"], q["reviewed_packages"], q["first_pass"], q["reviews"]) == (1, 1, 2, 1, 2)
    assert q["first_pass_rate"] == 50.0 and q["return_rate"] == 50.0
    today = d["daily"][-1]
    assert (today["accepted"], today["returned"]) == (1, 1) and "passed" not in today
    assert [a["kind"] for a in d["attention"]] == ["returned"]
    assert d["team"]["free_annotators"] == ["fay"] and d["team"]["roles"]["annotator"]["active"] == 2
    [row] = d["rows"]
    assert row["status"] == "assigned" and row["annotators"] == ["ana"] and row["hours"] > 0

    client = t["admin"]
    a = upload(client)
    other = client.post("/api/tasks", json={"name": "Open", "audio_ids": [a["id"]]}).json["id"]
    client.put(f"/api/tasks/{other}/share", json={"annotator": True})
    d = client.get("/api/dashboard").json
    assert d["tasks"]["waiting_pull"] == 1 and "waiting_pull" in [x["kind"] for x in d["attention"]]
    free.post(f"/api/tasks/{other}/pull")
    d = client.get("/api/dashboard").json
    assert d["tasks"]["pulled"] == 1 and d["team"]["free_annotators"] == []
    assert next(r for r in d["rows"] if r["id"] == other)["pulled"][0]["username"] == "fay"
