"""ASGI host for Pleiades: the Flask app (unchanged, through a2wsgi) plus the
WebSocket routes that live editing needs. Flask is WSGI and can't hold a
WebSocket, so this is the one process that serves both.

One worker only: rooms (server/rooms.py) live in this process's memory.
"""

from __future__ import annotations

from pathlib import Path

from a2wsgi import WSGIMiddleware
from starlette.applications import Starlette
from starlette.routing import Mount, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

from . import create_app


async def ping(websocket: WebSocket) -> None:
    """Echo: the deploy smoke test for WebSockets through Funnel and Caddy."""
    await websocket.accept()
    try:
        while True:
            await websocket.send_text(await websocket.receive_text())
    except WebSocketDisconnect:
        return


def create_asgi(config_path: Path | str | None = None) -> Starlette:
    flask_app = create_app(config_path)
    routes = [
        WebSocketRoute("/ws/ping", ping),
        Mount("/", app=WSGIMiddleware(flask_app)),  # pyrefly: ignore -- WSGI app typed loosely
    ]
    asgi = Starlette(routes=routes)
    asgi.state.flask = flask_app
    return asgi
