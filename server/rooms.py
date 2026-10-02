"""Live map rooms (context/MOONSHOT.md, "Server"): one per open map, in this
process's memory. A room holds the map's pycrdt doc, relays Yjs sync and
awareness between the people in it, drops edits from people who can't edit,
refuses updates that would put a malformed star or link into the map, and
persists the doc (as Yjs state *and* the plain payload) a few seconds after
the last edit, when the last person leaves, and on shutdown.

Every write is conditional on the revision the room last saw. If something
else wrote the map (a restore, an upload, an old client's PUT), the save is
refused and the room tells everyone to reload — so a room can never write
over a restore.

A room opened on a map with no stored Yjs state builds one from the payload
under a fresh epoch, but writes nothing until someone edits: just opening a
map must not add a revision.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, NamedTuple, Protocol

from anyio import to_thread
from pycrdt import (
    Awareness,
    Decoder,
    Doc,
    Map,
    Text,
    YMessageType,
    YSyncMessageType,
    create_awareness_message,
    create_sync_message,
    create_update_message,
    handle_sync_message,
    read_message,
)

from .ydoc import doc_to_payload, edge_problem, node_problem, payload_to_doc

log = logging.getLogger(__name__)

PLAYER_COLOURS = [
    "#ff6b6b",
    "#ffd166",
    "#06d6a0",
    "#4cc9f0",
    "#b388ff",
    "#ff9f1c",
    "#f72585",
    "#90be6d",
    "#43aa8b",
    "#e9ecef",
]
FAILURES_BEFORE_WARNING = 3
# The only roots a map's doc has (server/ydoc.py). Clients write `nodes` and
# `edges`; `meta` (camera, envelope, pass-through keys) is the server's alone
# until a later milestone gives a client something to put there.
CLIENT_ROOTS = {"nodes", "edges"}
DOC_ROOTS = {"nodes", "edges", "meta"}
# A Yjs update with no structs and an empty delete set: the handshake reply of
# a client that has nothing the server lacks.
EMPTY_UPDATE = b"\x00\x00"


class Loaded(NamedTuple):
    ydoc: bytes | None
    epoch: str | None
    payload: dict[str, Any]
    revision: int
    name: str
    default_look: str | None


class RoomStore(Protocol):
    def load(self, map_id: str) -> Loaded | None: ...
    def save(self, map_id: str, ydoc: bytes, epoch: str, payload: dict[str, Any], base_revision: int) -> int | None: ...


@dataclass(eq=False)
class Peer:
    """One connection. The socket handler drains `outbox`: ("bytes", b),
    ("text", str) or ("close", code, reason)."""

    conn: str
    name: str
    role: str
    perms: dict[str, bool]
    guest: bool
    user_id: int | None
    guest_key: str | None
    # The share link a guest came in on, so a re-check can ask about it again.
    link_token: str | None = None
    colour: str = ""
    client_ids: set[int] = field(default_factory=set)
    outbox: asyncio.Queue = field(default_factory=asyncio.Queue)
    # Set once a close is queued: nothing more it sends is acted on.
    closing: bool = False

    @property
    def can_edit(self) -> bool:
        return self.role in ("owner", "editor")

    def send_text(self, value: dict[str, Any]) -> None:
        self.outbox.put_nowait(("text", json.dumps(value)))

    def send_bytes(self, value: bytes) -> None:
        self.outbox.put_nowait(("bytes", value))

    def close(self, code: int, reason: str = "") -> None:
        self.closing = True
        self.outbox.put_nowait(("close", code, reason))


class Room:
    def __init__(
        self,
        map_id: str,
        store: RoomStore,
        *,
        persist_delay: float = 3.0,
        persist_max_wait: float = 20.0,
        evict_delay: float = 60.0,
    ) -> None:
        self.map_id = map_id
        self.store = store
        # Saved `persist_delay` after the last edit, but never more than
        # `persist_max_wait` after the first unsaved one: people typing
        # without pause still get saved (Review Focus 3).
        self.persist_delay = persist_delay
        self.persist_max_wait = persist_max_wait
        self._dirty_since: float | None = None
        self._last_save_ok = True
        self.evict_delay = evict_delay
        self.peers: list[Peer] = []
        self.doc = Doc()
        self.shadow = Doc()
        self.awareness: Awareness | None = None
        self.epoch = ""
        self.revision = 0
        self.name = ""
        self.default_look: str | None = None
        self.closed = False
        self._sender: Peer | None = None
        self._persist_handle: asyncio.TimerHandle | None = None
        self._dirty = False
        self._failures = 0
        self._lock = asyncio.Lock()

    @property
    def people(self) -> list[Peer]:
        return list(self.peers)

    # --- lifecycle ---------------------------------------------------------

    async def open(self) -> bool:
        loaded = await to_thread.run_sync(self.store.load, self.map_id)
        if loaded is None:
            return False
        if loaded.ydoc and loaded.epoch:
            self.doc = Doc()
            self.doc.apply_update(loaded.ydoc)
            self.epoch = loaded.epoch
        else:
            self.doc = payload_to_doc(loaded.payload)
            self.epoch = secrets.token_urlsafe(9)
        self._rebuild_shadow()
        self.revision, self.name, self.default_look = loaded.revision, loaded.name, loaded.default_look
        self.awareness = Awareness(self.doc)
        self.doc.observe(self._on_doc_update)
        return True

    def _on_doc_update(self, event: Any) -> None:
        frame = create_update_message(event.update)
        for p in self.peers:
            if p is not self._sender:
                p.send_bytes(frame)
        self._dirty = True
        self._schedule_persist()

    async def join(self, peer: Peer, known_epoch: str) -> bool:
        if known_epoch and known_epoch != self.epoch:
            peer.send_text({"type": "reload", "reason": "changed"})
            peer.close(4409, "stale")
            return False
        used = {p.colour for p in self.peers}
        peer.colour = next(
            (c for c in PLAYER_COLOURS if c not in used), PLAYER_COLOURS[len(self.peers) % len(PLAYER_COLOURS)]
        )
        self.peers.append(peer)
        peer.send_text(
            {
                "type": "welcome",
                "you": {
                    "conn": peer.conn,
                    "name": peer.name,
                    "colour": peer.colour,
                    "role": peer.role,
                    "perms": peer.perms,
                    "guest": peer.guest,
                    "user_id": peer.user_id,
                },
                "map": {"id": self.map_id, "name": self.name, "default_look": self.default_look},
                "epoch": self.epoch,
            }
        )
        peer.send_bytes(create_sync_message(self.doc))  # server's step1: asks for anything the client has
        assert self.awareness is not None  # noqa: S101 -- open() ran
        states = list(self.awareness.states)
        if states:
            peer.send_bytes(create_awareness_message(self.awareness.encode_awareness_update(states)))
        self._broadcast_roster()
        return True

    async def leave(self, peer: Peer) -> None:
        if peer not in self.peers:
            return
        self.peers.remove(peer)
        if peer.client_ids and self.awareness is not None:
            ids = [cid for cid in peer.client_ids if cid in self.awareness.states]
            if ids:
                self.awareness.remove_awareness_states(ids, "server")
                frame = create_awareness_message(self.awareness.encode_awareness_update(ids))
                for p in self.peers:
                    p.send_bytes(frame)
        self._broadcast_roster()
        if not self.peers:
            await self.persist()

    # --- messages ----------------------------------------------------------

    async def on_binary(self, peer: Peer, data: bytes) -> None:
        # Review Focus 5: a removed peer's late frames are never acted on.
        if not data or self.closed or peer.closing or peer not in self.peers:
            return
        kind = data[0]
        if kind == YMessageType.SYNC and len(data) > 1:
            if data[1] == YSyncMessageType.SYNC_STEP1:
                try:
                    reply = handle_sync_message(data[1:], self.doc)
                except Exception:  # noqa: BLE001 -- an undecodable state vector
                    self._refuse(peer, "undecodable sync step 1")
                    return
                if reply:
                    peer.send_bytes(reply)
                return
            try:
                update = read_message(data[2:])
            except Exception:  # noqa: BLE001 -- truncated or garbled frame
                self._refuse(peer, "undecodable update frame")
                return
            if update == EMPTY_UPDATE:
                return
            if not peer.can_edit:
                peer.send_text({"type": "read_only"})
                return
            problem = self._check(update)
            if problem:
                self._refuse(peer, problem)
                return
            self._sender = peer
            try:
                self.doc.apply_update(update)
            finally:
                self._sender = None
        elif kind == YMessageType.AWARENESS:
            self._on_awareness(peer, data)

    def _refuse(self, peer: Peer, problem: str) -> None:
        log.info("room %s: refused frame from %s: %s", self.map_id, peer.name, problem)
        peer.send_text({"type": "error", "code": "bad_update"})
        peer.close(4400, "bad update")

    def _on_awareness(self, peer: Peer, data: bytes) -> None:
        assert self.awareness is not None  # noqa: S101 -- open() ran
        try:
            update = read_message(data[1:])
            claimed = _awareness_client_ids(update)
        except Exception:  # noqa: BLE001 -- garbled awareness frame
            self._refuse(peer, "undecodable awareness update")
            return
        owned = {cid for p in self.peers if p is not peer for cid in p.client_ids}
        if claimed & owned:
            return  # someone else's identity: drop the frame
        before = set(self.awareness.states)
        self.awareness.apply_awareness_update(update, peer.conn)
        new_ids = claimed - peer.client_ids
        peer.client_ids |= claimed
        for p in self.peers:
            if p is not peer:
                p.send_bytes(data)
        if new_ids or set(self.awareness.states) != before:
            self._broadcast_roster()

    async def on_text(self, peer: Peer, message: dict[str, Any]) -> None:
        """`flush`: save now and say whether it worked (Ctrl+S, and leaving
        for the map list, which then shows what was just done). Chat and
        emotes join in milestone 3. Unknown types are ignored."""
        if peer.closing or self.closed or peer not in self.peers:
            return
        if message.get("type") == "flush":
            ok = await self.persist()
            async with self._lock:
                pass  # a save already under way when this came in has finished too
            # Its own save, not whether anyone has edited since.
            peer.send_text({"type": "flushed", "ok": ok and self._last_save_ok})

    # --- validation --------------------------------------------------------

    def _check(self, update: bytes) -> str | None:
        """Apply to the shadow doc first; check every node and edge it touched,
        and that it touched nothing else. Whatever gets past this, the
        materialiser (doc_to_payload) and every client can read."""
        touched: dict[str, set[str]] = {"nodes": set(), "edges": set(), "meta": set()}

        def collect(root: str) -> Callable[[list[Any]], None]:
            def callback(events: list[Any]) -> None:
                for event in events:
                    path = list(getattr(event, "path", None) or [])
                    if path:
                        touched[root].add(str(path[0]))
                    else:
                        touched[root].update(str(k) for k in (getattr(event, "keys", None) or {}))

            return callback

        nodes = self.shadow.get("nodes", type=Map)
        edges = self.shadow.get("edges", type=Map)
        meta = self.shadow.get("meta", type=Map)
        watched = [(nodes, nodes.observe_deep(collect("nodes")))]
        watched.append((edges, edges.observe_deep(collect("edges"))))
        watched.append((meta, meta.observe_deep(collect("meta"))))
        try:
            self.shadow.apply_update(update)
        except Exception as exc:  # noqa: BLE001 -- any decode failure is a bad update
            self._rebuild_shadow()
            return f"undecodable update: {exc}"
        finally:
            for root, sub in watched:
                root.unobserve(sub)
        problem = self._problem(nodes, edges, touched)
        if problem:
            self._rebuild_shadow()
        return problem

    def _problem(self, nodes: Map, edges: Map, touched: dict[str, set[str]]) -> str | None:
        if touched["meta"]:
            return "meta is not the client's to change"
        extra = set(self.shadow.keys()) - DOC_ROOTS
        if extra:
            return f"unknown root {sorted(extra)[0]!r}"
        for node_id in touched["nodes"]:
            if node_id not in nodes:
                continue
            value = nodes[node_id]
            if not isinstance(value, Map):
                return f"node {node_id}: a star is not a map"
            if value.get("id") != node_id:
                return f"node {node_id}: its id is not its key"
            if not isinstance(value.get("notes"), Text):
                return f"node {node_id}: notes are not shared text"
            problem = node_problem(value.to_py() or {})
            if problem:
                return f"node {node_id}: {problem}"
        for edge_id in touched["edges"]:
            if edge_id not in edges:
                continue
            value = edges[edge_id]
            if not isinstance(value, Map):
                return f"edge {edge_id}: a link is not a map"
            if value.get("id") != edge_id:
                return f"edge {edge_id}: its id is not its key"
            problem = edge_problem(value.to_py() or {})
            if problem:
                return f"edge {edge_id}: {problem}"
        return None

    def _rebuild_shadow(self) -> None:
        self.shadow = Doc()
        self.shadow.apply_update(self.doc.get_update())

    # --- persistence -------------------------------------------------------

    def _schedule_persist(self) -> None:
        loop = asyncio.get_running_loop()
        now = loop.time()
        if self._dirty_since is None:
            self._dirty_since = now
        delay = min(self.persist_delay, max(0.0, self._dirty_since + self.persist_max_wait - now))
        if self._persist_handle:
            self._persist_handle.cancel()
        self._persist_handle = loop.call_later(delay, lambda: asyncio.ensure_future(self.persist()))

    async def persist(self) -> bool:
        """Saves now if anything is unsaved. True if that save worked (or there
        was nothing to save); never raises — one map failing to save must not
        stop another from saving."""
        if self._persist_handle:
            self._persist_handle.cancel()
            self._persist_handle = None
        if not self._dirty or self.closed:
            return True
        async with self._lock:
            self._dirty = False
            self._dirty_since = None
            try:
                state = self.doc.get_update()
                payload = doc_to_payload(self.doc)
                revision = await to_thread.run_sync(
                    self.store.save, self.map_id, state, self.epoch, payload, self.revision
                )
            except Exception:
                log.exception("room %s: save failed", self.map_id)
                self._dirty = True
                self._last_save_ok = False
                self._failures += 1
                if self._failures == FAILURES_BEFORE_WARNING:
                    for p in self.peers:
                        p.send_text({"type": "error", "code": "not_saved"})
                if not self.closed:
                    with contextlib.suppress(RuntimeError):  # no running loop: shutting down
                        self._schedule_persist()
                return False
            if revision is None:
                self._last_save_ok = False
                await self.reload("changed elsewhere")
                return False
            self.revision = revision
            self._last_save_ok = True
            if self._failures >= FAILURES_BEFORE_WARNING:
                for p in self.peers:
                    p.send_text({"type": "saved"})
            self._failures = 0
            return True

    async def reaccess(self, resolve: Callable[[str, Peer], Any]) -> None:
        """Someone's access to this map changed (members, roles, permissions,
        the link, bans, the admin switches): asks again for everyone in it.
        Gone → `kicked` and closed; a new role or permissions → `access`, and
        edits follow at once (a viewer's next update is refused)."""
        for peer in list(self.peers):
            found = await to_thread.run_sync(resolve, self.map_id, peer)
            if peer not in self.peers:
                continue  # left while we asked
            if found is None:
                peer.send_text({"type": "kicked", "reason": "access removed"})
                peer.close(4403, "access removed")
                await self.leave(peer)  # their avatar and bubble go now, not when the socket does
            elif found.role != peer.role or found.perms != peer.perms:
                peer.role, peer.perms = found.role, dict(found.perms)
                peer.send_text({"type": "access", "role": peer.role, "perms": peer.perms})
        self._broadcast_roster()

    async def kick(self, conn: str, reason: str) -> bool:
        """Sends one connection out (the owner's Kick): removed first, so
        nothing it still has in flight is applied (Review Focus 5)."""
        peer = next((p for p in self.peers if p.conn == conn), None)
        if peer is None:
            return False
        peer.send_text({"type": "kicked", "reason": reason})
        peer.close(4403, reason)
        await self.leave(peer)
        return True

    def _close_all(self, message: dict[str, Any], code: int, reason: str) -> None:
        self.closed = True
        if self._persist_handle:
            self._persist_handle.cancel()
            self._persist_handle = None
        for p in self.peers:
            p.send_text(message)
            p.close(code, reason)
        self.peers.clear()

    async def reload(self, reason: str) -> None:
        """The map was replaced outside the room: everyone rebuilds from scratch."""
        self._close_all({"type": "reload", "reason": reason}, 4409, "reload")

    async def deleted(self) -> None:
        self._close_all({"type": "deleted"}, 4404, "deleted")

    # --- roster ------------------------------------------------------------

    def roster(self) -> list[dict[str, Any]]:
        return [
            {
                "conn": p.conn,
                "name": p.name,
                "colour": p.colour,
                "role": p.role,
                "guest": p.guest,
                "clientIds": sorted(p.client_ids),
            }
            for p in self.peers
        ]

    def _broadcast_roster(self) -> None:
        message = {"type": "roster", "people": self.roster()}
        for p in self.peers:
            p.send_text(message)


def _awareness_client_ids(update: bytes) -> set[int]:
    """The client ids an awareness update speaks for (y-protocols encoding)."""
    decoder = Decoder(update)
    count = decoder.read_var_uint()
    ids = set()
    for _ in range(count):
        ids.add(decoder.read_var_uint())
        decoder.read_var_uint()  # clock
        decoder.read_var_string()  # state JSON
    return ids


class RoomRegistry:
    """Every open room. Async methods run on the server's loop; `notify` and
    `online` may be called from Flask's worker threads."""

    def __init__(
        self,
        store: RoomStore,
        *,
        max_people: int = 10,
        resolve: Callable[[str, Peer], Any] | None = None,
    ) -> None:
        self.store = store
        self.max_people = max_people
        # (map_id, peer) -> access.Access | None, from a worker thread.
        self.resolve = resolve
        self.rooms: dict[str, Room] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._guard = threading.Lock()
        self._open_lock: asyncio.Lock | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._open_lock = asyncio.Lock()

    async def join(self, map_id: str, peer: Peer, known_epoch: str) -> Room | None:
        assert self._open_lock is not None  # noqa: S101 -- bind_loop ran (asgi lifespan)
        async with self._open_lock:
            room = self.rooms.get(map_id)
            if room is None or room.closed:
                room = Room(map_id, self.store)
                if not await room.open():
                    peer.close(4404, "no such map")
                    return None
                with self._guard:
                    self.rooms[map_id] = room
        if len(room.peers) >= self.max_people:
            peer.send_text({"type": "error", "code": "full"})
            peer.close(4429, "full")
            return None
        return room if await room.join(peer, known_epoch) else None

    async def leave(self, map_id: str, peer: Peer) -> None:
        room = self.rooms.get(map_id)
        if room is None:
            return
        await room.leave(peer)
        if not room.peers and self._loop is not None:
            self._loop.call_later(room.evict_delay, self._evict, map_id, room)

    def _evict(self, map_id: str, room: Room) -> None:
        if not room.peers and self.rooms.get(map_id) is room:
            with self._guard:
                del self.rooms[map_id]

    def notify(self, map_id: str, event: str) -> None:
        """From any thread: 'reload', 'deleted' or 'access' for an open room."""
        if self._loop is None or self._loop.is_closed():
            return
        self._loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._handle(map_id, event)))

    async def _handle(self, map_id: str, event: str) -> None:
        room = self.rooms.get(map_id)
        if room is None:
            return
        if event == "reload":
            await room.reload("changed")
        elif event == "deleted":
            await room.deleted()
        elif event == "access" and self.resolve is not None:
            await room.reaccess(self.resolve)
        if room.closed:
            with self._guard:
                if self.rooms.get(map_id) is room:
                    del self.rooms[map_id]

    def people(self, map_id: str) -> list[dict[str, Any]]:
        """From any thread: who is in a map now, with what kick needs."""
        with self._guard:
            room = self.rooms.get(map_id)
        if room is None or room.closed:
            return []
        return [
            {
                "conn": p.conn,
                "name": p.name,
                "colour": p.colour,
                "role": p.role,
                "guest": p.guest,
                "user_id": p.user_id,
                "guest_key": p.guest_key,
            }
            for p in list(room.peers)
        ]

    def peer_info(self, map_id: str, conn: str) -> dict[str, Any] | None:
        """From any thread: one person in a map's room, by connection."""
        return next((p for p in self.people(map_id) if p["conn"] == conn), None)

    def kick(self, map_id: str, conn: str, reason: str = "kicked") -> None:
        """From any thread: sends that connection out of the map."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return

        async def run() -> None:
            room = self.rooms.get(map_id)
            if room is not None:
                await room.kick(conn, reason)
                if not room.peers:
                    loop.call_later(room.evict_delay, self._evict, map_id, room)

        loop.call_soon_threadsafe(lambda: asyncio.ensure_future(run()))

    def online(self, map_ids: list[str]) -> dict[str, list[dict[str, str]]]:
        with self._guard:
            rooms = {mid: self.rooms.get(mid) for mid in map_ids}
        return {
            mid: [{"name": p.name, "colour": p.colour} for p in list(room.peers)]
            for mid, room in rooms.items()
            if room is not None and room.peers
        }

    async def shutdown(self) -> None:
        for room in list(self.rooms.values()):
            await room.persist()


class DbStore:
    """Rooms read and write maps through the accounts database."""

    def __init__(self, database: Any) -> None:
        self.database = database

    def load(self, map_id: str) -> Loaded | None:
        from .maps import unpack

        with self.database.connect() as conn:
            row = conn.execute(
                "SELECT ydoc, ydoc_epoch, payload, revision, name, default_look FROM maps WHERE id = ?", (map_id,)
            ).fetchone()
        if row is None:
            return None
        return Loaded(
            row["ydoc"], row["ydoc_epoch"], unpack(row["payload"]), row["revision"], row["name"], row["default_look"]
        )

    def save(self, map_id: str, ydoc: bytes, epoch: str, payload: dict[str, Any], base_revision: int) -> int | None:
        from . import db as dbmod
        from .maps import write_payload

        with self.database.transaction() as conn:
            return write_payload(
                conn, map_id, payload, now=dbmod.now(), ydoc=ydoc, ydoc_epoch=epoch, base_revision=base_revision
            )
