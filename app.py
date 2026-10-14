"""Entry point: `python app.py` (or `flask run`). The app itself lives in the backend/ package."""
import os

from backend import create_app

app = create_app()

if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 5000)),
            debug=os.environ.get("FLASK_DEBUG", "1") == "1")
