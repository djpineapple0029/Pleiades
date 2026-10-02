"""Who may open a map, with which role and permissions (context/MOONSHOT.md).

The one place every map route and every room connection asks. Owner first,
then members; links, bans and the admin switches join in later. A map you
can't reach is None — callers answer 404, never 403.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field

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


def resolve(
    conn: sqlite3.Connection,
    map_id: str,
    *,
    user_id: int | None = None,
    link_token: str | None = None,
    guest_key: str | None = None,
    switches: Switches = DEFAULT_SWITCHES,
) -> Access | None:
    """`link_token`/`guest_key` are for share links (milestone 2); unused yet."""
    row = conn.execute("SELECT user_id FROM maps WHERE id = ?", (map_id,)).fetchone()
    if row is None:
        return None
    owner_id = row["user_id"]
    if user_id is not None and user_id == owner_id:
        return Access("owner", effective("owner", None, None), owner_id, user_id=user_id)
    if not switches.sharing:
        return None
    if user_id is not None:
        member = conn.execute(
            "SELECT role, perms_json FROM map_members WHERE map_id = ? AND user_id = ?", (map_id, user_id)
        ).fetchone()
        if member is not None:
            role = member["role"]
            perms = effective(role, role_defaults(conn, map_id, role), parse_perms(member["perms_json"]))
            return Access(role, perms, owner_id, user_id=user_id)
    return None
