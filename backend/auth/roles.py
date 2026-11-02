"""Roles and what each one may do. A route asks for a permission, never for a role, so a role can be changed here.

    admin       everything, and manages the users
    manager     uploads audio, makes tasks, imports datasets, assigns people, exports and pushes to the Hub
    annotator   annotates the packages of the tasks they are assigned to; reviews clips of assigned datasets
    inspector   quality check: passes or returns the completed packages of assigned tasks (may fix the text)
    acceptor    final acceptance of the packages that passed inspection
    viewer      sees every task and dataset, changes nothing
"""
ROLES = {
    "admin": ("Administrator", "Adds every account, sees every user's status and the full activity log."),
    "manager": ("Project Manager", "Uploads audio, makes tasks, imports datasets, assigns people, exports."),
    "annotator": ("Annotator", "Annotates the packages and dataset clips they are assigned to."),
    "inspector": ("Quality Inspector", "Checks completed packages: pass, fix the text, or return."),
    "acceptor": ("Acceptor", "Final acceptance of the packages that passed inspection."),
    "viewer": ("Viewer", "Sees every task and dataset, changes nothing."),
}

_ALL = set(ROLES)
_STAFF = {"admin", "manager"}
_WORKERS = {"annotator", "inspector", "acceptor"}

PERMISSIONS = {
    "users.manage": {"admin"},
    "audio.upload": _STAFF,                                  # Upload & Crop, push audio to a new task
    "task.manage": _STAFF,                                   # delete tasks, assign people
    "task.view_all": _STAFF | {"viewer"},                    # the others see only the tasks they are assigned to
    "task.annotate": _STAFF | {"annotator"},
    "task.inspect": _STAFF | {"inspector"},
    "task.accept": _STAFF | {"acceptor"},
    "asr.run": _STAFF | _WORKERS,
    "data.export": _STAFF,                                   # ZIP downloads
    "hub.push": _STAFF,
    "dataset.manage": _STAFF,                                # import, run checks, delete, assign
    "dataset.view_all": _STAFF | {"viewer"},
    "dataset.review": _STAFF | _WORKERS,                     # accept / reject / fix clips of assigned datasets
    "dataset.bulk_accept": _STAFF | {"inspector", "acceptor"},
}
assert all(roles <= _ALL for roles in PERMISSIONS.values())


def permissions(role):
    return sorted(p for p, roles in PERMISSIONS.items() if role in roles)


def has(user, perm):
    return bool(user) and user.get("role") in PERMISSIONS[perm]


def role_list():
    """[{id, label, description, permissions}] for the user admin page."""
    return [{"id": r, "label": label, "description": desc, "permissions": permissions(r)}
            for r, (label, desc) in ROLES.items()]
