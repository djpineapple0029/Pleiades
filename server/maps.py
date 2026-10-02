"""A signed-in user's maps: list, create, open, save, rename, duplicate, delete,
each map's history (earlier versions, restore; see history.py), and uploading
a map file into the list.

The server keeps the same JSON payload that goes inside a `.plm` file,
zlib-compressed and otherwise untouched: unknown fields pass straight through,
since the frontend owns the payload's shape (format/schema.js).

Who may do what to a map is server/access.py's answer (owner, or a member
it was shared with; see context/MOONSHOT.md). A map you can't see at all is
a 404, never a 403; one you can see but lack the permission for is a 403
naming the permission. Saves carry the revision they were based on in
`If-Match`; a save based on an older revision is refused with 409 and the
current revision, so two tabs never silently overwrite each other.

A map open in a live room (server/rooms.py) saves itself through
`write_payload`. Anything else that replaces its content clears the stored
Yjs state and tells the room to reload, so nobody in it writes old content
back over the change.
"""

from __future__ import annotations

import json
import re
import secrets
import sqlite3
import zlib

from flask import Blueprint, Response, abort, current_app, jsonify, make_response, request

from . import access, history
from . import db as dbmod
from .accounts import current_user, database, fail, finish, gate, json_body, signed_in, store
from .atlasfile import FormatError, PasswordError, decode_any
from .filenames import map_name
from .permissions import effective

maps = Blueprint("maps", __name__, url_prefix="/api/maps")
maps.before_request(gate)
maps.after_request(finish)

MAP_ID_RE = re.compile(r"[A-Za-z0-9_-]{16}")
MAX_NAME_LENGTH = 120
DEFAULT_NAME = "Untitled map"
COPY_SUFFIX = " (copy)"
EMPTY_PAYLOAD = {"format": "atlasmap", "schema": 1, "nodes": [], "edges": []}
# Pinned to every file ever written (format/schema.js `FORMAT`).
PAYLOAD_FORMAT = "atlasmap"


@maps.errorhandler(413)
def too_large(_error: Exception) -> tuple[Response, int]:
    return fail("Map is larger than this server will accept.", 413)


def user_id() -> int:
    user = current_user()
    assert user is not None  # noqa: S101 -- @signed_in ran first
    return user["id"]


def check_id(map_id: str) -> str:
    if not MAP_ID_RE.fullmatch(map_id):
        abort(404)
    return map_id


def switches() -> access.Switches:
    return access.Switches(
        sharing=bool(store().get("sharing", "enabled")), guest_links=bool(store().get("sharing", "guest_links"))
    )


def require(map_id: str, permission: str | None = None, *, edit: bool = False, owner: bool = False) -> access.Access:
    """The signed-in user's access to a map, or the request ends: 404 when
    they can't see it, 403 (naming what's missing) when they can but may not
    do this."""
    check_id(map_id)
    with database().connect() as conn:
        found = access.resolve(conn, map_id, user_id=user_id(), switches=switches())
    if found is None:
        abort(404)
    if owner and found.role != "owner":
        abort(make_response(*fail("Only the map's owner can do that.", 403, permission="owner")))
    if edit and not found.can_edit:
        abort(make_response(*fail("You can view this map but not edit it.", 403, permission="edit")))
    if permission and not found.perms.get(permission):
        abort(
            make_response(*fail(f"You don't have the {permission} permission on this map.", 403, permission=permission))
        )
    return found


def notify(map_id: str, event: str) -> None:
    """Tells the map's live room, if it has one: 'reload', 'deleted' or 'access'."""
    rooms = current_app.extensions.get("pleiades_rooms")
    if rooms is not None:
        rooms.notify(map_id, event)


def clean_name(raw: object) -> str | None:
    """A trimmed, printable name, or None when there's nothing usable."""
    if not isinstance(raw, str):
        return None
    name = "".join(ch for ch in raw if ch.isprintable()).strip()[:MAX_NAME_LENGTH].strip()
    return name or None


def pack(payload: dict) -> tuple[bytes, int]:
    """(compressed payload, node count). Raises ValueError for NaN/Infinity."""
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    nodes = payload.get("nodes")
    return zlib.compress(text.encode("utf-8")), len(nodes) if isinstance(nodes, list) else 0


def unpack(blob: bytes) -> dict:
    return json.loads(zlib.decompress(blob).decode("utf-8"))


def insert_map(conn: sqlite3.Connection, owner: int, name: str, blob: bytes, node_count: int) -> str | None:
    """Adds a map inside the caller's transaction. None when the quota is full."""
    (count,) = conn.execute("SELECT COUNT(*) FROM maps WHERE user_id = ?", (owner,)).fetchone()
    if count >= store().get("accounts", "max_maps_per_user"):
        return None
    map_id = secrets.token_urlsafe(12)
    now = dbmod.now()
    conn.execute(
        "INSERT INTO maps (id, user_id, name, payload, revision, size_bytes, node_count, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
        (map_id, owner, name, blob, len(blob), node_count, now, now),
    )
    return map_id


def quota_full() -> tuple[Response, int]:
    limit = store().get("accounts", "max_maps_per_user")
    return fail(f"You have the most maps this server allows ({limit}). Delete one first.", 409)


def write_payload(
    conn: sqlite3.Connection,
    map_id: str,
    payload: dict,
    *,
    now: int,
    ydoc: bytes | None,
    ydoc_epoch: str | None,
    base_revision: int | None,
) -> int | None:
    """Replaces a map's content inside the caller's transaction: the hourly
    snapshot rule, then the new payload as the next revision. The new revision,
    or None when the map is gone or `base_revision` is given and stale.

    `ydoc` is the room's Yjs state to keep beside the payload; None (every
    write that isn't a room's) clears it, so the next room builds from this
    payload. Raises ValueError for a payload JSON can't represent."""
    blob, node_count = pack(payload)
    row = conn.execute(
        "SELECT revision, payload, node_count FROM maps WHERE id = ?",
        (map_id,),
    ).fetchone()
    if row is None or (base_revision is not None and row["revision"] != base_revision):
        return None
    if history.rolling_due(conn, map_id, now):
        history.add(
            conn,
            map_id,
            revision=row["revision"],
            payload=row["payload"],
            node_count=row["node_count"],
            reason="rolling",
            now=now,
        )
    conn.execute(
        "UPDATE maps SET payload = ?, size_bytes = ?, node_count = ?, revision = revision + 1, updated_at = ?, "
        "ydoc = ?, ydoc_epoch = ? WHERE id = ?",
        (blob, len(blob), node_count, now, ydoc, ydoc_epoch if ydoc is not None else None, map_id),
    )
    return row["revision"] + 1


def parse_revision(header: str) -> int | None:
    value = header.strip()
    if value.startswith("W/"):
        value = value[2:]
    value = value.strip('"')
    return int(value) if value.isdigit() else None


# --- Routes -------------------------------------------------------------------


@maps.get("")
@signed_in
def list_maps() -> Response:
    with database().connect() as conn:
        rows = conn.execute(
            "SELECT id, name, revision, created_at, updated_at, last_opened_at, node_count, size_bytes "
            "FROM maps WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC",
            (user_id(),),
        ).fetchall()
    owner = {"role": "owner", "perms": effective("owner", None, None)}
    return jsonify(maps=[{**dict(row), **owner} for row in rows])


@maps.post("")
@signed_in
def create_map() -> Response | tuple[Response, int]:
    body = json_body()
    name = clean_name(body.get("name")) or DEFAULT_NAME
    payload = body.get("payload", EMPTY_PAYLOAD)
    if not isinstance(payload, dict):
        return fail("`payload` must be a JSON object.", 400)
    try:
        blob, node_count = pack(payload)
    except ValueError:
        return fail("`payload` holds a number JSON can't represent.", 400)
    with database().transaction() as conn:
        map_id = insert_map(conn, user_id(), name, blob, node_count)
    if map_id is None:
        return quota_full()
    return jsonify(id=map_id, name=name, revision=1), 201


@maps.post("/import")
@signed_in
def import_map() -> Response | tuple[Response, int]:
    """A `.plm` (or `.atlasmap`) file as a new map: multipart `file`, `password`,
    optional `name`. The shell reads files itself wherever it can and sends the
    payload to `POST /api/maps`, like Open does; this is for the rest, an
    encrypted file on a page with no WebCrypto (plain HTTP on the LAN)."""
    upload = request.files.get("file")
    if upload is None:
        return fail("No file uploaded.", 400)
    password = request.form.get("password") or ""
    try:
        payload = decode_any(upload.read(), password)
    except PasswordError as exc:
        # The file's password, not the session: say so, like account.py does.
        return fail(str(exc), 401, wrong_password=True)
    except FormatError as exc:
        return fail(str(exc), 400)
    if payload.get("format", PAYLOAD_FORMAT) != PAYLOAD_FORMAT:
        return fail("This is not a Pleiades map.", 400)
    nodes, edges = payload.get("nodes", []), payload.get("edges", [])
    if not isinstance(nodes, list) or not isinstance(edges, list):
        return fail("This file doesn't hold a map.", 400)
    name = clean_name(request.form.get("name")) or clean_name(map_name(upload.filename)) or DEFAULT_NAME
    try:
        blob, node_count = pack(payload)
    except ValueError:
        return fail("The file holds a number JSON can't represent.", 400)
    with database().transaction() as conn:
        map_id = insert_map(conn, user_id(), name, blob, node_count)
    if map_id is None:
        return quota_full()
    return jsonify(id=map_id, name=name, revision=1), 201


@maps.get("/<map_id>")
@signed_in
def get_map(map_id: str) -> Response:
    found = require(map_id, "export")
    with database().connect() as conn:
        row = conn.execute("SELECT name, revision, updated_at, payload FROM maps WHERE id = ?", (map_id,)).fetchone()
        if row is None:
            abort(404)
        if found.role == "owner":
            conn.execute("UPDATE maps SET last_opened_at = ? WHERE id = ?", (dbmod.now(), map_id))
    return jsonify(
        id=map_id,
        name=row["name"],
        revision=row["revision"],
        updated_at=row["updated_at"],
        payload=unpack(row["payload"]),
    )


@maps.put("/<map_id>")
@signed_in
def save_map(map_id: str) -> Response | tuple[Response, int]:
    require(map_id, edit=True)
    header = request.headers.get("If-Match")
    if header is None:
        return fail("Saves need an If-Match header with the revision they were based on.", 428)
    base = parse_revision(header)
    if base is None:
        return fail("If-Match must be a revision number.", 400)
    payload = json_body().get("payload")
    if not isinstance(payload, dict):
        return fail("`payload` must be a JSON object.", 400)

    try:
        with database().transaction() as conn:
            now = dbmod.now()
            revision = write_payload(conn, map_id, payload, now=now, ydoc=None, ydoc_epoch=None, base_revision=base)
            if revision is None:
                row = conn.execute("SELECT revision, updated_at FROM maps WHERE id = ?", (map_id,)).fetchone()
                if row is None:
                    abort(404)
                return fail(
                    "This map was changed in another tab or device.",
                    409,
                    revision=row["revision"],
                    updated_at=row["updated_at"],
                )
    except ValueError:
        return fail("`payload` holds a number JSON can't represent.", 400)
    notify(map_id, "reload")
    return jsonify(revision=revision, updated_at=now)


@maps.patch("/<map_id>")
@signed_in
def rename_map(map_id: str) -> Response | tuple[Response, int]:
    require(map_id, owner=True)
    name = clean_name(json_body().get("name"))
    if name is None:
        return fail("A map needs a name.", 400)
    with database().connect() as conn:
        changed = conn.execute("UPDATE maps SET name = ? WHERE id = ?", (name, map_id)).rowcount
    if not changed:
        abort(404)
    return jsonify(id=map_id, name=name)


@maps.post("/<map_id>/duplicate")
@signed_in
def duplicate_map(map_id: str) -> Response | tuple[Response, int]:
    require(map_id, "export")
    with database().transaction() as conn:
        # The copy is yours: your list, your quota.
        row = conn.execute("SELECT name, payload, node_count FROM maps WHERE id = ?", (map_id,)).fetchone()
        if row is None:
            abort(404)
        name = row["name"][: MAX_NAME_LENGTH - len(COPY_SUFFIX)].rstrip() + COPY_SUFFIX
        new_id = insert_map(conn, user_id(), name, row["payload"], row["node_count"])
    if new_id is None:
        return quota_full()
    return jsonify(id=new_id, name=name, revision=1), 201


@maps.delete("/<map_id>")
@signed_in
def delete_map(map_id: str) -> Response:
    require(map_id, owner=True)
    with database().connect() as conn:
        changed = conn.execute("DELETE FROM maps WHERE id = ?", (map_id,)).rowcount
    if not changed:
        abort(404)
    notify(map_id, "deleted")
    return jsonify(ok=True)


# --- History (server/history.py) -----------------------------------------------


def map_row(conn: sqlite3.Connection, map_id: str) -> sqlite3.Row:
    """The map's current version; the caller has already checked access."""
    row = conn.execute(
        "SELECT revision, updated_at, payload, node_count FROM maps WHERE id = ?", (check_id(map_id),)
    ).fetchone()
    if row is None:
        abort(404)
    return row


@maps.get("/<map_id>/snapshots")
@signed_in
def list_snapshots(map_id: str) -> Response:
    require(map_id, "history")
    with database().connect() as conn:
        row = map_row(conn, map_id)
        snapshots = history.listing(conn, map_id)
    return jsonify(revision=row["revision"], updated_at=row["updated_at"], snapshots=snapshots)


@maps.post("/<map_id>/snapshots")
@signed_in
def keep_unsaved_edits(map_id: str) -> Response | tuple[Response, int]:
    """Edits a tab is about to drop (the conflict panel's "load theirs"), kept in
    history rather than lost. They never were a revision; `revision` says which
    one they were based on."""
    body = json_body()
    payload = body.get("payload")
    if not isinstance(payload, dict):
        return fail("`payload` must be a JSON object.", 400)
    try:
        blob, node_count = pack(payload)
    except ValueError:
        return fail("`payload` holds a number JSON can't represent.", 400)
    base = body.get("revision")
    # Owner only: it writes into the owner's History, which an editor can't even read.
    require(map_id, owner=True)
    with database().transaction() as conn:
        row = map_row(conn, map_id)
        if not isinstance(base, int) or isinstance(base, bool) or not 1 <= base <= row["revision"]:
            base = row["revision"]
        snapshot_id = history.add(
            conn,
            map_id,
            revision=base,
            payload=blob,
            node_count=node_count,
            reason="unsaved-edits",
            now=dbmod.now(),
        )
    return jsonify(id=snapshot_id), 201


@maps.post("/<map_id>/snapshots/<int:snapshot_id>/restore")
@signed_in
def restore_snapshot(map_id: str, snapshot_id: int) -> Response:
    """Makes a snapshot the current version, as a new revision. The version it
    replaces is kept first, so a restore can be undone the same way. A tab
    still open on the map finds out at its next save (409); a live room is told
    to reload."""
    require(map_id, "history")
    with database().transaction() as conn:
        row = map_row(conn, map_id)
        snapshot = conn.execute(
            "SELECT payload, node_count FROM snapshots WHERE id = ? AND map_id = ?", (snapshot_id, map_id)
        ).fetchone()
        if snapshot is None:
            abort(404)
        now = dbmod.now()
        history.add(
            conn,
            map_id,
            revision=row["revision"],
            payload=row["payload"],
            node_count=row["node_count"],
            reason="before-restore",
            now=now,
        )
        revision = row["revision"] + 1
        conn.execute(
            "UPDATE maps SET payload = ?, size_bytes = ?, node_count = ?, revision = ?, updated_at = ?, "
            "ydoc = NULL, ydoc_epoch = NULL WHERE id = ?",
            (snapshot["payload"], len(snapshot["payload"]), snapshot["node_count"], revision, now, map_id),
        )
    notify(map_id, "reload")
    return jsonify(revision=revision, updated_at=now)
