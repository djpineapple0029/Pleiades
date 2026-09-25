"""The /admin panel: the page itself and the JSON endpoints behind it.

Sign-in trades the password for a random bearer token held in server memory
(so a restart signs everyone out) and in the page's sessionStorage (so closing
the tab does too). A bearer header rather than a cookie means no CSRF surface
and no cookie scoped to the whole domain when this runs under a path prefix
behind Caddy.

Guessing is slowed three ways: scrypt makes each check cost ~60 ms, each
client address is locked out after `admin.lockout_attempts` wrong passwords,
and past GLOBAL_FAILURES_PER_MINUTE failures from everywhere at once, sign-in
refuses everyone for the rest of that minute.

Addresses outside `admin.allowed_networks` get a plain 404 for all of this.
"""

from __future__ import annotations

import ipaddress
import os
import platform
import re
import secrets
import threading
import time
from collections import deque
from functools import wraps
from pathlib import Path

from flask import Blueprint, Response, abort, current_app, jsonify, redirect, request, send_from_directory

from .config import SCHEMA, SETTINGS, ConfigStore, validate_setting

PAGE_DIR = Path(__file__).resolve().parent / "admin_page"
PAGE_FILES = {"admin.js", "admin.css"}
GLOBAL_FAILURES_PER_MINUTE = 30

admin = Blueprint("admin", __name__)

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    ),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}


def store() -> ConfigStore:
    return current_app.extensions["atlasmap_config"]


def guard() -> "Guard":
    return current_app.extensions["atlasmap_admin_guard"]


def client_ip() -> str:
    """The browser's address, trusting `admin.trusted_proxies` X-Forwarded-For hops."""
    hops = store().get("admin", "trusted_proxies")
    forwarded = request.headers.get("X-Forwarded-For", "")
    if hops and forwarded:
        chain = [part.strip() for part in forwarded.split(",") if part.strip()]
        if len(chain) >= hops:
            return chain[-hops]
    return request.remote_addr or "?"


def ip_allowed(address: str, networks: list[str]) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    # An IPv4 client seen through a dual-stack socket arrives as ::ffff:a.b.c.d.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return any(ip in ipaddress.ip_network(net) for net in networks)


class Guard:
    """Sessions and wrong-password lockouts, in memory."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.sessions: dict[str, float] = {}  # token -> expiry (monotonic)
        self.failures: dict[str, tuple[int, float]] = {}  # ip -> (count, locked until)
        self.recent_failures: deque[float] = deque()

    def locked_for(self, ip: str) -> float:
        """Seconds until this address may try again, 0 if it may now."""
        now = time.monotonic()
        with self.lock:
            while self.recent_failures and now - self.recent_failures[0] > 60:
                self.recent_failures.popleft()
            if len(self.recent_failures) >= GLOBAL_FAILURES_PER_MINUTE:
                return 60 - (now - self.recent_failures[0])
            _count, until = self.failures.get(ip, (0, 0.0))
            return max(0.0, until - now)

    def fail(self, ip: str, attempts: int, minutes: int) -> None:
        now = time.monotonic()
        with self.lock:
            self.recent_failures.append(now)
            count, _until = self.failures.get(ip, (0, 0.0))
            count += 1
            if count >= attempts:
                self.failures[ip] = (0, now + minutes * 60)
            else:
                self.failures[ip] = (count, 0.0)

    def succeed(self, ip: str) -> None:
        with self.lock:
            self.failures.pop(ip, None)

    def open_session(self, minutes: int) -> str:
        token = secrets.token_urlsafe(32)
        now = time.monotonic()
        with self.lock:
            self.sessions = {t: exp for t, exp in self.sessions.items() if exp > now}
            self.sessions[token] = now + minutes * 60
        return token

    def valid(self, token: str) -> bool:
        with self.lock:
            expiry = self.sessions.get(token)
            if expiry is None:
                return False
            if expiry <= time.monotonic():
                del self.sessions[token]
                return False
            return True

    def close_session(self, token: str) -> None:
        with self.lock:
            self.sessions.pop(token, None)

    def close_all(self) -> None:
        with self.lock:
            self.sessions.clear()


def fail(message: str, status: int, **extra) -> tuple[Response, int]:
    return jsonify(error=message, **extra), status


def bearer() -> str:
    header = request.headers.get("Authorization", "")
    return header[7:].strip() if header.startswith("Bearer ") else ""


def signed_in(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not guard().valid(bearer()):
            return fail("Signed out. Sign in again.", 401)
        return view(*args, **kwargs)

    return wrapper


@admin.before_request
def only_allowed_networks() -> None:
    if not ip_allowed(client_ip(), store().get("admin", "allowed_networks")):
        abort(404)


@admin.after_request
def harden(response: Response) -> Response:
    for name, value in SECURITY_HEADERS.items():
        response.headers[name] = value
    return response


# --- The page -----------------------------------------------------------------


@admin.get("/admin")
def page() -> Response:
    return send_from_directory(PAGE_DIR, "index.html")


@admin.get("/admin/")
def page_slash() -> Response:
    # Relative, so it still lands right under a path prefix (/pleiades/admin/).
    return redirect("../admin", code=308)


@admin.get("/admin/<name>")
def page_file(name: str) -> Response:
    if name not in PAGE_FILES:
        abort(404)
    return send_from_directory(PAGE_DIR, name)


# --- Sign-in ------------------------------------------------------------------


def password_attempt(password: object) -> tuple[Response, int] | None:
    """Checks a password with lockouts. None when right; an error response otherwise."""
    ip = client_ip()
    wait = guard().locked_for(ip)
    if wait > 0:
        response, status = fail(f"Too many wrong passwords. Try again in {int(wait // 60) + 1} min.", 429)
        response.headers["Retry-After"] = str(int(wait) + 1)
        return response, status
    if not isinstance(password, str) or not store().check_password(password):
        guard().fail(ip, store().get("admin", "lockout_attempts"), store().get("admin", "lockout_minutes"))
        return fail("Wrong password.", 401)
    guard().succeed(ip)
    return None


@admin.post("/api/admin/login")
def login() -> Response | tuple[Response, int]:
    body = request.get_json(silent=True) or {}
    refused = password_attempt(body.get("password"))
    if refused:
        return refused
    minutes = store().get("admin", "session_minutes")
    return jsonify(token=guard().open_session(minutes), minutes=minutes)


@admin.post("/api/admin/logout")
def logout() -> Response:
    guard().close_session(bearer())
    return jsonify(ok=True)


@admin.post("/api/admin/password")
@signed_in
def change_password() -> Response | tuple[Response, int]:
    body = request.get_json(silent=True) or {}
    current, new = body.get("current"), body.get("new")
    if not isinstance(new, str):
        return fail("`new` must be a string.", 400)
    refused = password_attempt(current)
    if refused:
        return refused
    error = store().set_password(current, new)
    if error:
        return fail(error, 400)
    # Every other signed-in tab was signed in with the old password.
    guard().close_all()
    minutes = store().get("admin", "session_minutes")
    return jsonify(ok=True, token=guard().open_session(minutes), minutes=minutes)


# --- Config -------------------------------------------------------------------


@admin.get("/api/admin/config")
@signed_in
def read_config() -> Response:
    config = store()
    return jsonify(
        schema=SCHEMA,
        values=config.all_values(),
        problems=config.problems,
        path=str(config.path),
        client_ip=client_ip(),
    )


@admin.put("/api/admin/config")
@signed_in
def write_config() -> Response | tuple[Response, int]:
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return fail("Expected a JSON object body.", 400)
    networks = body.get("admin", {}).get("allowed_networks")
    ip = client_ip()
    if networks is not None:
        clean, error = validate_setting(SETTINGS[("admin", "allowed_networks")], networks)
        if not error and not ip_allowed(ip, clean):
            return fail("Save refused.", 400, errors=[
                f"admin.allowed_networks: your own address ({ip}) isn't in it, so this would lock you out"
            ])
    errors = store().save(body)
    if errors:
        return fail("Save refused.", 400, errors=errors)
    return jsonify(ok=True, values=store().all_values())


# --- Status -------------------------------------------------------------------

ASSET_RE = re.compile(r'src="[^"]*?assets/([^"]+\.js)"')


def build_info() -> dict:
    index = Path(current_app.static_folder or "") / "index.html"
    if not index.is_file():
        return {"built": None, "bundle": None}
    match = ASSET_RE.search(index.read_text(encoding="utf-8", errors="replace"))
    return {"built": index.stat().st_mtime, "bundle": match.group(1) if match else None}


@admin.get("/api/admin/status")
@signed_in
def status() -> Response:
    config = store()
    return jsonify(
        requests=current_app.extensions["atlasmap_stats"].snapshot(),
        build=build_info(),
        server={
            "pid": os.getpid(),
            "python": platform.python_version(),
            "config_path": str(config.path),
            "problems": config.problems,
            "password_generated": config.initial_password is not None,
        },
    )
