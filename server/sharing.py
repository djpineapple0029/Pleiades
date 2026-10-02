"""Sharing a map with other accounts (context/MOONSHOT.md): by username, as
Editor or Viewer, plus the "Shared with me" list.

Granting follows permissions.can_grant: nobody gives a role above their own,
and only people with the Invite permission give one at all. Only the owner
changes someone's role or removes them; anyone can remove themselves
("Leave"). Every change tells the map's live room, which re-checks who may
stay (milestone 2).
"""

from __future__ import annotations

from flask import Blueprint, Response, jsonify

from . import access
from . import db as dbmod
from .accounts import database, fail, finish, gate, json_body, signed_in
from .maps import check_id, notify, require, switches, user_id
from .permissions import DEFAULTS, can_grant

sharing = Blueprint("sharing", __name__, url_prefix="/api/maps")
sharing.before_request(gate)
sharing.after_request(finish)

ROLES = ("editor", "viewer")


@sharing.get("/shared")
@signed_in
def shared_with_me() -> Response:
    if not switches().sharing:
        return jsonify(maps=[])
    with database().connect() as conn:
        rows = conn.execute(
            "SELECT maps.id, maps.name, maps.updated_at, maps.node_count, users.username AS owner, "
            "map_members.role, map_members.seen_at IS NULL AS new "
            "FROM map_members JOIN maps ON maps.id = map_members.map_id JOIN users ON users.id = maps.user_id "
            "WHERE map_members.user_id = ? ORDER BY maps.updated_at DESC, maps.created_at DESC",
            (user_id(),),
        ).fetchall()
    return jsonify(maps=[{**dict(row), "new": bool(row["new"])} for row in rows])


@sharing.get("/<map_id>/sharing")
@signed_in
def sharing_info(map_id: str) -> Response:
    found = require(map_id)
    with database().connect() as conn:
        owner = conn.execute(
            "SELECT users.id, users.username FROM maps JOIN users ON users.id = maps.user_id WHERE maps.id = ?",
            (map_id,),
        ).fetchone()
        members = conn.execute(
            "SELECT map_members.user_id, users.username, map_members.role, map_members.perms_json "
            "FROM map_members JOIN users ON users.id = map_members.user_id "
            "WHERE map_members.map_id = ? ORDER BY map_members.added_at, users.username",
            (map_id,),
        ).fetchall()
        role_defaults = {role: {**DEFAULTS[role], **(access.role_defaults(conn, map_id, role) or {})} for role in ROLES}
    return jsonify(
        you={"user_id": found.user_id, "role": found.role, "perms": found.perms},
        owner={"id": owner["id"], "username": owner["username"]},
        members=[
            {
                "user_id": row["user_id"],
                "username": row["username"],
                "role": row["role"],
                "perms_override": access.parse_perms(row["perms_json"]),
            }
            for row in members
        ],
        role_defaults=role_defaults,
        link=None,
    )


@sharing.post("/<map_id>/members")
@signed_in
def add_member(map_id: str) -> Response | tuple[Response, int]:
    found = require(map_id)
    body = json_body()
    role = body.get("role")
    if role not in ROLES:
        return fail("The role must be editor or viewer.", 400)
    if not can_grant(found.role, found.perms, role):
        return fail(f"You can't add people to this map as {role}.", 403, permission="invite")
    raw = body.get("username")
    username = raw.strip().lower() if isinstance(raw, str) else ""
    with database().transaction() as conn:
        user = conn.execute("SELECT id, username FROM users WHERE username = ?", (username,)).fetchone()
        if user is None:
            return fail(f"No account called “{username}”.", 404)
        has_access = (
            user["id"] == found.owner_id
            or conn.execute(
                "SELECT 1 FROM map_members WHERE map_id = ? AND user_id = ?", (map_id, user["id"])
            ).fetchone()
        )
        if has_access:
            return fail(f"{user['username']} already has access to this map.", 409)
        conn.execute(
            "INSERT INTO map_members (map_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?)",
            (map_id, user["id"], role, user_id(), dbmod.now()),
        )
    notify(map_id, "access")
    return jsonify(user_id=user["id"], username=user["username"], role=role), 201


@sharing.patch("/<map_id>/members/<int:member_id>")
@signed_in
def change_member(map_id: str, member_id: int) -> Response | tuple[Response, int]:
    require(map_id, owner=True)
    role = json_body().get("role")
    if role not in ROLES:
        return fail("The role must be editor or viewer.", 400)
    with database().connect() as conn:
        changed = conn.execute(
            "UPDATE map_members SET role = ? WHERE map_id = ? AND user_id = ?", (role, map_id, member_id)
        ).rowcount
    if not changed:
        return fail("That person isn't in this map's list.", 404)
    notify(map_id, "access")
    return jsonify(user_id=member_id, role=role)


@sharing.delete("/<map_id>/members/<int:member_id>")
@signed_in
def remove_member(map_id: str, member_id: int) -> Response | tuple[Response, int]:
    found = require(check_id(map_id))
    if found.role != "owner" and member_id != found.user_id:
        return fail("Only the map's owner can remove other people.", 403, permission="owner")
    with database().connect() as conn:
        changed = conn.execute("DELETE FROM map_members WHERE map_id = ? AND user_id = ?", (map_id, member_id)).rowcount
    if not changed:
        return fail("That person isn't in this map's list.", 404)
    notify(map_id, "access")
    return jsonify(ok=True)
