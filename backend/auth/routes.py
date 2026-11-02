"""Sign in, own password, the user admin and the activity log (Administrator only).

There is no sign-up: the administrator of .env (ADMIN_USERNAME / ADMIN_PASSWORD) adds every other account with a
default password, which its owner replaces with their own at the first sign-in. Administrators do not change their own
password here.
"""
from flask import Blueprint, current_app, jsonify, request

from . import activity, guard, roles, users, workload
from .guard import require

bp = Blueprint("auth", __name__, url_prefix="/api")


def _body():
    return request.get_json(force=True, silent=True) or {}


# ---------- session ----------
def _env_admin():
    return (current_app.config.get("ADMIN_USERNAME") or "").strip().lower()


@bp.get("/auth/me")
def me():
    """{user: {..., permissions, must_change} | null, setup: true when no account exists (set ADMIN_PASSWORD in .env)}."""
    user = guard.current_user()
    return jsonify(user=guard.profile(user) if user else None, setup=users.count() == 0)


@bp.post("/auth/login")
def login():
    data = _body()
    name = (data.get("username") or "").strip().lower()
    if wait := guard.blocked(name):
        return jsonify(error=f"Too many wrong passwords - try again in {wait} s"), 429
    user = users.authenticate(name, data.get("password"))
    if not user:
        guard.failed(name)
        if users.exists(name):
            activity.log(users.get(name), "login.failed", ok=False)
        return jsonify(error="Wrong user name or password (or the account is deactivated)"), 401
    guard.succeeded(name)
    guard.login(user)
    users.touch(user["username"], login=True)
    activity.log(user, "login", "default password - must choose their own" if user.get("must_change") else "")
    return jsonify(user=guard.profile(user))


@bp.post("/auth/logout")
def logout():
    if user := guard.current_user():
        activity.log(user, "logout")
    guard.logout()
    return jsonify(ok=True)


@bp.post("/auth/password")
def change_password():
    """{current, new}: choose your own password (you stay signed in here, other browsers are signed out).
    Administrators cannot: theirs comes from .env or from another administrator."""
    user, data = guard.current_user(), _body()
    if not user:
        return jsonify(error="Please log in"), 401
    if user["role"] == "admin":
        return jsonify(error="An administrator's password is set by the system (ADMIN_PASSWORD in .env) "
                             "and cannot be changed here"), 403
    if not users.authenticate(user["username"], data.get("current")):
        return jsonify(error="The current password is wrong"), 400
    if data.get("new") == data.get("current"):
        return jsonify(error="Choose a password different from the current one"), 400
    try:
        users.update(user["username"], password=data.get("new"), must_change=False)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    guard.login(users.get(user["username"]))
    activity.log(user, "password.change")
    return jsonify(ok=True, user=guard.profile(users.get(user["username"])))


# ---------- users (admin) ----------
@bp.get("/users")
@require("users.manage")
def list_users():
    """{users, roles, env_admin: the administrator of .env (its password is set there)}"""
    return jsonify(users=users.list_users(), roles=roles.role_list(), env_admin=_env_admin())


@bp.get("/users/directory")
def directory():
    """Active users (name and role) for the assignment dialogs of tasks and datasets."""
    if not (guard.can("task.manage") or guard.can("dataset.manage")):
        return jsonify(error="Your role cannot assign people"), 403
    return jsonify(users=users.directory())


@bp.post("/users")
@require("users.manage")
def create_user():
    """{username, password, role, name?}: the password is a default one; the user chooses their own at the first
    sign-in (administrators keep it)."""
    data = _body()
    try:
        return jsonify(users.create(data.get("username"), data.get("password"), data.get("role"), data.get("name"))), 201
    except ValueError as e:
        return jsonify(error=str(e)), 400


@bp.patch("/users/<username>")
@require("users.manage")
def update_user(username):
    """{name?, role?, active?, password?}: a new password is a default one again (the user must replace it)."""
    data = _body()
    username = username.strip().lower()
    if username == guard.username() and (data.get("active") is False or data.get("role") not in (None, "admin")):
        return jsonify(error="You cannot deactivate yourself or take away your own admin role"), 400
    if "password" in data and username in (guard.username(), _env_admin()):
        return jsonify(error="This administrator's password is set in .env (ADMIN_PASSWORD), not here"
                       if username == _env_admin() else "You cannot change your own password"), 400
    changes = {k: data[k] for k in ("name", "role", "active", "password") if k in data}
    if "password" in data:
        changes["must_change"] = data.get("role", users.get(username)["role"]) != "admin"
    try:
        return jsonify(users.update(username, **changes))
    except ValueError as e:
        return jsonify(error=str(e)), 400


@bp.delete("/users/<username>")
@require("users.manage")
def delete_user(username):
    if username == guard.username():
        return jsonify(error="You cannot delete yourself"), 400
    try:
        users.delete(username)
    except ValueError as e:
        return jsonify(error=str(e)), 400
    return jsonify(ok=True)


# ---------- activity (admin) ----------
@bp.get("/activity")
@require("users.manage")
def activity_log():
    """?username=&role=&action=&since=YYYY-MM-DD&until=YYYY-MM-DD&q=&page=&per= -> {entries, total, page, pages}"""
    a = request.args
    return jsonify(activity.entries(a.get("username", ""), a.get("role", ""), a.get("action", ""), a.get("since", ""),
                                    a.get("until", ""), a.get("q", ""), a.get("page", 1, type=int),
                                    a.get("per", 50, type=int)))


@bp.get("/activity/overview")
@require("users.manage")
def activity_overview():
    """Every user's status (online, signed out, never signed in, default password, deactivated) and work counts."""
    return jsonify(activity.overview())


@bp.get("/activity/work")
@require("users.manage")
def activity_work():
    """?since=YYYY-MM-DD&until=YYYY-MM-DD -> what every user produced: annotation hours, returns, acceptances,
    reviews and dataset clips (the Work Dashboard)."""
    return jsonify(workload.stats(request.args.get("since", ""), request.args.get("until", "")))
