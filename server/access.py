"""Who may open a map, with which role and permissions (context/MOONSHOT.md).

The one place every map route and every room connection asks. Owner first,
then members, then the map's share link (for a signed-in person who hasn't
joined yet, or a guest); someone the owner banned gets nothing but the
owner never is. With sharing switched off only owners get in;
with guest links off, only guests are refused. A map you can't reach is
None — callers answer 404, never 403.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field

from . import db as dbmod
from .accounts import token_hash
from .permissions import effective


@dataclass(frozen=True)
class Switches:
    sharing: bool = True
    guest_links: bool = True


@dataclass(frozen=True)
class Access:
    role: str
    perms: dict[str, bool] = field(hash=False)
    owner_id: int
    user_id: int | None = None
    guest_key: str | None = None
    via_link: bool = False

    @property
    def can_edit(self) -> bool:
        return self.role in ("owner", "editor")


def parse_perms(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def role_defaults(conn: sqlite3.Connection, map_id: str, role: str) -> dict | None:
    row = conn.execute("SELECT perms_json FROM map_roles WHERE map_id = ? AND role = ?", (map_id, role)).fetchone()
    return parse_perms(row["perms_json"]) if row else None


DEFAULT_SWITCHES = Switches()


def banned(conn: sqlite3.Connection, map_id: str, *, user_id: int | None, guest_key: str | None) -> bool:
    """Banned from this map by the owner: an account, or a guest's tab key."""
    if user_id is not None:
        hit = conn.execute("SELECT 1 FROM map_bans WHERE map_id = ? AND user_id = ?", (map_id, user_id)).fetchone()
        if hit:
            return True
    if guest_key:
        hit = conn.execute("SELECT 1 FROM map_bans WHERE map_id = ? AND guest_key = ?", (map_id, guest_key)).fetchone()
        if hit:
            return True
    return False


def link_role(conn: sqlite3.Connection, map_id: str, link_token: str) -> str | None:
    """The role the map's link gives, if `link_token` is its live, unexpired token."""
    link = conn.execute(
        "SELECT role, expires_at FROM map_links WHERE map_id = ? AND token_hash = ?", (map_id, token_hash(link_token))
    ).fetchone()
    if link is None or (link["expires_at"] is not None and link["expires_at"] <= dbmod.now()):
        return None
    return link["role"]


def resolve(
    conn: sqlite3.Connection,
    map_id: str,
    *,
    user_id: int | None = None,
    link_token: str | None = None,
    guest_key: str | None = None,
    switches: Switches = DEFAULT_SWITCHES,
) -> Access | None:
    """`link_token` is a share link's token; `guest_key` marks a signed-out
    guest (one per browser tab) on it."""
    row = conn.execute("SELECT user_id FROM maps WHERE id = ?", (map_id,)).fetchone()
    if row is None:
        return None
    owner_id = row["user_id"]
    if user_id is not None and user_id == owner_id:
        return Access("owner", effective("owner", None, None), owner_id, user_id=user_id)
    if not switches.sharing:
        return None
    if banned(conn, map_id, user_id=user_id, guest_key=guest_key):
        return None
    if user_id is not None:
        member = conn.execute(
            "SELECT role, perms_json FROM map_members WHERE map_id = ? AND user_id = ?", (map_id, user_id)
        ).fetchone()
        if member is not None:
            role = member["role"]
            perms = effective(role, role_defaults(conn, map_id, role), parse_perms(member["perms_json"]))
            return Access(role, perms, owner_id, user_id=user_id)
    if link_token:
        if user_id is None and not switches.guest_links:
            return None
        role = link_role(conn, map_id, link_token)
        if role is None:
            return None
        perms = effective(role, role_defaults(conn, map_id, role), None)
        return Access(role, perms, owner_id, user_id=user_id, guest_key=guest_key, via_link=True)
    return None
