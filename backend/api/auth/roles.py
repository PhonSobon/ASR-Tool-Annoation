"""Roles and what each one may do. A route asks for a permission, never for a role, so a role can be changed here.

    admin       everything, and manages the users
    manager     uploads audio, makes tasks, imports datasets, assigns people, exports and pushes to the Hub
    annotator   annotates the packages of the tasks they are assigned to; reviews clips of assigned datasets
    inspector   the reviewer: accepts or returns the completed packages of assigned tasks (may fix the text) - one
                review step; the old "acceptor" role was merged into it (users.merge_old_roles)
The old "viewer" role was removed: such users become annotators (users.merge_old_roles).
"""
ROLES = {
    "admin": ("Administrator", "Adds every account, sees every user's status and the full activity log."),
    "manager": ("Project Manager", "Uploads audio, makes tasks, imports datasets, assigns people, exports."),
    "annotator": ("Annotator", "Annotates the packages and dataset clips they are assigned to."),
    "inspector": ("Reviewer", "Reviews completed packages: accept, fix the text, or return to the annotator."),
}

_ALL = set(ROLES)
_STAFF = {"admin", "manager"}
_WORKERS = {"annotator", "inspector"}

PERMISSIONS = {
    "users.manage": {"admin"},
    "audio.upload": _STAFF,                                  # Upload & Crop, push audio to a new task
    "task.manage": _STAFF,                                   # delete tasks, assign people
    "task.view_all": _STAFF,                                 # the others see only the tasks they are assigned to
    "task.annotate": _STAFF | {"annotator"},
    "task.review": _STAFF | {"inspector"},                    # accept or return completed packages
    "asr.run": _STAFF | _WORKERS,
    "data.export": _STAFF,                                   # ZIP downloads
    "hub.push": _STAFF,
    "dataset.manage": _STAFF,                                # import, run checks, delete, assign
    "dataset.view_all": _STAFF,
    "dataset.review": _STAFF | _WORKERS,                     # accept / reject / fix clips of assigned datasets
    "dataset.bulk_accept": _STAFF | {"inspector"},
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
