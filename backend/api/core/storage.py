"""Data on disk: JSON files written atomically, timestamps, and the "not found" error every store raises."""
import json
import os
import time


class NotFound(Exception):
    """A missing audio, task, dataset or user (answered with 404)."""


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)
