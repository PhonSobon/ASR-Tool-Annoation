"""Background jobs on a dataset (import, checks, push to the Hub): one at a time per dataset, in a thread.

The browser polls the job's progress; jobs live in memory only (a restart forgets them, the data on disk stays).
"""
import threading
import traceback

from flask import current_app

_jobs = {}
_lock = threading.Lock()


class Job:
    def __init__(self, kind):
        self.kind, self.done, self.total, self.message = kind, 0, 0, "Starting…"
        self.running, self.error, self.result, self.stop_requested = True, None, None, False

    def progress(self, done, total=None, message=None):
        self.done = done
        if total is not None:
            self.total = total
        if message is not None:
            self.message = message

    @property
    def stopped(self):
        return self.stop_requested

    def to_dict(self):
        return {"kind": self.kind, "done": self.done, "total": self.total, "message": self.message,
                "running": self.running, "error": self.error, "result": self.result}


def start(key, kind, fn):
    """Run fn(job) in a thread inside the app context. Raises RuntimeError if a job already runs for `key`."""
    app = current_app._get_current_object()
    with _lock:
        if key in _jobs and _jobs[key].running:
            raise RuntimeError(f"Wait until the running {_jobs[key].kind} job has finished")
        job = _jobs[key] = Job(kind)

    def run():
        with app.app_context():
            try:
                job.result = fn(job)
            except Exception as e:
                app.logger.error("%s job failed:\n%s", kind, traceback.format_exc())
                job.error = str(e) or e.__class__.__name__
                job.message = "Failed: " + job.error
            finally:
                job.running = False

    threading.Thread(target=run, daemon=True, name=f"{kind}-{key}").start()
    return job


def get(key):
    job = _jobs.get(key)
    return job.to_dict() if job else None


def running(key):
    job = _jobs.get(key)
    return bool(job and job.running)


def stop(key):
    job = _jobs.get(key)
    if job and job.running:
        job.stop_requested = True
        job.message = "Stopping…"
