"""User accounts (table "users", api/core/db.py). Passwords are stored as salted hashes (werkzeug).
"sv" (session version) goes up when the password changes, so the browsers still logged in with the old password are
logged out.

An administrator gives each new user a default password; "must_change" stays on until the user has chosen their own
(set again when the administrator sets a new default). Administrators never change their own password: the main one
comes from ADMIN_USERNAME / ADMIN_PASSWORD in .env (ensure_admin, at every start), others get theirs from an admin.
"""
import re

from sqlalchemy import func, select
from werkzeug.security import check_password_hash, generate_password_hash

from ..core import db
from ..core.db import User
from ..core.storage import NotFound, now
from .roles import ROLES

USERNAME = re.compile(r"^[a-z0-9][a-z0-9._-]{1,31}$")
MIN_PASSWORD, MAX_PASSWORD = 8, 12
# a strong password: (rule, what it needs). frontend/src/lib/password.ts shows the same list while typing.
PASSWORD_RULES = (
    (lambda p, u: MIN_PASSWORD <= len(p) <= MAX_PASSWORD, f"{MIN_PASSWORD} to {MAX_PASSWORD} characters"),
    (lambda p, u: re.search(r"[A-Z]", p), "an upper-case letter (A-Z)"),
    (lambda p, u: re.search(r"[a-z]", p), "a lower-case letter (a-z)"),
    (lambda p, u: re.search(r"[0-9]", p), "a number (0-9)"),
    (lambda p, u: re.search(r"[^A-Za-z0-9\s]", p), "a special character (! @ # $ % ...)"),
    (lambda p, u: not re.search(r"\s", p), "no spaces"),
    (lambda p, u: not u or u.lower() not in p.lower(), "no user name inside it"),
)
COLUMNS = ("username", "name", "role", "active", "password_hash", "sv", "created", "updated",
           "must_change", "last_login", "last_seen")


class UserNotFound(NotFound):
    pass


def _dict(row):
    return {c: getattr(row, c) for c in COLUMNS}


def public(user):
    """A user without the password hash (what the API returns)."""
    out = {k: v for k, v in user.items() if k not in ("password_hash", "sv")}
    out["must_change"] = bool(out.get("must_change"))
    return out


def count():
    with db.transaction() as s:
        return s.scalar(select(func.count()).select_from(User))


def get(username):
    with db.transaction() as s:
        row = s.get(User, (username or "").strip().lower())
        if not row:
            raise UserNotFound("User not found")
        return _dict(row)


def list_users():
    with db.transaction() as s:
        rows = [public(_dict(r)) for r in s.scalars(select(User))]
    return sorted(rows, key=lambda u: (list(ROLES).index(u["role"]), u["username"]))


def exists(username):
    with db.transaction() as s:
        return s.get(User, (username or "").strip().lower()) is not None


def check_password(password, username=""):
    """ValueError listing what a weak password is missing (PASSWORD_RULES)."""
    missing = [need for rule, need in PASSWORD_RULES if not rule(password or "", username or "")]
    if missing:
        raise ValueError("The password is not strong enough. It needs: " + "; ".join(missing))


def _check_role(role):
    if role not in ROLES:
        raise ValueError(f"Unknown role {role!r}")


def create(username, password, role, name="", must_change=None):
    """A new account. Everyone but an administrator must choose their own password at the first sign-in."""
    username = (username or "").strip().lower()
    if not USERNAME.match(username):
        raise ValueError("User name: 2-32 lower-case letters, digits, '.', '_' or '-'")
    _check_role(role)
    check_password(password, username)
    with db.transaction() as s:
        if s.get(User, username):
            raise ValueError(f"The user {username} already exists")
        row = User(username=username, name=(name or "").strip() or username, role=role, active=True,
                   password_hash=generate_password_hash(password), sv=1, created=now(), updated=now(),
                   must_change=role != "admin" if must_change is None else bool(must_change))
        s.add(row)
        return public(_dict(row))


def _active_admins(s):
    return s.scalar(select(func.count()).select_from(User).where(User.role == "admin", User.active.is_(True)))


def update(username, name=None, role=None, active=None, password=None, must_change=None):
    """Change a user. The last active administrator cannot lose that role or be deactivated."""
    if role is not None:
        _check_role(role)
    if password is not None:
        check_password(password, username)
    with db.transaction() as s:
        user = db.locked(s, User, (username or "").lower())
        if not user:
            raise UserNotFound("User not found")
        was_admin = user.role == "admin" and user.active
        if name is not None:
            user.name = str(name).strip() or user.username
        if role is not None:
            user.role = role
        if active is not None:
            user.active = bool(active)
        if password is not None:
            user.password_hash = generate_password_hash(password)
            user.sv = (user.sv or 1) + 1
        if must_change is not None:
            user.must_change = bool(must_change)
        user.updated = now()
        s.flush()
        if was_admin and not _active_admins(s):
            raise ValueError("Keep at least one active administrator")   # rolls the change back
        return public(_dict(user))


def delete(username):
    with db.transaction() as s:
        user = db.locked(s, User, (username or "").lower())
        if not user:
            raise UserNotFound("User not found")
        s.delete(user)
        s.flush()
        if user.role == "admin" and not _active_admins(s):
            raise ValueError("Keep at least one active administrator")


def authenticate(username, password):
    """The user if the password is right and the account is active, else None."""
    try:
        user = get(username)
    except UserNotFound:
        check_password_hash(generate_password_hash("x"), password or "")  # same time for unknown names
        return None
    if not user.get("active", True) or not check_password_hash(user["password_hash"], password or ""):
        return None
    return user


def same_password(user, password):
    return check_password_hash(user["password_hash"], password or "")


def touch(username, login=False):
    """Note that the user was here now (last_seen; and last_login when signing in)."""
    with db.transaction() as s:
        user = s.get(User, username)
        if user:
            user.last_seen = now()
            if login:
                user.last_login = user.last_seen


OLD_ROLES = {"acceptor": "inspector",   # inspection and acceptance are one review step now
             "viewer": "annotator"}     # the viewer role was removed; unassigned annotators see nothing


def merge_old_roles():
    """Users with a removed role get its replacement (OLD_ROLES). Runs at start-up; returns how many were changed."""
    with db.transaction() as s:
        rows = list(s.scalars(select(User).where(User.role.in_(OLD_ROLES))))
        for u in rows:
            u.role, u.updated = OLD_ROLES[u.role], now()
            u.sv = (u.sv or 1) + 1                       # sign them out: their permissions changed
    return len(rows)


def ensure_admin(username, password):
    """The administrator of .env: made if missing; else kept an active admin with this password (only re-hashed when
    it changed, so a restart does not log them out)."""
    username = (username or "").strip().lower()
    check_password(password, username)   # also when unchanged: a weak ADMIN_PASSWORD stops the start
    if not exists(username):
        return create(username, password, "admin")
    user = get(username)
    changes = {} if same_password(user, password) else {"password": password}
    if user["role"] != "admin" or not user.get("active", True):
        changes.update(role="admin", active=True)
    if changes:
        update(username, must_change=False, **changes)


def directory():
    """Active users for the assignment dialogs: [{username, name, role}]."""
    return [{"username": u["username"], "name": u["name"], "role": u["role"]}
            for u in list_users() if u.get("active", True)]
