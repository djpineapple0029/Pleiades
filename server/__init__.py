"""Flask app for Pleiades: serves the built frontend, the file crypto endpoints,
the public keybinds/settings (`/api/config`), the admin panel (`/admin`) and,
when switched on, accounts with server-side maps and settings (`/api/auth`,
`/api/maps`, `/api/account`).

No graph logic lives here — the frontend owns the graph entirely.
"""

from __future__ import annotations

from pathlib import Path

from flask import Flask, Response, redirect, request, send_from_directory

from . import db as dbmod
from .account import account
from .accounts import account_shell_url, accounts, available, cookie_path, session_user, token_hash
from .admin import Guard, admin, client_ip
from .admin_users import admin_users
from .api import api
from .config import ConfigStore
from .db import FILENAME, Database
from .env import env, legacy
from .maps import maps
from .sharing import sharing
from .stats import Stats, instrument

STATIC_DIR = Path(__file__).resolve().parent / "static"

LINK_GONE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pleiades</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05060a;color:#cfd6e4;
font:16px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}p{max-width:28rem;text-align:center}</style>
</head><body><p>This link doesn't work any more. Ask whoever shared it for a new one.</p></body></html>
"""

BUILD_MISSING = "Frontend build missing at server/static/. Run:\n  cd frontend && npm install && npm run build\n"


def create_app(config_path: Path | str | None = None) -> Flask:
    """`config_path` defaults to `$PLEIADES_CONFIG`, then `config/pleiades.toml`.

    The accounts database sits in `$PLEIADES_DATA`, else next to the config
    file. It's only created once an accounts request needs it.
    """
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="")
    config = ConfigStore(config_path)
    app.extensions["pleiades_config"] = config
    app.extensions["pleiades_admin_guard"] = Guard()
    app.extensions["pleiades_account_guard"] = Guard()
    data_dir = Path(env("DATA") or config.path.parent)
    app.extensions["pleiades_db"] = Database(legacy(data_dir / FILENAME))
    app.extensions["pleiades_stats"] = stats = Stats()
    instrument(app, stats, client_ip)

    @app.before_request
    def upload_ceiling() -> None:
        # Read per request so a change in the panel applies at once. A ceiling
        # so a wrong file picked by accident is never read into memory in full.
        app.config["MAX_CONTENT_LENGTH"] = config.get("server", "max_upload_mb") * 1024 * 1024

    app.register_blueprint(api)
    app.register_blueprint(admin)
    app.register_blueprint(admin_users)
    app.register_blueprint(accounts)
    app.register_blueprint(maps)
    app.register_blueprint(sharing)
    app.register_blueprint(account)

    @app.get("/s/<token>")
    def share_link(token: str) -> Response:
        """A share link: into the app on its map, the token in the fragment so
        it never reaches a log or a Referer. Dead links get a small page."""
        map_id = None
        if available():
            sharing_on = bool(config.get("sharing", "enabled"))
            guests_on = bool(config.get("sharing", "guest_links"))
            if sharing_on and (guests_on or session_user() is not None):
                with app.extensions["pleiades_db"].connect() as conn:
                    row = conn.execute(
                        "SELECT map_id, expires_at FROM map_links WHERE token_hash = ?", (token_hash(token),)
                    ).fetchone()
                if row is not None and (row["expires_at"] is None or row["expires_at"] > dbmod.now()):
                    map_id = row["map_id"]
        if map_id is None:
            response = Response(LINK_GONE, status=410, mimetype="text/html")
        else:
            response = redirect(f"{cookie_path()}?map={map_id}#link={token}", code=302)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

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
