"""The live-map WebSocket (context/MOONSHOT.md; wire protocol in
MOONSHOT-BUILD.md). Works out who is connecting — a session cookie, or (in
milestone 2) a share link with a guest name — and with what access, then
hands frames to the map's room.

Cross-site WebSocket hijacking: browsers send cookies on a cross-site
WebSocket handshake and SameSite=Lax doesn't stop it, so the Origin header
must name this host. Non-browser clients send no Origin and get no cookie.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
from typing import Any
from urllib.parse import urlsplit

from anyio import to_thread
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from . import access as accessmod
from . import db as dbmod
from .accounts import COOKIE, session_row, token_hash
from .maps import MAP_ID_RE
from .rooms import Peer, RoomRegistry

# Any one frame a client sends (its own edits); the initial sync is server →
# client and isn't limited. uvicorn's ws_max_size cuts these first in
# production (docker_serve.py); the TestClient doesn't, hence the check here.
MAX_FRAME = 2 * 1024 * 1024
MAX_TEXT_FRAME = 4096


def origin_ok(websocket: WebSocket) -> bool:
    origin = websocket.headers.get("origin")
    if origin is None:
        return True
    return urlsplit(origin).netloc == websocket.headers.get("host", "")


def identify(flask_app: Any, websocket: WebSocket, map_id: str) -> tuple[accessmod.Access, str] | None:
    """(access, display name), or None. Runs in a worker thread (SQLite)."""
    store = flask_app.extensions["pleiades_config"]
    if not store.get("accounts", "enabled"):
        return None
    database = flask_app.extensions["pleiades_db"]
    switches = accessmod.Switches(
        sharing=bool(store.get("sharing", "enabled")), guest_links=bool(store.get("sharing", "guest_links"))
    )
    token = websocket.cookies.get(COOKIE)
    with database.connect() as conn:
        if token:
            user = session_row(conn, token_hash(token), dbmod.now())
            if user is not None and not user["must_change_password"]:
                found = accessmod.resolve(conn, map_id, user_id=user["id"], switches=switches)
                if found is not None:
                    # Opened: no longer "new" in Shared with me.
                    conn.execute(
                        "UPDATE map_members SET seen_at = ? WHERE map_id = ? AND user_id = ?",
                        (dbmod.now(), map_id, user["id"]),
                    )
                    return found, user["username"]
        # Link guests: milestone 2.
    return None


async def map_socket(websocket: WebSocket) -> None:
    flask_app = websocket.app.state.flask
    registry: RoomRegistry = flask_app.extensions["pleiades_rooms"]
    map_id = websocket.path_params["map_id"]
    await websocket.accept()
    if not origin_ok(websocket):
        await websocket.close(4403, "origin")
        return
    if not MAP_ID_RE.fullmatch(map_id):
        await websocket.close(4404, "no such map")
        return
    found = await to_thread.run_sync(identify, flask_app, websocket, map_id)
    if found is None:
        await websocket.close(4404, "no such map")
        return
    access, name = found
    peer = Peer(
        conn=secrets.token_urlsafe(6),
        name=name,
        role=access.role,
        perms=access.perms,
        guest=access.via_link and access.user_id is None,
        user_id=access.user_id,
        guest_key=access.guest_key,
    )
    writer = asyncio.create_task(_write(websocket, peer))
    room = await registry.join(map_id, peer, websocket.query_params.get("epoch", ""))
    try:
        if room is None:
            # Refused (stale epoch, full, gone): the close is queued; let it out.
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.shield(writer), timeout=5)
            return
        while not writer.done():
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            data = message.get("bytes")
            text = message.get("text")
            if data is not None:
                if len(data) > MAX_FRAME:
                    peer.close(4413, "too large")
                    break
                await room.on_binary(peer, data)
            elif text is not None:
                if len(text) > MAX_TEXT_FRAME:
                    peer.close(4413, "too large")
                    break
                try:
                    payload = json.loads(text)
                except ValueError:
                    continue
                if isinstance(payload, dict):
                    await room.on_text(peer, payload)
    except (WebSocketDisconnect, RuntimeError):
        pass  # gone, or closed under us by the writer
    finally:
        if room is not None:
            await registry.leave(map_id, peer)
        if not writer.done():
            # Let anything already queued (a close above) go out first.
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.shield(_drained(peer, writer)), timeout=1)
            writer.cancel()


async def _drained(peer: Peer, writer: asyncio.Task) -> None:
    while not peer.outbox.empty() and not writer.done():
        await asyncio.sleep(0.01)


async def _write(websocket: WebSocket, peer: Peer) -> None:
    """Sends the peer's outbox in order; a ("close", …) item ends the connection."""
    try:
        while True:
            item = await peer.outbox.get()
            if websocket.application_state != WebSocketState.CONNECTED:
                return
            if item[0] == "bytes":
                await websocket.send_bytes(item[1])
            elif item[0] == "text":
                await websocket.send_text(item[1])
            else:
                await websocket.close(item[1], item[2])
                return
    except (WebSocketDisconnect, RuntimeError):
        return
