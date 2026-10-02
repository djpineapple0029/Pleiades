"""/admin → Accounts: every account on the server and what the admin can do to
one (USERS.md, "Admin panel additions").

Same door as the rest of /admin: the allowed networks, the bearer token, the
hardened headers. The admin can read the list whether or not accounts are
switched on, so a server that turned them off can still be cleaned up; the
database is never created just to show an empty list.

Every action that changes who may sign in ends the account's sessions at once:
a password reset, disabling it and deleting it. A reset hands back a temporary
password, shown once; the account can then only choose a new one
(server/account.py) before it gets its maps back.
"""

from __future__ import annotations

import secrets
import sqlite3

from flask import Blueprint, Response, current_app, jsonify, request

from . import db as dbmod
from .admin import Guard, fail, harden, only_allowed_networks, signed_in
from .config import ConfigStore, hash_password
from .db import Database
from .maps import disconnect_user

admin_users = Blueprint("admin_users", __name__, url_prefix="/api/admin/users")
admin_users.before_request(only_allowed_networks)
admin_users.after_request(harden)

# Temporary passwords: read aloud or typed from a message, so no 0/O, 1/l/I.
TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
TEMP_GROUP = 4


def store() -> ConfigStore:
    return current_app.extensions["pleiades_config"]


def database() -> Database:
    return current_app.extensions["pleiades_db"]


def account_guard() -> Guard:
    return current_app.extensions["pleiades_account_guard"]


def database_exists() -> bool:
    return database().path.is_file()


def temporary_password() -> str:
    """Four-letter groups, at least as long as the shortest password allowed."""
    length = max(16, store().get("accounts", "min_password_length"))
    groups = -(-length // TEMP_GROUP)
    return "-".join("".join(secrets.choice(TEMP_ALPHABET) for _ in range(TEMP_GROUP)) for _ in range(groups))


def find_user(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT id, username FROM users WHERE id = ?", (user_id,)).fetchone()


def missing() -> tuple[Response, int]:
    return fail("No such account. Someone may have deleted it already.", 404)


# --- Routes -------------------------------------------------------------------


@admin_users.get("")
@signed_in
def list_users() -> Response:
    enabled = bool(store().get("accounts", "enabled"))
    if not database_exists():
        return jsonify(enabled=enabled, users=[], database=database().status())
    with database().connect() as conn:
        rows = conn.execute(
            """SELECT u.id, u.username, u.created_at, u.last_login_at, u.disabled, u.must_change_password,
                (SELECT COUNT(*) FROM maps m WHERE m.user_id = u.id) AS map_count,
                (SELECT COALESCE(SUM(m.size_bytes), 0) FROM maps m WHERE m.user_id = u.id) AS map_bytes,
                (SELECT COALESCE(SUM(s.size_bytes), 0) FROM snapshots s JOIN maps m ON m.id = s.map_id
                    WHERE m.user_id = u.id) AS history_bytes,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > :now) AS sessions,
                (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
            FROM users u ORDER BY u.username""",
            {"now": dbmod.now()},
        ).fetchall()
    users = []
    for row in rows:
        user = dict(row)
        user["disabled"] = bool(user["disabled"])
        user["must_change_password"] = bool(user["must_change_password"])
        # A session is touched at most hourly; a sign-in is exact. The later wins.
        user["last_seen_at"] = max(filter(None, (user["last_seen_at"], user["last_login_at"])), default=None)
        users.append(user)
    return jsonify(enabled=enabled, users=users, database=database().status())


@admin_users.post("/<int:user_id>/password")
@signed_in
def reset_password(user_id: int) -> Response | tuple[Response, int]:
    """A temporary password, shown once. It must be changed at the next sign-in."""
    if not database_exists():
        return missing()
    password = temporary_password()
    password_hash = hash_password(password)
    with database().transaction() as conn:
        user = find_user(conn, user_id)
        if user is None:
            return missing()
        conn.execute(
            "UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?", (password_hash, user_id)
        )
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    disconnect_user(user_id, [])
    # Whoever forgot it may have locked the name out trying; the new one should work at once.
    account_guard().succeed(f"user:{user['username']}")
    return jsonify(username=user["username"], password=password)


@admin_users.patch("/<int:user_id>")
@signed_in
def set_disabled(user_id: int) -> Response | tuple[Response, int]:
    """`{disabled: bool}`. Disabling signs the account out everywhere; its maps stay."""
    body = request.get_json(silent=True)
    disabled = body.get("disabled") if isinstance(body, dict) else None
    if not isinstance(disabled, bool):
        return fail("Expected {disabled: true|false}.", 400)
    if not database_exists():
        return missing()
    with database().transaction() as conn:
        user = find_user(conn, user_id)
        if user is None:
            return missing()
        conn.execute("UPDATE users SET disabled = ? WHERE id = ?", (int(disabled), user_id))
        if disabled:
            conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    if disabled:
        disconnect_user(user_id, [])
    return jsonify(ok=True, disabled=disabled)


@admin_users.post("/<int:user_id>/sign-out")
@signed_in
def sign_out_everywhere(user_id: int) -> Response | tuple[Response, int]:
    if not database_exists():
        return missing()
    with database().transaction() as conn:
        if find_user(conn, user_id) is None:
            return missing()
        ended = conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,)).rowcount
    disconnect_user(user_id, [])
    return jsonify(ok=True, ended=ended)


@admin_users.delete("/<int:user_id>")
@signed_in
def delete_user(user_id: int) -> Response | tuple[Response, int]:
    """`{username}` must repeat the account's name: the typed confirmation,
    checked here as well as in the page. Maps, history, settings and sessions
    go with it (ON DELETE CASCADE)."""
    body = request.get_json(silent=True)
    typed = body.get("username") if isinstance(body, dict) else None
    if not database_exists():
        return missing()
    with database().transaction() as conn:
        user = find_user(conn, user_id)
        if user is None:
            return missing()
        if not isinstance(typed, str) or typed.strip().lower() != user["username"]:
            return fail(f"Type the username ({user['username']}) to confirm.", 400)
        owned = [row["id"] for row in conn.execute("SELECT id FROM maps WHERE user_id = ?", (user_id,))]
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    disconnect_user(user_id, owned)
    return jsonify(ok=True)
