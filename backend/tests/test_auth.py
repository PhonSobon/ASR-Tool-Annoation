"""Sign in, default passwords, user admin, the activity log and what each role may do."""
from api import create_app
from conftest import ADMIN, DEFAULT_PASSWORD, PASSWORD, login, app_config, upload


def test_api_needs_login(anon):
    assert anon.get("/api/tasks").status_code == 401
    assert anon.get("/api/datasets").status_code == 401
    assert anon.get("/api/auth/me").json == {"user": None, "setup": False}


def test_no_sign_up_and_admin_from_env(tmp_path):
    app = create_app(app_config(tmp_path, ADMIN_PASSWORD=None))
    c = app.test_client()
    assert c.get("/api/auth/me").json["setup"] is True                    # nobody yet: set ADMIN_PASSWORD
    assert c.post("/api/auth/setup", json={"username": "boss", "password": "Long#enough1"}).status_code == 404

    app = create_app(app_config(tmp_path, ADMIN_USERNAME="boss", ADMIN_PASSWORD="First#pass1"))
    c = login(app.test_client(), "boss", "First#pass1")
    assert c.get("/api/auth/me").json["user"]["must_change"] is False
    assert c.post("/api/auth/password", json={"current": "First#pass1", "new": "Other#pass1"}).status_code == 403
    assert c.patch("/api/users/boss", json={"password": "Other#pass1"}).status_code == 400

    app = create_app(app_config(tmp_path, ADMIN_USERNAME="boss", ADMIN_PASSWORD="Second#pas1"))   # .env changed
    assert app.test_client().post("/api/auth/login", json={"username": "boss", "password": "First#pass1"}).status_code == 401
    login(app.test_client(), "boss", "Second#pas1")


def test_default_password_must_be_replaced(app, client):
    client.post("/api/users", json={"username": "ana", "password": DEFAULT_PASSWORD, "role": "annotator"})
    ana = login(app.test_client(), "ana", DEFAULT_PASSWORD)
    assert ana.get("/api/auth/me").json["user"]["must_change"] is True
    assert ana.get("/api/tasks").status_code == 403                       # nothing else until it is changed
    assert ana.post("/api/auth/password", json={"current": DEFAULT_PASSWORD, "new": DEFAULT_PASSWORD}).status_code == 400
    r = ana.post("/api/auth/password", json={"current": DEFAULT_PASSWORD, "new": PASSWORD})
    assert r.status_code == 200 and r.json["user"]["must_change"] is False
    assert ana.get("/api/tasks").status_code == 200

    client.patch("/api/users/ana", json={"password": "Reset#pass1"})     # the admin sets a new default
    ana = login(app.test_client(), "ana", "Reset#pass1")
    assert ana.get("/api/tasks").status_code == 403


def test_activity_log(app, client, add_user):
    ana = add_user("ana", "annotator")
    app.test_client().post("/api/auth/login", json={"username": "ana", "password": "wrong"})
    upload(client)
    log = client.get("/api/activity").json
    actions = [(e["username"], e["action"]) for e in log["entries"]]
    assert ("admin", "audio.upload") in actions and ("ana", "login.failed") in actions
    assert ("ana", "password.change") in actions and ("admin", "user.create") in actions
    assert not any(pw in e["detail"] for e in log["entries"] for pw in (DEFAULT_PASSWORD, PASSWORD, ADMIN[1]))
    assert {e["username"] for e in client.get("/api/activity?username=ana").json["entries"]} == {"ana"}
    over = client.get("/api/activity/overview").json
    row = next(u for u in over["users"] if u["username"] == "ana")
    assert row["status"] == "online" and row["failed_today"] == 1 and over["totals"]["users"] == 2
    assert ana.get("/api/activity").status_code == 403


def test_login_logout_and_wrong_passwords(anon):
    assert anon.post("/api/auth/login", json={"username": "admin", "password": "nope"}).status_code == 401
    login(anon, *ADMIN)
    assert anon.get("/api/tasks").status_code == 200
    anon.post("/api/auth/logout")
    assert anon.get("/api/tasks").status_code == 401
    for _ in range(5):
        anon.post("/api/auth/login", json={"username": "admin", "password": "nope"})
    r = anon.post("/api/auth/login", json={"username": "admin", "password": ADMIN[1]})
    assert r.status_code == 429                                          # wait after 5 wrong passwords


def test_user_admin(client, add_user):
    ana = add_user("ana", "annotator")
    users = client.get("/api/users").json
    assert {u["username"] for u in users["users"]} == {"admin", "ana"}
    assert "password_hash" not in users["users"][0] and {r["id"] for r in users["roles"]} >= {"inspector"}
    assert ana.get("/api/users").status_code == 403                      # only the admin manages users
    assert client.post("/api/users", json={"username": "ana", "password": PASSWORD, "role": "annotator"}).status_code == 400
    assert client.post("/api/users", json={"username": "x", "password": PASSWORD, "role": "boss"}).status_code == 400
    assert client.post("/api/users", json={"username": "x", "password": PASSWORD, "role": "viewer"}).status_code == 400

    assert client.patch("/api/users/ana", json={"role": "inspector", "name": "Ana"}).json["role"] == "inspector"
    assert ana.get("/api/auth/me").json["user"]["role"] == "inspector"   # takes effect at once
    client.patch("/api/users/ana", json={"active": False})
    assert ana.get("/api/tasks").status_code == 401                      # deactivated: logged out

    assert client.delete("/api/users/admin").status_code == 400          # not yourself
    assert client.patch("/api/users/admin", json={"role": "inspector"}).status_code == 400
    assert client.delete("/api/users/ana").json == {"ok": True}


def test_password_change_logs_out_other_browsers(app, client, add_user):
    ana, other = add_user("ana", "annotator"), login(app.test_client(), "ana")
    assert ana.post("/api/auth/password", json={"current": "wrong", "new": "New#pass123"}).status_code == 400
    assert ana.post("/api/auth/password", json={"current": PASSWORD, "new": "New#pass123"}).json["ok"] is True
    assert ana.get("/api/tasks").status_code == 200
    assert other.get("/api/tasks").status_code == 401


def test_roles_limit_what_can_be_done(client, add_user):
    ana = add_user("ana", "annotator")
    a = upload(client)
    assert ana.post("/api/audios", data={}, content_type="multipart/form-data").status_code == 403
    assert ana.get("/api/audios").status_code == 403                     # Upload & Crop is for managers
    task = client.post("/api/tasks", json={"name": "T", "audio_ids": [a["id"]]}).json
    assert task["created_by"] == "admin"

    assert ana.get("/api/tasks").json["tasks"] == []                     # not assigned yet
    assert ana.get(f"/api/tasks/{task['id']}").status_code == 403
    assert ana.put(f"/api/audios/{a['id']}/state", json={"segments": []}).status_code == 403

    assert client.put(f"/api/tasks/{task['id']}/members", json={"annotator": ["nobody"]}).status_code == 400
    assert ana.put(f"/api/tasks/{task['id']}/members", json={"annotator": ["ana"]}).status_code == 403
    client.put(f"/api/tasks/{task['id']}/members", json={"annotator": ["ana"]})
    t = ana.get(f"/api/tasks/{task['id']}").json
    assert t["access"] == {"view": True, "edit": True, "review": False, "manage": False}
    assert [x["id"] for x in ana.get("/api/tasks").json["tasks"]] == [task["id"]]
    assert ana.get(f"/api/audios/{a['id']}/peaks").status_code == 200
    assert ana.delete(f"/api/tasks/{task['id']}").status_code == 403
    assert ana.get(f"/api/tasks/{task['id']}/export").status_code == 403
    assert ana.post(f"/api/tasks/{task['id']}/hub-push", json={"repo_id": "a/b"}).status_code == 403
    assert ana.post("/api/hub/inspect", json={"repo": "a/b"}).status_code == 403
    assert ana.post("/api/datasets", json={}).status_code == 403
    assert ana.get("/api/users/directory").status_code == 403
    assert {u["username"] for u in client.get("/api/users/directory").json["users"]} == {"admin", "ana"}


def test_strong_passwords_only(client):
    weak = {"Ab#1": "8 to 12 characters", "Abcdefg#12345": "8 to 12 characters", "abcdef#12": "an upper-case letter",
            "ABCDEF#12": "a lower-case letter", "Abcdef#gh": "a number", "Abcdef123": "a special character",
            "Abc def#12": "no spaces", "Xsokha#1": "no user name inside it"}
    for pw, need in weak.items():
        r = client.post("/api/users", json={"username": "sokha", "password": pw, "role": "annotator"})
        assert r.status_code == 400 and need in r.json["error"], (pw, r.json)
    assert client.post("/api/users", json={"username": "sokha", "password": "Sok#Pass12", "role": "annotator"}).status_code == 201
    assert client.patch("/api/users/sokha", json={"password": "weakpass"}).status_code == 400


def test_weak_admin_password_in_env_stops_the_start(tmp_path):
    import pytest
    with pytest.raises(SystemExit, match="ADMIN_PASSWORD"):
        create_app(app_config(tmp_path, ADMIN_PASSWORD="admin-pass-1"))


def test_activity_report_excel(client, add_user):
    import io as _io
    import time as _time

    from openpyxl import load_workbook

    from api.auth import report

    ana = add_user("ana", "annotator")
    ana.post("/api/auth/logout")
    today = _time.strftime("%Y-%m-%d")
    for qs in ("period=week", "period=month", f"period=custom&since={today}&until={today}"):
        r = client.get(f"/api/activity/report?{qs}&date={today}")
        assert r.status_code == 200 and r.mimetype.endswith("spreadsheetml.sheet"), qs
        wb = load_workbook(_io.BytesIO(r.data))
        assert wb.sheetnames == ["Summary", "Users", "Daily", "Activity log"]
        users = list(wb["Users"].iter_rows(values_only=True))
        assert users[0][:3] == ("Username", "Full Name", "Role")
        row = next(r for r in users if r[0] == "ana")
        assert row[2] == "Annotator" and row[5] >= 1          # signed in
        assert any(r[1] == "admin" and r[4] == "Added a user" for r in wb["Activity log"].iter_rows(values_only=True))
    assert client.get("/api/activity/report?period=custom&since=x&until=y").status_code == 400
    assert ana.get("/api/activity/report?period=week").status_code in (401, 403)
    assert report.period("week", "2026-11-06")[:2] == ("2026-11-02", "2026-11-08")
    assert report.period("month", "2024-02-10")[:2] == ("2024-02-01", "2024-02-29")
