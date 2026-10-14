"""Hugging Face Hub: look at a dataset, read its rows (parquet), push a cleaned dataset back.

Reading uses the parquet files the Hub's dataset viewer makes for every dataset (refs/convert/parquet), or the
repo's own parquet files when the viewer has none. A batch (a range of rows) reads only the row groups it needs, so a
dataset of a million rows can be cleaned 200 rows at a time. A token is only needed for private / gated datasets and
to push; without one, huggingface_hub uses HF_TOKEN or the login saved by `hf auth login`.

Pushing: many batches (or tasks) can go to the same repo. Each push writes its own files
data/<split>-<batch>-NNNNN-of-NNNNN.parquet, replaces only its own earlier files and adds its row to the batch table
of the dataset card.
"""
import json
import os
import re
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request

VIEWER_API = "https://datasets-server.huggingface.co"
SPLIT_NAMES = ("train", "validation", "valid", "dev", "test")
ROW_GROUP = 100              # rows per parquet row group (small groups keep the Hub viewer fast for audio)
SHARD_BYTES = 400 * 1024 ** 2
CARD_START, CARD_END = "<!-- cleaning-report -->", "<!-- /cleaning-report -->"
BATCH_HEAD = ("Batch", "Split", "Clips", "Hours", "Rejected", "Text fixed", "Pushed")

_read_slots = threading.BoundedSemaphore(2)   # parquet reads at the same time (batches import in parallel)
_row_groups_cache = {}
_push_locks, _push_locks_lock = {}, threading.Lock()


def check_repo_id(repo):
    repo = (repo or "").strip().strip("/")
    m = re.match(r"^(?:https?://huggingface\.co/)?(?:datasets/)?([\w.-]+/[\w.-]+)$", repo)
    if not m:
        raise ValueError("Enter a dataset id like seanghay/khmer_mpwt_speech")
    return m.group(1)


def _viewer(endpoint, token=None, **params):
    req = urllib.request.Request(f"{VIEWER_API}/{endpoint}?{urllib.parse.urlencode(params)}",
                                 headers={"Authorization": f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


# ---------- read ----------
def inspect(repo, token=None):
    """{repo, configs: [{name, splits: [{name, rows, files, bytes}], columns: [{name, type}]}], partial}"""
    repo = check_repo_id(repo)
    try:
        files = _viewer("parquet", token, dataset=repo)
        info = _viewer("info", token, dataset=repo).get("dataset_info", {})
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 404):
            files = info = None  # no viewer for it (or private): look at the repo files
        else:
            raise
    if files and files.get("parquet_files"):
        configs = {}
        for f in files["parquet_files"]:
            split = configs.setdefault(f["config"], {}).setdefault(f["split"], {"rows": None, "files": 0, "bytes": 0})
            split["files"] += 1
            split["bytes"] += f.get("size") or 0
        out = []
        for name, splits in configs.items():
            ci = (info or {}).get(name, {})
            for s, v in splits.items():
                v["rows"] = ((ci.get("splits") or {}).get(s) or {}).get("num_examples")
            out.append({"name": name, "splits": [{"name": s, **v} for s, v in splits.items()],
                        "columns": _columns_from_features(ci.get("features") or {})})
        if any(not c["columns"] for c in out):  # info missing: read the schema of the first file
            for c in out:
                if not c["columns"]:
                    first = next(f for f in files["parquet_files"] if f["config"] == c["name"])
                    c["columns"] = _schema_columns(repo, *_resolve_url(first["url"]), token)
        return {"repo": repo, "configs": out, "partial": bool(files.get("partial"))}
    return _inspect_repo_files(repo, token)


def _inspect_repo_files(repo, token):
    groups = _repo_parquet_files(repo, token)
    if not groups:
        raise ValueError(f"{repo}: no parquet files found (and the dataset viewer has none for it)")
    first = next(iter(groups.values()))[0]
    return {"repo": repo, "partial": False,
            "configs": [{"name": "default", "columns": _schema_columns(repo, "main", first, token),
                         "splits": [{"name": s, "rows": None, "files": len(p), "bytes": None} for s, p in groups.items()]}]}


def _repo_parquet_files(repo, token):
    """{split: [path, ...]} from the parquet files in the repo (split guessed from the path)."""
    from huggingface_hub import HfApi

    groups = {}
    for path in sorted(HfApi(token=token).list_repo_files(repo, repo_type="dataset")):
        if path.endswith(".parquet"):
            parts = re.split(r"[/_.-]", path.lower())
            split = next((s for s in SPLIT_NAMES if s in parts), "train")
            groups.setdefault(split, []).append(path)
    return groups


def _columns_from_features(features):
    """datasets features {"audio": {"_type": "Audio"}, "text": {"dtype": "string", ...}} -> [{name, type}]"""
    out = []
    for name, f in features.items():
        f = f if isinstance(f, dict) else {}
        out.append({"name": name, "type": "audio" if f.get("_type") == "Audio" else f.get("dtype") or "other"})
    return out


def _fs_path(repo, revision, path):
    rev = "@" + urllib.parse.quote(revision, safe="") if revision != "main" else ""
    return f"datasets/{repo}{rev}/{path}"


def _schema_columns(repo, revision, path, token):
    import pyarrow as pa
    import pyarrow.parquet as pq
    from huggingface_hub import HfFileSystem

    with HfFileSystem(token=token).open(_fs_path(repo, revision, path), "rb") as f:
        schema = pq.read_schema(f)
    feats = json.loads((schema.metadata or {}).get(b"huggingface", b"{}") or b"{}").get("info", {}).get("features")
    if feats:
        return _columns_from_features(feats)
    out = []
    for field in schema:
        if pa.types.is_struct(field.type) and {"bytes", "path"} <= {c.name for c in field.type}:
            out.append({"name": field.name, "type": "audio"})
        else:
            out.append({"name": field.name, "type": "string" if pa.types.is_string(field.type) else str(field.type)})
    return out


def _resolve_url(url):
    """https://huggingface.co/datasets/<repo>/resolve/<revision>/<path> -> (revision, path)"""
    m = re.search(r"/resolve/([^/]+)/(.+)$", url)
    return urllib.parse.unquote(m.group(1)), urllib.parse.unquote(m.group(2))


def parquet_files(repo, config, split, token=None):
    """[(revision, path)] of the parquet files of one split."""
    try:
        files = _viewer("parquet", token, dataset=repo, config=config, split=split).get("parquet_files") or []
    except urllib.error.HTTPError:
        files = []
    if files:
        return [_resolve_url(f["url"]) for f in files if f["split"] == split]
    return [("main", p) for p in _repo_parquet_files(repo, token).get(split, [])]


def iter_rows(repo, files, columns, token=None, start=0, max_rows=None, on_file=None):
    """Rows (dicts of `columns`) of the parquet files from row `start` on, at most `max_rows`.
    The whole split: every file is downloaded (and cached by huggingface_hub). A batch (start / max_rows): only the
    row groups that hold its rows are read from the Hub."""
    if start or max_rows:
        yield from _iter_range(repo, files, columns, token, start, max_rows, on_file)
        return
    import pyarrow.parquet as pq
    from huggingface_hub import hf_hub_download

    n = 0
    for k, (revision, path) in enumerate(files):
        if on_file:
            on_file(k, len(files))
        local = hf_hub_download(repo, path, revision=revision, repo_type="dataset", token=token)
        pf = pq.ParquetFile(local)
        for g in range(pf.num_row_groups):
            for row in pf.read_row_group(g, columns=columns).to_pylist():
                if max_rows and n >= max_rows:
                    return
                n += 1
                yield row


def _open_parquet(repo, revision, path, token):
    """pyarrow ParquetFile of a file on the Hub (read with HTTP range requests: only what is used is downloaded)."""
    import pyarrow.parquet as pq
    from huggingface_hub import HfFileSystem

    return pq.ParquetFile(HfFileSystem(token=token).open(_fs_path(repo, revision, path), "rb", block_size=8 * 1024 ** 2))


def _row_groups(repo, revision, path, token):
    """Row counts of the row groups of one file (cached: a batch near the end does not read every footer again)."""
    key = (repo, revision, path)
    if key not in _row_groups_cache:
        with _read_slots:
            md = _open_parquet(repo, revision, path, token).metadata
        _row_groups_cache[key] = [md.row_group(g).num_rows for g in range(md.num_row_groups)]
    return _row_groups_cache[key]


def _iter_range(repo, files, columns, token, start, max_rows, on_file):
    offset, n = 0, 0
    for k, (revision, path) in enumerate(files):
        sizes = _row_groups(repo, revision, path, token)
        if offset + sum(sizes) <= start:
            offset += sum(sizes)
            continue
        if on_file:
            on_file(k, len(files))
        pf = None
        for g, size in enumerate(sizes):
            if offset + size <= start:
                offset += size
                continue
            with _read_slots:
                pf = pf or _open_parquet(repo, revision, path, token)
                rows = pf.read_row_group(g, columns=columns).to_pylist()
            for row in rows[max(0, start - offset):]:
                if max_rows and n >= max_rows:
                    return
                n += 1
                yield row
            offset += size


# ---------- push ----------
def whoami(token=None):
    from huggingface_hub import HfApi

    return HfApi(token=token).whoami().get("name")


def write_shards(rows, folder, prefix, columns, progress=None):
    """Write rows ({"audio": {"bytes", "path"}, <column>: value, ...}) as data/<prefix>-NNNNN-of-MMMMM.parquet
    (prefix: the split, or <split>-<batch>). `columns` = [(name, "audio" | "string" | "float" | "int")].
    Returns the number of rows."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    arrow = {"audio": pa.struct([("bytes", pa.binary()), ("path", pa.string())]),
             "string": pa.string(), "float": pa.float64(), "int": pa.int64()}
    hf = {"audio": {"_type": "Audio"}, "string": {"dtype": "string", "_type": "Value"},
          "float": {"dtype": "float64", "_type": "Value"}, "int": {"dtype": "int64", "_type": "Value"}}
    schema = pa.schema([(n, arrow[t]) for n, t in columns],
                       metadata={"huggingface": json.dumps({"info": {"features": {n: hf[t] for n, t in columns}}})})
    os.makedirs(os.path.join(folder, "data"), exist_ok=True)
    shards, writer, size, batch, total = [], None, 0, [], 0

    def flush():
        nonlocal writer, size
        if not batch:
            return
        if writer is None:
            shards.append(os.path.join(folder, "data", f"shard{len(shards)}.tmp"))
            writer = pq.ParquetWriter(shards[-1], schema)
        writer.write_table(pa.Table.from_pylist(batch, schema=schema), row_group_size=ROW_GROUP)
        size += sum(len(r["audio"]["bytes"]) for r in batch)
        batch.clear()
        if size >= SHARD_BYTES:
            writer.close()
            writer, size = None, 0

    for row in rows:
        batch.append(row)
        total += 1
        if len(batch) >= ROW_GROUP:
            flush()
            if progress:
                progress(total)
    flush()
    if writer:
        writer.close()
    for k, tmp in enumerate(shards):
        os.replace(tmp, os.path.join(folder, "data", f"{prefix}-{k:05d}-of-{len(shards):05d}.parquet"))
    return total


def dataset_card(old_card, repo_id, splits, columns, intro, batch):
    """README.md: the old card's text is kept; the YAML header gets this repo's configs; the cleaning report
    (between CARD_START / CARD_END) gets `intro` and a table with one row per pushed batch: `batch` (a dict with the
    BATCH_HEAD cells) replaces the row of the same batch and split, or is added."""
    import yaml

    header, body = {}, old_card or ""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", body, re.S)
    if m:
        header, body = yaml.safe_load(m.group(1)) or {}, body[m.end():]
    header.pop("dataset_info", None)  # sizes / features of the old files are no longer right
    header["configs"] = [{"config_name": "default",
                          "data_files": [{"split": s, "path": f"data/{s}-*"} for s in sorted(splits)]}]
    header.setdefault("language", ["km"])
    header.setdefault("task_categories", ["automatic-speech-recognition"])
    old = re.search(re.escape(CARD_START) + "(.*?)" + re.escape(CARD_END), body, re.S)
    rows = _batch_rows(old.group(1) if old else "")
    cell = lambda v: str(v).replace("|", "/").replace("\n", " ").strip()
    new = [cell(batch.get(h, "")) for h in BATCH_HEAD]
    at = next((k for k, r in enumerate(rows) if r[:2] == new[:2]), None)
    if at is None:
        rows.append(new)
    else:
        rows[at] = new
    num = lambda v, f: f(v) if re.fullmatch(r"[\d.]+", v) else 0
    total = ["**Total**", "", f"**{sum(num(r[2], int) for r in rows)}**",
             f"**{sum(num(r[3], float) for r in rows):.2f}**", str(sum(num(r[4], int) for r in rows)),
             str(sum(num(r[5], int) for r in rows)), ""]
    line = lambda cells: "| " + " | ".join(cells) + " |"
    body = re.sub(re.escape(CARD_START) + ".*?" + re.escape(CARD_END), "", body, flags=re.S).strip()
    if not body:
        body = f"# {repo_id.split('/')[-1]}\n"
    feats = "\n".join(f"| `{n}` | {t} |" for n, t in columns)
    report_md = "\n".join([CARD_START, "## Cleaning report", "", intro, "", "### Batches", "",
                            line(BATCH_HEAD), "|---|---|---:|---:|---:|---:|---|", *map(line, rows), line(total), "",
                            "| Column | Type |", "|---|---|", feats, CARD_END])
    return "---\n" + yaml.safe_dump(header, allow_unicode=True, sort_keys=False) + "---\n\n" + body + "\n\n" + report_md + "\n"


def _batch_rows(report):
    """Rows of the batch table of an earlier report (list of cell lists)."""
    rows, inside = [], False
    for ln in report.splitlines():
        if ln.startswith("| " + BATCH_HEAD[0] + " |"):
            inside = True
            continue
        if inside:
            if not ln.startswith("|"):
                break
            cells = [c.strip() for c in ln.strip().strip("|").split("|")]
            if len(cells) == len(BATCH_HEAD) and not set(ln) <= set("|-: ") and cells[0] != "**Total**":
                rows.append(cells)
    return rows


def replace_pattern(prefix):
    """The files a push replaces: its own earlier shards only (data/train-00000-of-00001.parquet of a whole-split push
    does not match data/train-rows-...-00000-of-00001.parquet of a batch, nor the other way round)."""
    return f"data/{prefix}-[0-9][0-9][0-9][0-9][0-9]-of-[0-9][0-9][0-9][0-9][0-9].parquet"


def push(folder, repo_id, split, card_fn, token=None, private=True, create_pr=False, message="Upload cleaned dataset",
         prefix=None):
    """Upload `folder` (data/<prefix>-*.parquet) to a dataset repo, replacing only this prefix's earlier files
    (prefix = split, or <split>-<batch>); other batches and splits stay. card_fn(old_card, splits) -> README text.
    Pushes to one repo are made one at a time here, and a commit made meanwhile elsewhere is retried.
    Returns the commit or pull request URL."""
    from huggingface_hub import HfApi
    from huggingface_hub.utils import EntryNotFoundError, HfHubHTTPError, RepositoryNotFoundError

    api = HfApi(token=token)
    repo_id, prefix = check_repo_id(repo_id), prefix or split
    with _push_locks_lock:
        lock = _push_locks.setdefault(repo_id, threading.Lock())
    with lock:
        if not create_pr:
            api.create_repo(repo_id, repo_type="dataset", private=private, exist_ok=True)
        for attempt in range(3):
            try:
                head = api.repo_info(repo_id, repo_type="dataset").sha
                existing = api.list_repo_files(repo_id, repo_type="dataset", revision=head)
            except RepositoryNotFoundError:
                raise ValueError(f"{repo_id} does not exist - a pull request needs an existing repo")
            splits = {split} | {m.group(1) for f in existing if (m := re.match(r"^data/(\w+)-.*\.parquet$", f))}
            old_card = ""
            if "README.md" in existing:
                try:
                    with open(api.hf_hub_download(repo_id, "README.md", repo_type="dataset", revision=head),
                              encoding="utf-8") as f:
                        old_card = f.read()
                except EntryNotFoundError:
                    pass
            with open(os.path.join(folder, "README.md"), "w", encoding="utf-8") as f:
                f.write(card_fn(old_card, splits))
            try:
                info = api.upload_folder(repo_id=repo_id, repo_type="dataset", folder_path=folder,
                                         commit_message=message, delete_patterns=[replace_pattern(prefix)],
                                         create_pr=create_pr, parent_commit=None if create_pr else head)
                return info.pr_url or info.commit_url or f"https://huggingface.co/datasets/{repo_id}"
            except HfHubHTTPError as e:   # someone else committed since `head`: read the card again
                if attempt == 2 or getattr(e.response, "status_code", None) not in (409, 412):
                    raise


def temp_folder():
    return tempfile.mkdtemp(prefix="asr_push_")
