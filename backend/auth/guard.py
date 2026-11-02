"""Who is asking: the logged-in user (Flask session cookie) and the permission checks of the routes.

Every /api/ request needs a login, except /api/auth/* (sign in, who am I). A user still on the default password from
the administrator may only use /api/auth/* until they have chosen their own.
"""
import functools
import time

from flask import abort, current_app, g, request, session

from . import roles, users

FAIL_LIMIT, FAIL_WAIT = 5, 60   # after 5 wrong passwords for a user name, wait 60 s
SEEN_EVERY = 60                 # write last_seen at most once a minute per user


def login(user):
    session.clear()
    session.permanent = True
    session["user"], session["sv"] = user["username"], user.get("sv", 1)


def logout():
    session.clear()


def current_user():
    """The logged-in, active user (dict with the password hash), or None."""
    if "user" not in g:
        g.user = None
        if session.get("user"):
            try:
                user = users.get(session["user"])
            except users.UserNotFound:
                user = None
            if user and user.get("active", True) and user.get("sv", 1) == session.get("sv"):
                g.user = user
    return g.user


def profile(user):
    """What the browser knows about a user: no password hash; the role's permissions and label."""
    return {**users.public(user), "permissions": roles.permissions(user["role"]),
            "role_label": roles.ROLES[user["role"]][0]}


def username():
    user = current_user()
    return user["username"] if user else ""


def can(perm):
    return roles.has(current_user(), perm)


def need(perm, message=None):
    """Abort with 403 unless the user has the permission."""
    if not can(perm):
        abort(403, message or "Your role cannot do this")


def require(perm):
    """Route decorator: the user must have `perm`."""
    def wrap(fn):
        @functools.wraps(fn)
        def inner(*args, **kwargs):
            need(perm)
            return fn(*args, **kwargs)
        return inner
    return wrap


def check_api_login():
    """before_request: /api/ needs a logged-in user (the auth endpoints excepted) who has chosen their own password."""
    if not request.path.startswith("/api/"):
        return
    user = current_user()
    if user:
        _seen(user["username"])
    if request.path.startswith("/api/auth/"):
        return
    if not user:
        abort(401, "Please log in")
    if user.get("must_change"):
        abort(403, "Choose your own password first")


def _seen(name):
    seen = current_app.extensions.setdefault("last_seen", {})
    if time.time() - seen.get(name, 0) >= SEEN_EVERY:
        seen[name] = time.time()
        users.touch(name)


# ---------- wrong passwords (in memory, per app) ----------
def _failures():
    return current_app.extensions.setdefault("login_failures", {})


def blocked(name):
    """Seconds to wait before the next try for this user name (0 = may try now)."""
    fails, last = _failures().get(name, (0, 0))
    left = FAIL_WAIT - (time.time() - last)
    return int(left) + 1 if fails >= FAIL_LIMIT and left > 0 else 0


def failed(name):
    fails, last = _failures().get(name, (0, 0))
    if time.time() - last > FAIL_WAIT:
        fails = 0
    _failures()[name] = (fails + 1, time.time())


def succeeded(name):
    _failures().pop(name, None)
