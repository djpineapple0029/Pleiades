"""Flask app for AtlasMap: serves the built frontend, the file crypto endpoints,
the public keybinds/settings (`/api/config`), the admin panel (`/admin`) and,
when switched on, accounts with server-side maps (`/api/auth`, `/api/maps`).

No graph logic lives here — the frontend owns the graph entirely.
"""

from __future__ import annotations

import os
from pathlib import Path

from flask import Flask, Response, redirect, request, send_from_directory

from .accounts import account_shell_url, accounts
from .admin import Guard, admin, client_ip
from .api import api
from .config import ConfigStore
from .db import FILENAME, Database
from .maps import maps
from .stats import Stats, instrument

STATIC_DIR = Path(__file__).resolve().parent / "static"

BUILD_MISSING = "Frontend build missing at server/static/. Run:\n  cd frontend && npm install && npm run build\n"


def create_app(config_path: Path | str | None = None) -> Flask:
    """`config_path` defaults to `$ATLASMAP_CONFIG`, then `config/atlasmap.toml`.

    The accounts database sits in `$ATLASMAP_DATA`, else next to the config
    file. It's only created once an accounts request needs it.
    """
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")
    config = ConfigStore(config_path)
    app.extensions["atlasmap_config"] = config
    app.extensions["atlasmap_admin_guard"] = Guard()
    app.extensions["atlasmap_account_guard"] = Guard()
    data_dir = Path(os.environ.get("ATLASMAP_DATA") or config.path.parent)
    app.extensions["atlasmap_db"] = Database(data_dir / FILENAME)
    app.extensions["atlasmap_stats"] = stats = Stats()
    instrument(app, stats, client_ip)

    @app.before_request
    def upload_ceiling() -> None:
        # Read per request so a change in the panel applies at once. A ceiling
        # so a wrong file picked by accident is never read into memory in full.
        app.config["MAX_CONTENT_LENGTH"] = config.get("server", "max_upload_mb") * 1024 * 1024

    app.register_blueprint(api)
    app.register_blueprint(admin)
    app.register_blueprint(accounts)
    app.register_blueprint(maps)

    @app.get("/")
    def index() -> Response:
        # `?map=<id>` (a server map) and `?local` (no account) are the app itself.
        if "map" in request.args or "local" in request.args:
            page = "index.html"
        else:
            shell = account_shell_url()
            if shell:
                # Not permanent: signing out must bring the homepage straight back.
                response = redirect(shell, code=302)
                response.headers["Cache-Control"] = "no-store"
                return response
            page = "home.html"
        if not (STATIC_DIR / page).is_file():
            return Response(BUILD_MISSING, status=503, mimetype="text/plain")
        response = send_from_directory(STATIC_DIR, page)
        if page == "home.html":
            # What `/` is depends on the session cookie, so never reuse it.
            response.headers["Cache-Control"] = "no-store"
        return response

    return app
