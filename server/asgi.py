"""ASGI host for Pleiades: the Flask app (unchanged, through a2wsgi) plus the
WebSocket route for live map rooms (server/ws.py, server/rooms.py). Flask is
WSGI and can't hold a WebSocket, so this is the one process that serves both.

One worker only: rooms live in this process's memory. Flask reaches them
through `flask_app.extensions["pleiades_rooms"]` (maps.notify) from its
worker threads; the registry hops back onto the event loop for that.
"""

from __future__ import annotations

import asyncio
import logging
import re
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

_TOKENS = (re.compile(r"(link=)[^&\s\"']+"), re.compile(r"(/s/)[A-Za-z0-9_-]+"))


def redact(text: str) -> str:
    for pattern in _TOKENS:
        text = pattern.sub(r"\1[redacted]", text)
    return text


class RedactLinkTokens(logging.Filter):
    """Share-link tokens are edit (or view) access for as long as the link
    lives, so they never reach a log: not the `/s/<token>` landing, and not
    a guest's WebSocket URL (`?link=<token>`), which uvicorn logs on accept."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(redact(arg) if isinstance(arg, str) else arg for arg in record.args)
        if isinstance(record.msg, str):
            record.msg = redact(record.msg)
        return True


def create_asgi(config_path: Path | str | None = None) -> Starlette:
    for name in ("uvicorn.access", "uvicorn.error"):
        logger = logging.getLogger(name)
        if not any(isinstance(f, RedactLinkTokens) for f in logger.filters):
            logger.addFilter(RedactLinkTokens())
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
