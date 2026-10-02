"""Sharing a map with other accounts (context/MOONSHOT.md): by username, as
Editor or Viewer, plus the "Shared with me" list.

Granting follows permissions.can_grant: nobody gives a role above their own,
and only people with the Invite permission give one at all. Only the owner
changes someone's role, permissions or the role defaults, or removes
someone; anyone can remove themselves ("Leave"). Every change tells the
map's live room, which re-checks everyone in it at once.
"""

from __future__ import annotations

import json
import secrets

from flask import Blueprint, Response, jsonify

from . import access
from . import db as dbmod
from .accounts import cookie_path, database, fail, finish, gate, json_body, signed_in, token_hash
from .maps import check_id, notify, require, switches, user_id
from .permissions import PERMS, ROLE_RANK, can_grant, effective

sharing = Blueprint("sharing", __name__, url_prefix="/api/maps")
sharing.before_request(gate)
sharing.after_request(finish)

ROLES = ("editor", "viewer")
LINK_DAYS = (None, 1, 7, 30)
DAY = 86_400


def clean_perms(raw: object) -> dict[str, bool] | None:
    """Only known permissions with true/false values; None when it isn't an object."""
    if not isinstance(raw, dict):
        return None
    return {key: value for key, value in raw.items() if key in PERMS and isinstance(value, bool)}


@sharing.get("/shared")
@signed_in
def shared_with_me() -> Response:
    if not switches().sharing:
        return jsonify(maps=[])
    with database().connect() as conn:
        rows = conn.execute(
            "SELECT maps.id, maps.name, maps.updated_at, maps.node_count, users.username AS owner, "
            "map_members.role, map_members.perms_json, map_members.seen_at IS NULL AS new "
            "FROM map_members JOIN maps ON maps.id = map_members.map_id JOIN users ON users.id = maps.user_id "
            "WHERE map_members.user_id = ? ORDER BY maps.updated_at DESC, maps.created_at DESC",
            (user_id(),),
        ).fetchall()
        out = []
        for row in rows:
            item = {key: row[key] for key in row.keys() if key != "perms_json"}  # noqa: SIM118 -- sqlite3.Row
            defaults = access.role_defaults(conn, row["id"], row["role"])
            item["perms"] = effective(row["role"], defaults, access.parse_perms(row["perms_json"]))
            item["new"] = bool(row["new"])
            out.append(item)
    return jsonify(maps=out)


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
        stored = {role: access.role_defaults(conn, map_id, role) for role in ROLES}
        link = conn.execute(
            "SELECT role, expires_at, created_at FROM map_links "
            "WHERE map_id = ? AND (expires_at IS NULL OR expires_at > ?)",
            (map_id, dbmod.now()),
        ).fetchone()
    role_defaults = {role: effective(role, stored[role], None) for role in ROLES}
    return jsonify(
        you={"user_id": found.user_id, "role": found.role, "perms": found.perms},
        owner={"id": owner["id"], "username": owner["username"]},
        members=[
            {
                "user_id": row["user_id"],
                "username": row["username"],
                "role": row["role"],
                "perms_override": access.parse_perms(row["perms_json"]),
                "effective": effective(row["role"], stored[row["role"]], access.parse_perms(row["perms_json"])),
            }
            for row in members
        ],
        role_defaults=role_defaults,
        # Never the token: it's shown once, when made (context/MOONSHOT.md).
        link=dict(link) if link else None,
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
    """Owner only: `role`, and/or `perms` (an override; null clears it)."""
    require(map_id, owner=True)
    body = json_body()
    if "role" not in body and "perms" not in body:
        return fail("Say what to change: role or perms.", 400)
    sets, values = [], []
    if "role" in body:
        if body["role"] not in ROLES:
            return fail("The role must be editor or viewer.", 400)
        sets.append("role = ?")
        values.append(body["role"])
    if "perms" in body:
        perms = None if body["perms"] is None else clean_perms(body["perms"])
        if body["perms"] is not None and perms is None:
            return fail("Permissions must be an object of true/false values.", 400)
        sets.append("perms_json = ?")
        values.append(json.dumps(perms) if perms else None)
    with database().connect() as conn:
        changed = conn.execute(
            f"UPDATE map_members SET {', '.join(sets)} WHERE map_id = ? AND user_id = ?",  # noqa: S608 -- fixed column names
            (*values, map_id, member_id),
        ).rowcount
        row = conn.execute(
            "SELECT role, perms_json FROM map_members WHERE map_id = ? AND user_id = ?", (map_id, member_id)
        ).fetchone()
    if not changed:
        return fail("That person isn't in this map's list.", 404)
    notify(map_id, "access")
    return jsonify(user_id=member_id, role=row["role"], perms_override=access.parse_perms(row["perms_json"]))


@sharing.put("/<map_id>/roles/<role>")
@signed_in
def set_role_defaults(map_id: str, role: str) -> Response | tuple[Response, int]:
    """Owner only: what everyone with this role may do here, unless overridden."""
    require(map_id, owner=True)
    if role not in ROLES:
        return fail("The role must be editor or viewer.", 400)
    perms = clean_perms(json_body().get("perms"))
    if perms is None:
        return fail("Permissions must be an object of true/false values.", 400)
    with database().connect() as conn:
        conn.execute(
            "INSERT INTO map_roles (map_id, role, perms_json) VALUES (?, ?, ?) "
            "ON CONFLICT (map_id, role) DO UPDATE SET perms_json = excluded.perms_json",
            (map_id, role, json.dumps(perms)),
        )
        stored = access.role_defaults(conn, map_id, role)
    notify(map_id, "access")
    return jsonify(role=role, perms=effective(role, stored, None))


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


# --- Share links (context/MOONSHOT.md): one live link per map ---------------


@sharing.post("/<map_id>/link")
@signed_in
def make_link(map_id: str) -> Response | tuple[Response, int]:
    """A new link, replacing any old one (whose token stops working at once).
    The URL is the only time the token is shown."""
    found = require(map_id, "invite")
    body = json_body()
    role = body.get("role")
    if role not in ROLES:
        return fail("The role must be editor or viewer.", 400)
    if not can_grant(found.role, found.perms, role):
        return fail(
            f"You can't make a link that lets people {'edit' if role == 'editor' else 'view'}.",
            403,
            permission="invite",
        )
    days = body.get("expires_in_days")
    if days not in LINK_DAYS or isinstance(days, bool):
        return fail("A link lasts for ever, or 1, 7 or 30 days.", 400)
    token = secrets.token_urlsafe(32)
    now = dbmod.now()
    expires_at = None if days is None else now + days * DAY
    with database().transaction() as conn:
        conn.execute("DELETE FROM map_links WHERE map_id = ?", (map_id,))
        conn.execute(
            "INSERT INTO map_links (map_id, token_hash, role, expires_at, created_by, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (map_id, token_hash(token), role, expires_at, found.user_id, now),
        )
    notify(map_id, "access")  # anyone in on the old link is sent out
    return jsonify(url=f"{cookie_path()}s/{token}", role=role, expires_at=expires_at), 201


@sharing.delete("/<map_id>/link")
@signed_in
def revoke_link(map_id: str) -> Response:
    require(map_id, "invite")
    with database().connect() as conn:
        conn.execute("DELETE FROM map_links WHERE map_id = ?", (map_id,))
    notify(map_id, "access")
    return jsonify(ok=True)


@sharing.post("/<map_id>/join")
@signed_in
def join_by_link(map_id: str) -> Response | tuple[Response, int]:
    """A signed-in person opened a share link: they become a member with the
    link's role (or keep a higher one they had), so the map is in their
    Shared with me from now on."""
    check_id(map_id)
    token = json_body().get("link")
    if not isinstance(token, str) or not token:
        return fail("That link doesn't work any more.", 404)
    me = user_id()
    with database().transaction() as conn:
        found = access.resolve(conn, map_id, user_id=me, link_token=token, switches=switches())
        link_role = access.link_role(conn, map_id, token) if found is not None else None
        if found is None or link_role is None:
            return fail("That link doesn't work any more.", 404)
        role = found.role
        if found.via_link:
            conn.execute(
                "INSERT INTO map_members (map_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, NULL, ?)",
                (map_id, me, link_role, dbmod.now()),
            )
            role = link_role
        elif role != "owner" and ROLE_RANK[link_role] > ROLE_RANK[role]:
            conn.execute("UPDATE map_members SET role = ? WHERE map_id = ? AND user_id = ?", (link_role, map_id, me))
            role = link_role
        else:
            return jsonify(role=role)
    notify(map_id, "access")
    return jsonify(role=role)
