"""The live-map WebSocket (context/MOONSHOT.md; wire protocol in
MOONSHOT-BUILD.md). Works out who is connecting — a session cookie, or a
share link with a guest name — and with what access, then
hands frames to the map's room.

Cross-site WebSocket hijacking: browsers send cookies on a cross-site
WebSocket handshake and SameSite=Lax doesn't stop it, so the Origin header
must name this host. Non-browser clients send no Origin and get no cookie.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
import secrets
from typing import Any, NamedTuple
from urllib.parse import urlsplit

from anyio import to_thread
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from . import access as accessmod
from . import db as dbmod
from .accounts import COOKIE, session_row, token_hash
from .guests import clean_guest_name
from .maps import MAP_ID_RE
from .rooms import Peer, RoomRegistry

# Any one frame a client sends (its own edits); the initial sync is server →
# client and isn't limited. uvicorn's ws_max_size cuts these first in
# production (docker_serve.py); the TestClient doesn't, hence the check here.
MAX_FRAME = 2 * 1024 * 1024
MAX_TEXT_FRAME = 4096
# A guest's key: 16 random bytes, url-safe base64, made once per browser tab.
GUEST_KEY_RE = re.compile(r"[A-Za-z0-9_-]{22}")


def origin_ok(websocket: WebSocket) -> bool:
    origin = websocket.headers.get("origin")
    if origin is None:
        return True
    return urlsplit(origin).netloc == websocket.headers.get("host", "")


def switches_of(flask_app: Any) -> accessmod.Switches:
    store = flask_app.extensions["pleiades_config"]
    return accessmod.Switches(
        sharing=bool(store.get("sharing", "enabled")), guest_links=bool(store.get("sharing", "guest_links"))
    )


def resolve_peer(flask_app: Any, map_id: str, peer: Peer) -> accessmod.Access | None:
    """Someone already in a room, asked again (a room's re-check after a
    sharing change): by account, or by the link and guest key they came in
    with. Runs in a worker thread."""
    if not flask_app.extensions["pleiades_config"].get("accounts", "enabled"):
        return None
    with flask_app.extensions["pleiades_db"].connect() as conn:
        return accessmod.resolve(
            conn,
            map_id,
            user_id=peer.user_id,
            link_token=peer.link_token,
            guest_key=peer.guest_key,
            switches=switches_of(flask_app),
        )


class Who(NamedTuple):
    access: accessmod.Access
    name: str
    link_token: str | None = None


def identify(flask_app: Any, websocket: WebSocket, map_id: str) -> Who | int:
    """Who is connecting, or the close code that refuses them: 4404 for no
    access (a map you can't see), 4400 for a malformed guest name or key.
    Runs in a worker thread (SQLite)."""
    if not flask_app.extensions["pleiades_config"].get("accounts", "enabled"):
        return 4404
    database = flask_app.extensions["pleiades_db"]
    switches = switches_of(flask_app)
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
                    return Who(found, user["username"])
        # A guest on a share link: the link, a display name, and this tab's key.
        link = websocket.query_params.get("link")
        if not link:
            return 4404
        name = clean_guest_name(websocket.query_params.get("name"))
        guest_key = websocket.query_params.get("guest", "")
        if name is None or not GUEST_KEY_RE.fullmatch(guest_key):
            return 4400
        found = accessmod.resolve(conn, map_id, link_token=link, guest_key=guest_key, switches=switches)
        return 4404 if found is None else Who(found, name, link)


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
    who = await to_thread.run_sync(identify, flask_app, websocket, map_id)
    if isinstance(who, int):
        await websocket.close(who, "no such map" if who == 4404 else "bad guest name")
        return
    access, name = who.access, who.name
    peer = Peer(
        conn=secrets.token_urlsafe(6),
        name=name,
        role=access.role,
        perms=access.perms,
        guest=access.via_link and access.user_id is None,
        user_id=access.user_id,
        guest_key=access.guest_key,
        link_token=who.link_token,
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
