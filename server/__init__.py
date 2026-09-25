"""Flask app for AtlasMap: serves the built frontend, the file crypto endpoints,
the public keybinds/settings (`/api/config`) and the admin panel (`/admin`).

No graph logic lives here — the frontend owns the graph entirely.
"""

from __future__ import annotations

from pathlib import Path

from flask import Flask, Response, send_from_directory

from .admin import Guard, admin, client_ip
from .api import api
from .config import ConfigStore
from .stats import Stats, instrument

STATIC_DIR = Path(__file__).resolve().parent / "static"

BUILD_MISSING = "Frontend build missing at server/static/. Run:\n  cd frontend && npm install && npm run build\n"


def create_app(config_path: Path | str | None = None) -> Flask:
    """`config_path` defaults to `$ATLASMAP_CONFIG`, then `config/atlasmap.toml`."""
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")
    config = ConfigStore(config_path)
    app.extensions["atlasmap_config"] = config
    app.extensions["atlasmap_admin_guard"] = Guard()
    app.extensions["atlasmap_stats"] = stats = Stats()
    instrument(app, stats, client_ip)

    @app.before_request
    def upload_ceiling() -> None:
        # Read per request so a change in the panel applies at once. A ceiling
        # so a wrong file picked by accident is never read into memory in full.
        app.config["MAX_CONTENT_LENGTH"] = config.get("server", "max_upload_mb") * 1024 * 1024

    app.register_blueprint(api)
    app.register_blueprint(admin)

    @app.get("/")
    def index() -> Response:
        if not (STATIC_DIR / "index.html").is_file():
            return Response(BUILD_MISSING, status=503, mimetype="text/plain")
        return send_from_directory(STATIC_DIR, "index.html")

    return app
