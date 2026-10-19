# HTTP API

The web UI talks to the Flask backend through this JSON API. You can use it from scripts too. Errors come back as `{"error": "..."}` with a 4xx or 5xx status. Long work (imports, ASR checks, pushes to the Hub) runs as a background **job**; poll its `/job` URL for progress.

## Audio and tasks (workflow 1)

| Method | URL | Purpose |
|---|---|---|
| GET | `/api/audios` | Audio still in Upload & Crop (`?task=<id>`: the audio of a task) |
| POST | `/api/audios` | Upload one audio file (`multipart`: `audio`) |
| GET / DELETE | `/api/audios/<id>` | Open an audio with its segments / delete it |
| PUT | `/api/audios/<id>/state` | Autosave segments `{segments}` |
| POST | `/api/audios/<id>/recut` | Cut into fixed-length segments `{chunk_seconds}` |
| GET | `/api/audios/<id>/audio`, `/peaks` | Audio for the player / waveform (`?buckets=n` for a thumbnail) |
| POST | `/api/audios/<id>/transcribe` | Recognize one segment `{start, end}` → `{text, words}` |
| POST | `/api/audios/<id>/export` | One audio's dataset ZIP `{name, segments}` |
| GET | `/api/tasks` | List tasks (My Tasks) |
| POST | `/api/tasks` | Push audio into a new task `{name, audio_ids}` |
| GET / DELETE | `/api/tasks/<id>` | Open a task with its audio and their crops / delete it (and its audio) |
| GET | `/api/tasks/<id>/export` | Download the whole task as one ZIP |
| POST | `/api/tasks/<id>/hub-push` | Push the task to a Hub repo `{repo_id, split?, include?: "done" \| "with_text", private?, create_pr?, token?}` (job) |
| GET | `/api/tasks/<id>/job` | Progress of that push |
| POST | `/api/tasks/<id>/stop` | Stop it |
| POST | `/api/text/normalize` | Normalized text for `{text}` → `{normalized}` |
| GET | `/api/me` | Annotator name (`ANNOTATOR_NAME` or the computer's user) |

## Dataset cleaning (workflow 2)

| Method | URL | Purpose |
|---|---|---|
| POST | `/api/hub/inspect` | Configs, splits (rows, `next_row`) and columns of a Hub dataset `{repo, token?}` |
| POST | `/api/hub/whoami` | Hugging Face user of `{token?}` or of the saved login |
| GET | `/api/datasets` | Imported datasets (batches) |
| POST | `/api/datasets` | Import a split, or batches of it: `{repo, config, split, audio_column, text_column, columns, rows?, start_row?, max_rows?, batches?, check?, name?, token?}` → `{datasets: [...]}` (one job each) |
| GET / DELETE | `/api/datasets/<id>` | A dataset with every clip / delete it |
| GET | `/api/datasets/<id>/job` | Progress of the import / check / push job |
| POST | `/api/datasets/<id>/stop` | Stop that job |
| GET | `/api/datasets/<id>/clips/<n>` | One clip as WAV |
| GET | `/api/datasets/<id>/items/<n>/audio` | Download one clip as `<split>_<row>[_<part>].wav`, its trim applied (`?trim=0` = whole clip file) |
| PATCH | `/api/datasets/<id>/items/<n>` | Review a clip `{text?, norm?, status?, reason?, trim?, reviewer?}` |
| POST | `/api/datasets/<id>/items/<n>/split` | Cut a clip in two `{at}` (seconds in its clip file) |
| POST | `/api/datasets/<id>/items/<n>/join` | Join a part with the next part of its row |
| POST | `/api/datasets/<id>/items/<n>/recognize` | Check one clip with the ASR now |
| POST | `/api/datasets/<id>/check` | Run the ASR on every clip `{redo?}` (job) |
| POST | `/api/datasets/<id>/accept-passing` | Accept every passed clip `{max_cer}` |
| GET | `/api/datasets/<id>/export` | Cleaned clips as ZIP (`?include=accepted\|not_rejected\|all&trim=1`) |
| POST | `/api/datasets/<id>/push` | Push to a Hub repo `{repo_id, split?, include?, trim?, private?, create_pr?, token?}` (job) |
