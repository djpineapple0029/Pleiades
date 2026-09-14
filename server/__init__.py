"""Flask app for AtlasMap: serves the built frontend and the file crypto endpoints.

No graph logic lives here — the frontend owns the graph entirely.
"""

from __future__ import annotations

from pathlib import Path

from flask import Flask, Response, send_from_directory

from .api import api

STATIC_DIR = Path(__file__).resolve().parent / "static"

# A ceiling on an upload, so a wrong file picked by accident cannot be read
# into memory in full. Far above any plausible map: the payload is text.
MAX_UPLOAD_BYTES = 64 * 1024 * 1024

BUILD_MISSING = (
    "Frontend build missing at server/static/. Run:\n"
    "  cd frontend && npm install && npm run build\n"
)


def create_app() -> Flask:
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
    app.register_blueprint(api)

    @app.get("/")
    def index() -> Response:
        if not (STATIC_DIR / "index.html").is_file():
            return Response(BUILD_MISSING, status=503, mimetype="text/plain")
        return send_from_directory(STATIC_DIR, "index.html")

    return app
