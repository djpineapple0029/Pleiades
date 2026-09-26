"""A signed-in user's maps: list, create, open, save, rename, duplicate, delete.

The server keeps the same JSON payload that goes inside an `.atlasmap` file,
zlib-compressed and otherwise untouched: unknown fields pass straight through,
since the frontend owns the payload's shape (format/schema.js).

Every query is scoped to the signed-in user, and a map that belongs to someone
else is a 404, never a 403. Saves carry the revision they were based on in
`If-Match`; a save based on an older revision is refused with 409 and the
current revision, so two tabs never silently overwrite each other.
"""

from __future__ import annotations

import json
import re
import secrets
import sqlite3
import zlib

from flask import Blueprint, Response, abort, jsonify, request

from . import db as dbmod
from .accounts import current_user, database, fail, finish, gate, json_body, signed_in, store

maps = Blueprint("maps", __name__, url_prefix="/api/maps")
maps.before_request(gate)
maps.after_request(finish)

MAP_ID_RE = re.compile(r"[A-Za-z0-9_-]{16}")
MAX_NAME_LENGTH = 120
DEFAULT_NAME = "Untitled map"
COPY_SUFFIX = " (copy)"
EMPTY_PAYLOAD = {"format": "atlasmap", "schema": 1, "nodes": [], "edges": []}


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
    return jsonify(maps=[dict(row) for row in rows])


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


@maps.get("/<map_id>")
@signed_in
def get_map(map_id: str) -> Response:
    check_id(map_id)
    with database().connect() as conn:
        row = conn.execute(
            "SELECT name, revision, updated_at, payload FROM maps WHERE id = ? AND user_id = ?",
            (map_id, user_id()),
        ).fetchone()
        if row is None:
            abort(404)
        conn.execute(
            "UPDATE maps SET last_opened_at = ? WHERE id = ? AND user_id = ?", (dbmod.now(), map_id, user_id())
        )
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
    check_id(map_id)
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
        blob, node_count = pack(payload)
    except ValueError:
        return fail("`payload` holds a number JSON can't represent.", 400)

    with database().transaction() as conn:
        now = dbmod.now()
        changed = conn.execute(
            "UPDATE maps SET payload = ?, size_bytes = ?, node_count = ?, revision = revision + 1, updated_at = ? "
            "WHERE id = ? AND user_id = ? AND revision = ?",
            (blob, len(blob), node_count, now, map_id, user_id(), base),
        ).rowcount
        row = conn.execute(
            "SELECT revision, updated_at FROM maps WHERE id = ? AND user_id = ?", (map_id, user_id())
        ).fetchone()
    if row is None:
        abort(404)
    if not changed:
        return fail(
            "This map was changed in another tab or device.",
            409,
            revision=row["revision"],
            updated_at=row["updated_at"],
        )
    return jsonify(revision=row["revision"], updated_at=row["updated_at"])


@maps.patch("/<map_id>")
@signed_in
def rename_map(map_id: str) -> Response | tuple[Response, int]:
    check_id(map_id)
    name = clean_name(json_body().get("name"))
    if name is None:
        return fail("A map needs a name.", 400)
    with database().connect() as conn:
        changed = conn.execute(
            "UPDATE maps SET name = ? WHERE id = ? AND user_id = ?", (name, map_id, user_id())
        ).rowcount
    if not changed:
        abort(404)
    return jsonify(id=map_id, name=name)


@maps.post("/<map_id>/duplicate")
@signed_in
def duplicate_map(map_id: str) -> Response | tuple[Response, int]:
    check_id(map_id)
    with database().transaction() as conn:
        row = conn.execute(
            "SELECT name, payload, node_count FROM maps WHERE id = ? AND user_id = ?", (map_id, user_id())
        ).fetchone()
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
    check_id(map_id)
    with database().connect() as conn:
        changed = conn.execute("DELETE FROM maps WHERE id = ? AND user_id = ?", (map_id, user_id())).rowcount
    if not changed:
        abort(404)
    return jsonify(ok=True)
