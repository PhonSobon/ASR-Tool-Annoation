# HTTP API

The web UI talks to the Flask backend through this JSON API. You can use it from scripts too. Errors come back as `{"error": "..."}` with a 4xx or 5xx status. Long work (imports, ASR checks, pushes to the Hub) runs as a background **job**; poll its `/job` URL for progress.

Every call except `/api/auth/*` needs a login: `POST /api/auth/login` sets a session cookie (keep it, e.g. with `requests.Session()`). Without one the answer is `401`; a role without the permission gets `403`. Permissions per role are in `backend/auth/roles.py`.

## Login and users

| Method | URL | Purpose |
|---|---|---|
| GET | `/api/auth/me` | `{user: {username, name, role, permissions, must_change, last_login} \| null, setup}` (`setup`: no account exists - set `ADMIN_PASSWORD` in `.env`) |
| POST | `/api/auth/login` | `{username, password}` |
| POST | `/api/auth/logout` | |
| POST | `/api/auth/password` | Choose your own password `{current, new}` (not for administrators). While `must_change` is true (default password from the admin), every other `/api/` request answers 403 |
| GET | `/api/users` | Users and roles (admin) |
| POST | `/api/users` | Add a user `{username, password, role, name?}`; the password is a default one the user must replace (admin) |
| PATCH / DELETE | `/api/users/<username>` | Change `{name?, role?, active?, password?}` (a password is a new default; not for yourself or the `.env` admin) / delete (admin) |
| GET | `/api/activity` | Activity log `?username=&role=&action=&since=&until=&q=&page=&per=` -> `{entries, total, page, pages}` (admin) |
| GET | `/api/activity/overview` | Every user's status and work counts today / 7 days (admin) |
| GET | `/api/activity/work` | Work Dashboard `?since=&until=` (YYYY-MM-DD) -> per user: `annotation {done, done_seconds, in_progress, returned, accepted, accepted_seconds, passed}`, `review {inspected, accepted, returned}`, `cleaning {accepted, rejected, accepted_seconds}`, and `totals` (admin) |
| GET | `/api/users/directory` | Active users for the members dialogs (managers) |

## Audio and tasks (workflow 1)

| Method | URL | Purpose |
|---|---|---|
| GET | `/api/audios` | Audio still in Upload & Crop (`?task=<id>`: the audio of a task) |
| POST | `/api/audios` | Upload one audio file (`multipart`: `audio`) |
| GET / DELETE | `/api/audios/<id>` | Open an audio with its segments / delete it |
| PUT | `/api/audios/<id>/state` | Autosave segments `{segments, changed?}` (`changed`: indexes of the packages edited; the review fields of packages are always kept) |
| POST | `/api/audios/<id>/recut` | Cut into fixed-length segments `{chunk_seconds}` |
| GET | `/api/audios/<id>/audio`, `/peaks` | Audio for the player / waveform (`?buckets=n` for a thumbnail) |
| POST | `/api/audios/<id>/transcribe` | Recognize one segment `{start, end}` → `{text, words}` |
| POST | `/api/audios/<id>/export` | One audio's dataset ZIP `{name, segments}` |
| GET | `/api/tasks` | Tasks you may see (My Tasks), with review counts (`stages`) and your `access` |
| POST | `/api/tasks` | Push audio into a new task `{name, audio_ids, members?}` |
| GET / DELETE | `/api/tasks/<id>` | Open a task with its audio and their crops / delete it (and its audio) |
| PUT | `/api/tasks/<id>/members` | `{annotator: [...], inspector: [...], acceptor: [...]}` |
| POST | `/api/tasks/<id>/review` | Review a package `{audio_id, index, step: "inspection" \| "acceptance", decision: "pass" \| "accept" \| "return", note?}` |
| GET | `/api/tasks/<id>/export` | Download the whole task as one ZIP |
| POST | `/api/tasks/<id>/hub-push` | Push the task to a Hub repo `{repo_id, split?, include?: "accepted" \| "passed" \| "done" \| "with_text", private?, create_pr?, token?}` (job) |
| GET | `/api/tasks/<id>/job` | Progress of that push |
| POST | `/api/tasks/<id>/stop` | Stop it |
| POST | `/api/text/normalize` | Normalized text for `{text}` → `{normalized}` |

## Dataset cleaning (workflow 2)

| Method | URL | Purpose |
|---|---|---|
| POST | `/api/hub/inspect` | Configs, splits (rows, `next_row`, `partial`) and columns of a Hub dataset `{repo, token?}` |
| POST | `/api/hub/whoami` | Hugging Face user of `{token?}` or of the saved login |
| GET | `/api/datasets` | Imported datasets (batches) you may see |
| POST | `/api/datasets` | Import a split, or batches of it: `{repo, config, split, audio_column, text_column, columns, rows?, start_row?, max_rows?, batches?, check?, name?, token?, members?}` → `{datasets: [...], warning?}` (one job each; `warning` when the Hub dataset changed since earlier batches) |
| PUT | `/api/datasets/<id>/members` | The reviewers `{members: [...]}` |
| GET / DELETE | `/api/datasets/<id>` | A dataset with every clip / delete it |
| GET | `/api/datasets/<id>/job` | Progress of the import / check / push job |
| POST | `/api/datasets/<id>/stop` | Stop that job |
| GET | `/api/datasets/<id>/clips/<n>` | One clip as WAV |
| GET | `/api/datasets/<id>/items/<n>/audio` | Download one clip as `<split>_<row>[_<part>].wav`, its trim applied (`?trim=0` = whole clip file) |
| PATCH | `/api/datasets/<id>/items/<n>` | Review a clip `{text?, norm?, status?, reason?, trim?}` (the reviewer is the logged-in user) |
| POST | `/api/datasets/<id>/items/<n>/split` | Cut a clip in two `{at}` (seconds in its clip file) |
| POST | `/api/datasets/<id>/items/<n>/join` | Join a part with the next part of its row |
| POST | `/api/datasets/<id>/items/<n>/recognize` | Check one clip with the ASR now |
| POST | `/api/datasets/<id>/check` | Run the ASR on every clip `{redo?}` (job) |
| POST | `/api/datasets/<id>/accept-passing` | Accept every passed clip `{max_cer}` |
| GET | `/api/datasets/<id>/export` | Cleaned clips as ZIP (`?include=accepted\|not_rejected\|all&trim=1`) |
| POST | `/api/datasets/<id>/push` | Push to a Hub repo `{repo_id, split?, include?, trim?, private?, create_pr?, token?}` (job) |
