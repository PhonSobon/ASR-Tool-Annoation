# Contributing

Thank you for helping build better tools for Khmer speech data. Bug reports, ideas, code and documentation are all welcome, in English or Khmer.

## Reporting a bug or asking for a feature

Open an issue on GitHub with:

- what you did, what you expected, and what happened (a screenshot helps);
- your operating system, Python version, and whether you use a GPU;
- for audio problems, the file format (please do not upload private recordings);
- for Hugging Face problems, the dataset id (if it is public).

## Setting up for development

```bash
git clone https://github.com/PhonSobon/ASR-Tool-Annoation.git
cd ASR-Tool-Annoation
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS / Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest            # the tests mock the ASR model and the Hub: no GPU, no download, no network
cp .env.example .env        # set DATABASE_URL (or leave it out: a SQLite file in data/)
FLASK_DEBUG=1 python app.py # Windows PowerShell: $env:FLASK_DEBUG=1; python app.py

cd frontend && npm install && npm run dev   # the web app on http://localhost:3000 (second terminal)
```

## How the code is organised

- `backend/<feature>/`: one package per feature (`auth`, `asr`, `annotation`, `cleaning`), each with its logic and its routes. Keep the routes thin: check access, read the request, call the logic, return JSON. Shared building blocks are in `backend/core/`.
- Permissions: a route asks for a permission (`@require("hub.push")`, `guard.need(...)`), never for a role. Which role has which permission is in `backend/auth/roles.py`.
- Data: the tables are in `backend/core/db.py` (SQLAlchemy; PostgreSQL, SQLite in tests). Read and change rows inside `with db.transaction() as s:`; use `db.locked(...)` for read-change-write.
- `frontend/`: the Next.js app (TypeScript). One page per screen in `src/app`, shared pieces in `src/components` and `src/lib`. Show only what the role may do: `const { can } = useSession(); can("hub.push")`, and per task / dataset its `access` from the API. The server checks every permission again.
- `tests/`: pytest tests that run against the Flask test client with a temporary data folder.

The [API reference](docs/api.md) lists every endpoint.

## Making a change

1. Create a branch from `main`.
2. Keep the change focused. Follow the style of the code around it: short functions, a docstring that says what a function returns, and comments that explain *why*.
3. Add or update a test in `tests/` for backend changes, and run `python -m pytest`.
4. For UI changes, try them in the browser, and include a screenshot in the pull request.
5. Update `README.md` or `docs/` if the change is visible to users.
6. Open a pull request that explains what changed and why.

## Good first contributions

- **Khmer text normalization** (`backend/core/text.py`): fixing Khmer characters typed in the wrong order, writing numbers as Khmer words, and other cleanup rules. Include example sentences in the tests.
- **Quality checks** (`backend/cleaning/quality.py`): new ways to find clips whose text does not match the audio.
- **Interface translation** into Khmer.
- **Documentation:** a step-by-step tutorial with screenshots, or a Khmer version of the user guide.

## Data and privacy

Never commit audio, transcripts, tokens or anything from `data/` (it is in `.gitignore`). Use synthetic audio in tests; `tests/conftest.py` has a `make_wav` helper.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) of this project.
