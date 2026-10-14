"""Tasks: push audio from Upload & Crop into a batch, list (My Tasks), open, delete, push the annotations to the Hub."""
import re
import shutil

from flask import Blueprint, current_app, jsonify, request

from ..services import audio, audios, hub, jobs, tasks
from ..services.audios import now

bp = Blueprint("tasks", __name__, url_prefix="/api/tasks")


@bp.get("")
def list_tasks():
    return jsonify(tasks=tasks.list_tasks())


@bp.post("")
def push():
    """Body: {name, audio_ids: [...]} -> new task with those audio."""
    data = request.get_json(force=True) or {}
    try:
        return jsonify(tasks.create_task(data.get("name"), data.get("audio_ids") or [])), 201
    except ValueError as e:
        return jsonify(error=str(e)), 400


@bp.get("/<task_id>")
def get_task(task_id):
    return jsonify(tasks.get(task_id))


@bp.delete("/<task_id>")
def delete_task(task_id):
    tasks.delete_task(task_id)
    return jsonify(ok=True)


# ---------- push to the Hugging Face Hub (background job) ----------
def _job_key(task_id):
    return f"task-{task_id}"


@bp.get("/<task_id>/job")
def job(task_id):
    return jsonify(job=jobs.get(_job_key(task_id)))


@bp.post("/<task_id>/stop")
def stop(task_id):
    jobs.stop(_job_key(task_id))
    return jsonify(job=jobs.get(_job_key(task_id)))


@bp.post("/<task_id>/hub-push")
def hub_push(task_id):
    """{repo_id, split?, include?: "done" | "with_text", private?, create_pr?, token?}: upload the annotated segments
    as parquet to a Hub dataset repo (background job; the result has the commit or pull request URL)."""
    data, task = request.get_json(force=True, silent=True) or {}, tasks.summary(task_id)
    try:
        repo_id = hub.check_repo_id(data.get("repo_id"))
    except ValueError as e:
        return jsonify(error=str(e)), 400
    split = (data.get("split") or "train").strip()
    if not re.match(r"^\w+$", split):
        return jsonify(error="The split name may only use letters, digits and _"), 400
    include = data.get("include") if data.get("include") in tasks.INCLUDE else "done"
    token = (data.get("token") or "").strip() or None
    private, create_pr = bool(data.get("private", True)), bool(data.get("create_pr"))
    sr = current_app.config["SAMPLE_RATE"]

    def run(job):
        segments = tasks.hub_segments(task_id, include)
        total = len(segments)
        if not total:
            raise ValueError("Nothing to push - no completed package with text yet" if include == "done"
                             else "Nothing to push - no segment has text yet")
        stats = {"seconds": 0.0}

        def rows():
            for audio_id, audio_name, s in segments:
                if job.stopped:
                    raise RuntimeError("Stopped")
                pcm = audio.clip(audio.load_pcm(audios.wav_path(audio_id)), s["start"], s["end"], sr)
                duration = round(len(pcm) / sr, 3)
                stats["seconds"] += duration
                yield tasks.hub_row(task["name"], audio_name, s, audio.wav_bytes(pcm, sr), duration)

        folder = hub.temp_folder()
        try:
            job.progress(0, total, "Preparing parquet files…")
            prefix = f"{split}-task-{task_id}"   # each task has its own files: many tasks go to one repo
            hub.write_shards(rows(), folder, prefix, tasks.HUB_COLUMNS,
                             progress=lambda k: job.progress(k, total, f"Preparing {k} / {total} segments…"))
            job.progress(total, total, f"Uploading {total} segments to {repo_id}…")
            row = {"Batch": f"task {task['name']}", "Split": split, "Clips": total,
                   "Hours": f"{stats['seconds'] / 3600:.2f}", "Rejected": "–", "Text fixed": "–", "Pushed": now()[:10]}
            url = hub.push(folder, repo_id, split, lambda old, splits: hub.dataset_card(
                old, repo_id, splits, tasks.HUB_COLUMNS, _report(include), row),
                token, private, create_pr, f"Upload annotated task {task['name']} ({total} segments)", prefix=prefix)
        finally:
            shutil.rmtree(folder, ignore_errors=True)
        tasks.set_last_push(task_id, {"repo": repo_id, "split": split, "url": url, "at": now(), "count": total,
                                      "pr": create_pr})
        job.message = ("Pull request opened" if create_pr else "Pushed") + f": {url}"
        return {"url": url}

    try:
        jobs.start(_job_key(task_id), "push", run)
    except RuntimeError as e:
        return jsonify(error=str(e)), 409
    return jsonify(job=jobs.get(_job_key(task_id)))


def _report(include):
    """What every task pushed to the repo has in common (the numbers per task are in the card's batch table)."""
    kept = "completed packages (every segment has text)" if include == "done" else "every segment with text"
    return "\n".join([
        f"- Source: annotation tasks made with this tool; each task keeps its {kept}; 16 kHz mono WAV",
        "- `text`: the annotation text; `text_normalized`: normalized for training (zero-width spaces removed, Khmer "
        "digits written 0-9, words separated by spaces with khmercut), corrected by the annotator where needed",
        "- `task`, `source_audio`, `start`, `end`: the task and where the segment is in the original recording; "
        "`role` and `speaker_*`: who speaks; the other columns describe the recording (language, accent, domain, ...)",
    ])
