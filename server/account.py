"""A signed-in user's own account: for now, their settings (USERS.md decision 17).

What a user may set is what `settings_schema.json` marks `user: true`: the
client settings and the keybinds. They store only what they changed; the
admin's values (/admin) stay the defaults underneath, so an admin change still
reaches every setting a user hasn't touched. `/api/config` serves the layered
result to a signed-in browser (server/api.py).

Milestone 7's self-service routes (password, username, sessions, delete,
export) belong here too.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable

from flask import Blueprint, Response, jsonify, request

from .accounts import current_user, database, fail, finish, gate, signed_in, store
from .config import apply_overrides, validate_overrides

account = Blueprint("account", __name__, url_prefix="/api/account")
account.before_request(gate)
account.after_request(finish)


def load_overrides(conn: sqlite3.Connection, user_id: int) -> dict:
    row = conn.execute("SELECT json FROM user_settings WHERE user_id = ?", (user_id,)).fetchone()
    if row is None:
        return {}
    try:
        value = json.loads(row["json"])
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def write_overrides(conn: sqlite3.Connection, user_id: int, overrides: dict) -> None:
    if not overrides:
        conn.execute("DELETE FROM user_settings WHERE user_id = ?", (user_id,))
        return
    conn.execute(
        "INSERT INTO user_settings (user_id, json) VALUES (?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET json = excluded.json",
        (user_id, json.dumps(overrides, separators=(",", ":"))),
    )


def effective_config(user_id: int) -> tuple[dict, dict, list[str]]:
    """(the user's overrides still in force, the values their browser gets, problems)."""
    with database().connect() as conn:
        overrides = load_overrides(conn, user_id)
    effective, kept, problems = apply_overrides(store().client_values(), overrides)
    return kept, effective, problems


def user_id() -> int:
    user = current_user()
    assert user is not None  # noqa: S101 -- @signed_in ran first
    return user["id"]


def settings_response(owner: int) -> Response:
    overrides, effective, problems = effective_config(owner)
    return jsonify(overrides=overrides, server=store().client_values(), effective=effective, problems=problems)


def merge_patch(base: dict, patch: dict) -> dict:
    """`patch` over `base`, one level into each section; `None` removes a key."""
    out = {section: dict(values) for section, values in base.items() if isinstance(values, dict)}
    for section, values in patch.items():
        if not isinstance(values, dict):
            # Left for validate_overrides to refuse with a proper message.
            out[section] = values
            continue
        target = out.setdefault(section, {})
        for key, value in values.items():
            if value is None:
                target.pop(key, None)
            else:
                target[key] = value
        if not target:
            del out[section]
    return out


def save(owner: int, build: Callable[[dict], object]) -> Response | tuple[Response, int]:
    """Validate what `build(current overrides)` returns and store it, in one
    transaction. `current` holds only what still works against the admin's
    values, so a patch never fails over a key the admin has since taken."""
    client = store().client_values()
    with database().transaction() as conn:
        _, current, _ = apply_overrides(client, load_overrides(conn, owner))
        clean, errors = validate_overrides(build(current), client["keybinds"])
        if errors:
            # Nothing written; the empty transaction just commits.
            return fail("Not saved.", 400, errors=errors)
        write_overrides(conn, owner, clean)
    return settings_response(owner)


@account.get("/settings")
@signed_in
def read_settings() -> Response:
    return settings_response(user_id())


@account.put("/settings")
@signed_in
def replace_settings() -> Response | tuple[Response, int]:
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return fail("Expected a JSON object body.", 400)
    return save(user_id(), lambda _current: body)


@account.patch("/settings")
@signed_in
def change_settings() -> Response | tuple[Response, int]:
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return fail("Expected a JSON object body.", 400)
    return save(user_id(), lambda current: merge_patch(current, body))
