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
from .access import Access
from .rooms import DbStore, Peer, RoomRegistry
from .ws import map_socket, resolve_peer


def create_asgi(config_path: Path | str | None = None) -> Starlette:
    flask_app = create_app(config_path)
    # From then on /admin's save updates it (admin.write_config).
    max_people = int(flask_app.extensions["pleiades_config"].get("sharing", "max_people_per_map"))

    def resolve(map_id: str, peer: Peer) -> Access | None:
        """Someone's access now, for a room re-checking who may stay (sharing.py
        changes; maps.notify). Runs in a worker thread."""
        return resolve_peer(flask_app, map_id, peer)

    registry = RoomRegistry(DbStore(flask_app.extensions["pleiades_db"]), max_people=max_people, resolve=resolve)
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
