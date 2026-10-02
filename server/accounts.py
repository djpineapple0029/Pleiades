"""Accounts: sign-up, sign-in and the session cookie (context: USERS.md).

Everything here is off unless `accounts.enabled` is on: every route 404s,
except `/api/auth/me`, which says accounts are off. Plain HTTP from the
network is allowed (a LAN at home), but `/api/auth/me` reports it as not
secure so the shell warns before anyone types a password, and the cookie only
carries `Secure` where a browser would keep it: HTTPS, a TLS proxy counted in
`admin.trusted_proxies`, or loopback (browsers treat localhost as secure).

A session is a random token in an HttpOnly cookie; the database keeps only its
SHA-256. Unlike /admin's bearer token this lives 30 days, so it belongs out of
JS-readable storage. The cost of a cookie is CSRF: every state-changing request
must carry `X-Pleiades: 1`, which a cross-site form can't send, and SameSite=Lax
covers the rest.

Wrong passwords are slowed like /admin's: scrypt, lockouts per client address
and per username (a guard of its own, so users can't lock the admin out), and
a cap on how many scrypt checks run at once.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
import secrets
import sqlite3
import threading
from collections.abc import Callable
from functools import wraps

from flask import Blueprint, Response, abort, current_app, g, jsonify, request

from . import db as dbmod
from .admin import Guard, client_ip
from .config import ConfigStore, hash_password, verify_password
from .db import Database
from .env import env

accounts = Blueprint("accounts", __name__, url_prefix="/api")

COOKIE = "atlas_session"
SESSION_SECONDS = 30 * 24 * 3600
# Sliding expiry is written back at most this often, not on every request.
TOUCH_SECONDS = 3600
USERNAME_RE = re.compile(r"[a-z0-9_.-]{3,32}")
MAX_PASSWORD_LENGTH = 1024
MAX_USER_AGENT = 200
CSRF_HEADER = "X-Pleiades"
# Its pre-rename name, still accepted so a tab opened before the rename can save.
LEGACY_CSRF_HEADER = "X-Atlas"
# Concurrent scrypt checks (each ~60 ms and 32 MB); past this, try again shortly.
MAX_CONCURRENT_CHECKS = 4
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

_checks = threading.BoundedSemaphore(MAX_CONCURRENT_CHECKS)
_dummy_hash: list[str] = []
_dummy_lock = threading.Lock()


def store() -> ConfigStore:
    return current_app.extensions["pleiades_config"]


def database() -> Database:
    return current_app.extensions["pleiades_db"]


def guard() -> Guard:
    return current_app.extensions["pleiades_account_guard"]


def fail(message: str, status: int, **extra: object) -> tuple[Response, int]:
    return jsonify(error=message, **extra), status


def dummy_hash() -> str:
    """A hash to check against when the username doesn't exist, so timing doesn't tell."""
    with _dummy_lock:
        if not _dummy_hash:
            _dummy_hash.append(hash_password(secrets.token_urlsafe(16)))
        return _dummy_hash[0]


# --- The gate -----------------------------------------------------------------


def secure_enough() -> bool:
    if request.is_secure or store().get("admin", "trusted_proxies") > 0:
        return True
    try:
        return ipaddress.ip_address(request.remote_addr or "").is_loopback
    except ValueError:
        return False


def available() -> bool:
    return bool(store().get("accounts", "enabled"))


def session_user() -> sqlite3.Row | None:
    """The signed-in user, for requests outside these blueprints (`/`,
    `/api/config`). Read-only: it neither slides nor re-issues the session,
    since only this blueprint's after_request can send the cookie back."""
    if not available():
        return None
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    with database().connect() as conn:
        return session_row(conn, token_hash(token), dbmod.now())


def account_shell_url() -> str | None:
    """Where plain `/` should go instead of the homepage: My maps, for someone
    already signed in here."""
    if session_user() is None:
        return None
    return f"{cookie_path()}account.html"


def gate() -> tuple[Response, int] | None:
    """before_request for every accounts route: off → 404; state changes need the CSRF header."""
    if request.endpoint == "accounts.me":
        return None
    if not available():
        abort(404)
    csrf = (request.headers.get(CSRF_HEADER), request.headers.get(LEGACY_CSRF_HEADER))
    if request.method not in SAFE_METHODS and "1" not in csrf:
        return fail(f"Missing the {CSRF_HEADER} header.", 403)
    return None


def finish(response: Response) -> Response:
    """after_request: keep account data out of caches; re-issue a slid session cookie."""
    response.headers["Cache-Control"] = "no-store"
    token = g.pop("reissue_token", None)
    if token:
        set_cookie(response, token)
    return response


accounts.before_request(gate)
accounts.after_request(finish)


# --- Sessions -----------------------------------------------------------------


def cookie_path() -> str:
    base = env("BASE")
    return base if base.startswith("/") else "/"


def set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE,
        token,
        max_age=SESSION_SECONDS,
        path=cookie_path(),
        secure=secure_enough(),
        httponly=True,
        samesite="Lax",
    )


def clear_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE, path=cookie_path(), secure=secure_enough(), httponly=True, samesite="Lax")


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def open_session(conn: sqlite3.Connection, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    now = dbmod.now()
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (token_hash(token), user_id, now, now + SESSION_SECONDS, now, request.user_agent.string[:MAX_USER_AGENT]),
    )
    return token


def session_row(conn: sqlite3.Connection, digest: str, now: int) -> sqlite3.Row | None:
    """The live session with this token hash, joined to its (enabled) user."""
    return conn.execute(
        "SELECT users.id, users.username, users.must_change_password, sessions.last_seen_at "
        "FROM sessions JOIN users ON users.id = sessions.user_id "
        "WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.disabled = 0",
        (digest, now),
    ).fetchone()


def current_user() -> sqlite3.Row | None:
    """The signed-in user for this request, or None. Slides the session's expiry."""
    if "user" in g:
        return g.user
    g.user = None
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    now = dbmod.now()
    digest = token_hash(token)
    with database().connect() as conn:
        row = session_row(conn, digest, now)
        if row is None:
            return None
        if now - row["last_seen_at"] >= TOUCH_SECONDS:
            conn.execute(
                "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
                (now, now + SESSION_SECONDS, digest),
            )
            g.reissue_token = token
    g.user = row
    return row


def signed_in(view: Callable) -> Callable:
    """Needs a session. After an admin reset (`must_change_password`), only
    views marked `even_after_reset` answer until a new password is chosen."""

    @wraps(view)
    def wrapper(*args: object, **kwargs: object) -> object:
        user = current_user()
        if user is None:
            return fail("Signed out. Sign in again.", 401)
        if user["must_change_password"] and not getattr(view, "even_after_reset", False):
            return fail("Choose a new password first.", 403, must_change_password=True)
        return view(*args, **kwargs)

    return wrapper


def even_after_reset(view: Callable) -> Callable:
    """Put under @signed_in: the view still answers while the password must change."""
    view.even_after_reset = True  # type: ignore[attr-defined]
    return view


def json_body() -> dict:
    body = request.get_json(silent=True)
    return body if isinstance(body, dict) else {}


def signed_in_response(token: str, username: str, status: int = 200) -> tuple[Response, int]:
    response = jsonify(user={"username": username, "must_change_password": False})
    set_cookie(response, token)
    return response, status


def busy() -> tuple[Response, int]:
    response, status = fail("The server is busy. Try again in a moment.", 503)
    response.headers["Retry-After"] = "1"
    return response, status


def new_password_problem(password: object) -> str | None:
    """Why this can't be a new account password, or None when it can."""
    shortest = store().get("accounts", "min_password_length")
    if not isinstance(password, str) or len(password) < shortest:
        return f"Passwords need at least {shortest} characters."
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"Passwords can be at most {MAX_PASSWORD_LENGTH} characters."
    return None


def hash_or_none(password: str) -> str | None:
    """scrypt within the concurrency cap; None when the cap is full (answer busy())."""
    if not _checks.acquire(blocking=False):
        return None
    try:
        return hash_password(password)
    finally:
        _checks.release()


def check_or_none(password: str, stored: str) -> bool | None:
    """verify_password within the concurrency cap; None when the cap is full."""
    if not _checks.acquire(blocking=False):
        return None
    try:
        return verify_password(password, stored)
    finally:
        _checks.release()


def locked_out(*keys: str) -> tuple[Response, int] | None:
    """A 429 while any of these guard keys is locked out."""
    wait = max(guard().locked_for(key) for key in keys)
    if wait <= 0:
        return None
    response, status = fail(f"Too many wrong passwords. Try again in {int(wait // 60) + 1} min.", 429)
    response.headers["Retry-After"] = str(int(wait) + 1)
    return response, status


def record_wrong_password(ip_key: str, user_key: str | None) -> None:
    attempts, minutes = store().get("admin", "lockout_attempts"), store().get("admin", "lockout_minutes")
    guard().fail(ip_key, attempts, minutes)
    if user_key:
        # Only real usernames get a counter, so made-up ones can't grow the table.
        guard().fail(user_key, attempts, minutes, count_globally=False)


# --- Routes -------------------------------------------------------------------


@accounts.get("/auth/me")
def me() -> Response:
    if not available():
        return jsonify(enabled=False, signup_open=False, user=None)
    user = current_user()
    return jsonify(
        enabled=True,
        secure=secure_enough(),
        signup_open=bool(store().get("accounts", "signup_open")),
        min_password_length=store().get("accounts", "min_password_length"),
        user=(
            {
                "id": user["id"],
                "username": user["username"],
                "must_change_password": bool(user["must_change_password"]),
            }
            if user
            else None
        ),
    )


@accounts.post("/auth/signup")
def signup() -> Response | tuple[Response, int]:
    if not store().get("accounts", "signup_open"):
        return fail("Sign-up is closed on this server.", 403)
    body = json_body()
    username, password = body.get("username"), body.get("password")
    if not isinstance(username, str) or not USERNAME_RE.fullmatch(username.strip().lower()):
        return fail("Usernames are 3–32 characters: letters, digits, _ . and -.", 400)
    username = username.strip().lower()
    refused = new_password_problem(password)
    if refused:
        return fail(refused, 400)

    password_hash = hash_or_none(password)
    if password_hash is None:
        return busy()

    try:
        with database().transaction() as conn:
            now = dbmod.now()
            cursor = conn.execute(
                "INSERT INTO users (username, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?)",
                (username, password_hash, now, now),
            )
            user_id = cursor.lastrowid
            assert user_id is not None  # noqa: S101 -- type narrowing only
            token = open_session(conn, user_id)
    except sqlite3.IntegrityError:
        return fail("That username is taken.", 409)
    return signed_in_response(token, username, 201)


@accounts.post("/auth/login")
def login() -> Response | tuple[Response, int]:
    body = json_body()
    username, password = body.get("username"), body.get("password")
    if not isinstance(username, str) or not isinstance(password, str) or len(password) > MAX_PASSWORD_LENGTH:
        return fail("Wrong username or password.", 401)
    username = username.strip().lower()
    ip_key, user_key = f"ip:{client_ip()}", f"user:{username}"
    refused = locked_out(ip_key, user_key)
    if refused:
        return refused

    with database().connect() as conn:
        user = conn.execute(
            "SELECT id, username, password_hash, disabled, must_change_password FROM users WHERE username = ?",
            (username,),
        ).fetchone()

    matches = check_or_none(password, user["password_hash"] if user else dummy_hash())
    if matches is None:
        return busy()

    if not matches or user["disabled"]:
        record_wrong_password(ip_key, user_key if user else None)
        return fail("Wrong username or password.", 401)
    guard().succeed(ip_key)
    guard().succeed(user_key)

    with database().transaction() as conn:
        now = dbmod.now()
        conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
        conn.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now, user["id"]))
        token = open_session(conn, user["id"])
    response = jsonify(user={"username": user["username"], "must_change_password": bool(user["must_change_password"])})
    set_cookie(response, token)
    return response


@accounts.post("/auth/logout")
def logout() -> Response:
    token = request.cookies.get(COOKIE)
    if token:
        with database().connect() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
    g.pop("reissue_token", None)
    response = jsonify(ok=True)
    clear_cookie(response)
    return response
