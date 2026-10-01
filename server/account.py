"""A signed-in user's own account: their settings (USERS.md decision 17), and
the self-service of decisions 16 and 20: password, username, signing out
other devices, deleting the account, and a zip of everything in it.

What a user may set is what `settings_schema.json` marks `user: true`: the
client settings and the keybinds. They store only what they changed; the
admin's values (/admin) stay the defaults underneath, so an admin change still
reaches every setting a user hasn't touched. `/api/config` serves the layered
result to a signed-in browser (server/api.py).

A password reset by the admin (/admin → Accounts) leaves the account able to
do one thing: choose a new password here.

Changing the username or deleting the account asks for the password again:
a 30-day session on a shared computer shouldn't be enough for either. A
wrong one counts toward the same lockouts as signing in, and answers 401
with `wrong_password: true`, so the shell can tell it from a lost session.
"""

from __future__ import annotations

import io
import json
import sqlite3
import time
import zipfile
import zlib
from collections.abc import Callable

from flask import Blueprint, Response, g, jsonify, request, send_file

from . import db as dbmod
from .accounts import (
    COOKIE,
    MAX_PASSWORD_LENGTH,
    USERNAME_RE,
    busy,
    check_or_none,
    clear_cookie,
    client_ip,
    current_user,
    database,
    even_after_reset,
    fail,
    finish,
    gate,
    guard,
    hash_or_none,
    json_body,
    locked_out,
    new_password_problem,
    record_wrong_password,
    signed_in,
    store,
    token_hash,
)
from .atlasfile import encode_v2
from .config import apply_overrides, validate_overrides
from .filenames import SUFFIX, download_name

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


def this_session() -> str:
    """The hash of the session this request came with: the one to keep."""
    return token_hash(request.cookies.get(COOKIE, ""))


def wrong_password(message: str = "Wrong current password.") -> tuple[Response, int]:
    return fail(message, 401, wrong_password=True)


def confirm_password(user: sqlite3.Row, password: object) -> tuple[Response, int] | None:
    """None when `password` is this user's; otherwise the answer to send. Wrong
    ones count toward the same lockouts as signing in."""
    ip_key, user_key = f"ip:{client_ip()}", f"user:{user['username']}"
    blocked = locked_out(ip_key, user_key)
    if blocked:
        return blocked
    if not isinstance(password, str) or not password or len(password) > MAX_PASSWORD_LENGTH:
        return wrong_password()
    with database().connect() as conn:
        (stored,) = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
    matches = check_or_none(password, stored)
    if matches is None:
        return busy()
    if not matches:
        record_wrong_password(ip_key, user_key)
        return wrong_password()
    guard().succeed(user_key)
    return None


def signed_in_user() -> sqlite3.Row:
    user = current_user()
    assert user is not None  # noqa: S101 -- @signed_in ran first
    return user


@account.get("")
@signed_in
def summary() -> Response:
    """What the Account page shows: who, since when, how many other sessions, how much stored."""
    user = signed_in_user()
    with database().connect() as conn:
        created_at, others, maps, map_bytes = conn.execute(
            "SELECT users.created_at, "
            "(SELECT COUNT(*) FROM sessions WHERE user_id = users.id AND expires_at > ? AND token_hash != ?), "
            "(SELECT COUNT(*) FROM maps WHERE user_id = users.id), "
            "(SELECT COALESCE(SUM(size_bytes), 0) FROM maps WHERE user_id = users.id) "
            "FROM users WHERE users.id = ?",
            (dbmod.now(), this_session(), user["id"]),
        ).fetchone()
    return jsonify(
        username=user["username"],
        created_at=created_at,
        other_sessions=others,
        maps=maps,
        map_bytes=map_bytes,
        max_maps=store().get("accounts", "max_maps_per_user"),
    )


@account.post("/password")
@signed_in
@even_after_reset
def change_password() -> Response | tuple[Response, int]:
    """`{current, new}`. After an admin reset, `current` isn't asked for: the
    reset ended every session, so this one was opened with the temporary
    password moments ago. Every other session of the account ends here too."""
    user = signed_in_user()
    body = json_body()
    current, new = body.get("current"), body.get("new")
    refused = new_password_problem(new)
    if refused:
        return fail(refused, 400)
    assert isinstance(new, str)  # noqa: S101 -- new_password_problem checked it

    if user["must_change_password"]:
        # The temporary password was handed over in the clear; it can't stay.
        with database().connect() as conn:
            (stored,) = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],)).fetchone()
        same = check_or_none(new, stored)
        if same is None:
            return busy()
        if same:
            return fail("Choose a password other than the temporary one.", 400)
    else:
        refused_current = confirm_password(user, current)
        if refused_current:
            return refused_current

    password_hash = hash_or_none(new)
    if password_hash is None:
        return busy()
    with database().transaction() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", (password_hash, user["id"])
        )
        conn.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user["id"], this_session()))
    return jsonify(user={"username": user["username"], "must_change_password": False})


@account.post("/username")
@signed_in
def change_username() -> Response | tuple[Response, int]:
    """`{username, password}`. Sessions stay: they belong to the account, not the name."""
    user = signed_in_user()
    body = json_body()
    raw = body.get("username")
    username = raw.strip().lower() if isinstance(raw, str) else ""
    if not USERNAME_RE.fullmatch(username):
        return fail("Usernames are 3–32 characters: letters, digits, _ . and -.", 400)
    if username == user["username"]:
        return fail("That's already your username.", 400)
    refused = confirm_password(user, body.get("password"))
    if refused:
        return refused
    try:
        with database().transaction() as conn:
            conn.execute("UPDATE users SET username = ? WHERE id = ?", (username, user["id"]))
    except sqlite3.IntegrityError:
        return fail("That username is taken.", 409)
    return jsonify(user={"username": username, "must_change_password": False})


@account.post("/sessions/revoke-others")
@signed_in
def sign_out_others() -> Response:
    """Every session of this account but this one: other browsers, other devices."""
    with database().connect() as conn:
        ended = conn.execute(
            "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", (user_id(), this_session())
        ).rowcount
    return jsonify(ended=ended)


@account.delete("")
@signed_in
def delete_account() -> Response | tuple[Response, int]:
    """`{password}`. The account and everything in it: maps, their history,
    settings, every session. There's no undo; the zip export is the way to
    keep a copy first."""
    user = signed_in_user()
    refused = confirm_password(user, json_body().get("password"))
    if refused:
        return refused
    with database().transaction() as conn:
        # Maps, snapshots, settings and sessions go with it (ON DELETE CASCADE).
        conn.execute("DELETE FROM users WHERE id = ?", (user["id"],))
    # The name may be signed up again; it shouldn't inherit a lockout.
    guard().succeed(f"user:{user['username']}")
    g.pop("reissue_token", None)
    response = jsonify(ok=True)
    clear_cookie(response)
    return response


# --- Download all my data -------------------------------------------------------

EXPORT_FORMAT = "pleiades-account-export"
EXPORT_VERSION = 1
EXPORT_README = """Everything in your Pleiades account "{username}", as of {date} (UTC).

maps/        Each map as a .plm file, with no password, so anyone holding
             this zip can read them. Open one in Pleiades with "Open a file"
             (signed out), or upload it in My maps.
manifest.json  Names, dates and star counts of the maps, and your own
             settings and keys (only the ones you changed).

Earlier versions of each map (History in My maps) are not included.
"""


def unique_file(name: str, taken: set[str]) -> str:
    """`maps/<name>.plm`, numbered when two maps share a name (case-insensitively)."""
    # A slash in a map's name is just a character, not a folder to drop.
    base = download_name(name.replace("/", "-").replace("\\", "-")).removesuffix(SUFFIX)
    candidate, n = base, 1
    while candidate.lower() in taken:
        n += 1
        candidate = f"{base} ({n})"
    taken.add(candidate.lower())
    return f"maps/{candidate}{SUFFIX}"


def zip_time(seconds: int) -> tuple[int, int, int, int, int, int]:
    # Zip timestamps start in 1980 and carry no zone; UTC, like the README says.
    stamp = time.gmtime(max(seconds, 315532800))
    return (stamp.tm_year, stamp.tm_mon, stamp.tm_mday, stamp.tm_hour, stamp.tm_min, stamp.tm_sec)


def add_file(archive: zipfile.ZipFile, path: str, data: bytes, seconds: int) -> None:
    info = zipfile.ZipInfo(path, date_time=zip_time(seconds))
    info.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(info, data)


@account.get("/export.zip")
@signed_in
def export_all() -> Response:
    """Every map as an unencrypted `.plm`, plus a manifest (USERS.md decision 16)."""
    user = signed_in_user()
    now = dbmod.now()
    with database().connect() as conn:
        rows = conn.execute(
            "SELECT id, name, payload, revision, node_count, created_at, updated_at "
            "FROM maps WHERE user_id = ? ORDER BY created_at, rowid",
            (user["id"],),
        ).fetchall()
        created_at = conn.execute("SELECT created_at FROM users WHERE id = ?", (user["id"],)).fetchone()[0]
        settings = load_overrides(conn, user["id"])

    buffer = io.BytesIO()
    taken: set[str] = set()
    listed = []
    with zipfile.ZipFile(buffer, "w") as archive:
        for row in rows:
            path = unique_file(row["name"], taken)
            payload = json.loads(zlib.decompress(row["payload"]).decode("utf-8"))
            add_file(archive, path, encode_v2(payload, ""), row["updated_at"])
            listed.append(
                {
                    "file": path,
                    "id": row["id"],
                    "name": row["name"],
                    "stars": row["node_count"],
                    "revision": row["revision"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
            )
        manifest = {
            "format": EXPORT_FORMAT,
            "version": EXPORT_VERSION,
            "username": user["username"],
            "account_created_at": created_at,
            "exported_at": now,
            "maps": listed,
            "settings": settings,
        }
        add_file(archive, "manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False).encode(), now)
        date = time.strftime("%Y-%m-%d %H:%M", time.gmtime(now))
        add_file(archive, "README.txt", EXPORT_README.format(username=user["username"], date=date).encode(), now)

    buffer.seek(0)
    day = time.strftime("%Y-%m-%d", time.gmtime(now))
    return send_file(
        buffer,
        mimetype="application/zip",
        as_attachment=True,
        download_name=f"pleiades-{user['username']}-{day}.zip",
    )
