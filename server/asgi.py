"""ASGI host for Pleiades: the Flask app (unchanged, through a2wsgi) plus the
WebSocket route for live map rooms (server/ws.py, server/rooms.py). Flask is
WSGI and can't hold a WebSocket, so this is the one process that serves both.

One worker only: rooms live in this process's memory. Flask reaches them
through `flask_app.extensions["pleiades_rooms"]` (maps.notify) from its
worker threads; the registry hops back onto the event loop for that.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from a2wsgi import WSGIMiddleware
from starlette.applications import Starlette
from starlette.routing import Mount, WebSocketRoute

from . import create_app
from .access import Access, Switches
from .access import resolve as access_resolve
from .rooms import DbStore, RoomRegistry
from .ws import map_socket


def create_asgi(config_path: Path | str | None = None) -> Starlette:
    flask_app = create_app(config_path)
    # Read once: changing it in /admin applies after a restart (its help says so).
    max_people = int(flask_app.extensions["pleiades_config"].get("sharing", "max_people_per_map"))
    database = flask_app.extensions["pleiades_db"]

    def resolve(map_id: str, user_id: int) -> Access | None:
        """Someone's access now, for a room re-checking who may stay (sharing.py
        changes; maps.notify). Runs in a worker thread."""
        store = flask_app.extensions["pleiades_config"]
        switches = Switches(
            sharing=bool(store.get("sharing", "enabled")), guest_links=bool(store.get("sharing", "guest_links"))
        )
        with database.connect() as conn:
            return access_resolve(conn, map_id, user_id=user_id, switches=switches)

    registry = RoomRegistry(DbStore(database), max_people=max_people, resolve=resolve)
    flask_app.extensions["pleiades_rooms"] = registry

    @asynccontextmanager
    async def lifespan(_app: Starlette) -> AsyncIterator[None]:
        registry.bind_loop(asyncio.get_running_loop())
        yield
        # Review Focus 3: a restart or redeploy keeps every acknowledged edit.
        await registry.shutdown()

    routes = [
        WebSocketRoute("/ws/maps/{map_id}", map_socket),
        Mount("/", app=WSGIMiddleware(flask_app)),  # pyrefly: ignore -- WSGI app typed loosely
    ]
    asgi = Starlette(routes=routes, lifespan=lifespan)
    asgi.state.flask = flask_app
    return asgi
