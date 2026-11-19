# HTTP API

The web UI talks to the Flask backend through this JSON API. You can use it from scripts too. Errors come back as `{"error": "..."}` with a 4xx or 5xx status. Long work (imports, ASR checks, pushes to the Hub) runs as a background **job**; poll its `/job` URL for progress.

Every call except `/api/auth/*` needs a login: `POST /api/auth/login` sets a session cookie (keep it, e.g. with `requests.Session()`). Without one the answer is `401`; a role without the permission gets `403`. Permissions per role are in `backend/api/auth/roles.py`.

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
| GET | `/api/activity/report` | Excel report of everyone `?period=week\|month&date=YYYY-MM-DD` (a day in that week / month; a week is Monday–Sunday) or `?period=custom&since=&until=` → `activity_<since>_to_<until>.xlsx` with the sheets Summary, Users, Daily and Activity log (admin) |
| GET | `/api/activity/work` | Dashboard, Team tab `?since=&until=` (YYYY-MM-DD) -> per user: `annotation {done, done_seconds, in_progress, returned, accepted, accepted_seconds, passed}`, `review {inspected, accepted, returned}` (`inspected`: passes from before the one review step), `cleaning {accepted, rejected, accepted_seconds}`, and `totals` (admin) |
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
| GET | `/api/audios/<id>/download` | One package's audio as WAV (`?start=&end=&name=`; without start/end the whole audio) |
| POST | `/api/audios/<id>/export` | One audio's dataset ZIP `{name, segments}` |
| GET | `/api/tasks` | Tasks you may see (My Tasks), with review counts (`stages`) and your `access` |
| POST | `/api/tasks` | Push audio into a new task `{name, audio_ids, members?}` |
| GET / DELETE | `/api/tasks/<id>` | Open a task with its audio and their crops / delete it (and its audio) |
| PUT | `/api/tasks/<id>/members` | `{annotator: [...], inspector: [...] (the reviewers), open_roles?: ["annotator", ...]}` → `{members, open_roles}` (`open_roles`: the roles whose users may claim the task themselves) |
| POST | `/api/tasks/<id>/claim` | The logged-in user joins a task open to their role → `{members}` (`GET /api/tasks` lists such tasks with `can_claim: true`) |
| POST | `/api/tasks/<id>/review` | Review a package (one step) `{audio_id, index, decision: "accept" \| "return", note?}`; a return needs a note |
| GET | `/api/tasks/<id>/export` | Download the whole task as one ZIP |
| POST | `/api/tasks/<id>/hub-push` | Push the task to a Hub repo `{repo_id, split?, include?: "accepted" \| "done" \| "with_text", private?, create_pr?, token?}` (job) |
| POST | `/api/tasks/load/hub` | Load Data from a Hub split into tasks `{repo, config, split, audio_column, text_column, rows?, start_row?, max_rows?, batches?, name?, token?, members?}` → `{tasks: [...], warning?}`: one task per batch of rows, loaded in the background (job); every clip is one package with its text filled in |
| POST | `/api/tasks/load/local` | Start a task for a local folder `{name, members?}` → the task (`source: {kind: "local", state: "loading"}`) |
| POST | `/api/tasks/<id>/files` | Add clips to that task. Multipart: `audio` (files), `texts` (JSON list, one label per file), `names` (JSON list, the path in the folder) → `{added, skipped, failed: [{file, error}], count}`; files already there are skipped |
| POST | `/api/tasks/<id>/finish` | The folder is loaded → the task (`source.state: "ready"`) |
| GET | `/api/tasks/<id>/job` | Progress of the push, or of loading a Hub batch |
| POST | `/api/tasks/<id>/stop` | Stop it |
| POST | `/api/text/normalize` | Normalized text for `{text}` → `{normalized}` |

## Dataset cleaning (workflow 2)

The Dataset Cleaning pages were replaced by Load Data (above); these endpoints are still served for the datasets imported before.

| Method | URL | Purpose |
|---|---|---|
| POST | `/api/hub/inspect` | Configs, splits (rows, `next_row` = the first row not loaded into a task yet, `partial`) and columns of a Hub dataset `{repo, token?}` (Load Data) |
| POST | `/api/hub/whoami` | Hugging Face user of `{token?}` or of the saved login |
| GET | `/api/datasets` | Imported datasets (batches) you may see |
| POST | `/api/datasets` | Import a split, or batches of it: `{repo, config, split, audio_column, text_column, columns, rows?, start_row?, max_rows?, batches?, check?, name?, token?, members?}` → `{datasets: [...], warning?}` (one job each; `warning` when the Hub dataset changed since earlier batches) |
| POST | `/api/datasets/local` | Start a dataset uploaded from a local folder `{name, members?}` → the dataset (`source: "local"`, `state: "uploading"`) |
| POST | `/api/datasets/<id>/files` | Add audio to an uploaded dataset. Multipart: `audio` (files), `texts` (JSON list, one label per file), `names` (JSON list, the path in the folder) → `{added, skipped, failed: [{file, error}], count}`. Files already there are skipped |
| POST | `/api/datasets/<id>/finish` | The upload is complete `{check?}` → the dataset (`state: "ready"`; `check` runs the ASR as a job) |
| PUT | `/api/datasets/<id>/members` | The reviewers `{members: [...], open?: bool}` → `{members, open}` (`open`: reviewers may claim it themselves) |
| POST | `/api/datasets/<id>/claim` | The logged-in user becomes a reviewer of an open dataset → `{members}` (`GET /api/datasets` lists such datasets with `can_claim: true`) |
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
