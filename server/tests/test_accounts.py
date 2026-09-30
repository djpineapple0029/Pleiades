"""Sign-up, sign-in, sessions and the gate in front of them (server/accounts.py)."""

from __future__ import annotations

import importlib
import threading

import pytest

import server.db
from server import create_app
from server.accounts import COOKIE, SESSION_SECONDS, TOUCH_SECONDS

ACCOUNT_PASSWORD = "long enough pw"  # conftest.py's signup fixture uses the same
CSRF = {"X-Atlas": "1"}


@pytest.fixture
def client(accounts_app):
    return accounts_app.test_client()


@pytest.fixture
def clock(monkeypatch):
    """Freezes server.db.now(); move it with clock['t'] += seconds."""
    state = {"t": 1_800_000_000}
    monkeypatch.setattr(server.db, "now", lambda: state["t"])
    return state


def login(client, name="alice", password=ACCOUNT_PASSWORD, **kwargs):
    return client.post("/api/auth/login", json={"username": name, "password": password}, headers=CSRF, **kwargs)


def session_cookie(response) -> str:
    return next(v for v in response.headers.getlist("Set-Cookie") if v.startswith(f"{COOKIE}="))


def whoami(client) -> str | None:
    user = client.get("/api/auth/me").json["user"]
    return user and user["username"]


def set_values(app, section, **values):
    config = app.extensions["atlasmap_config"]
    all_values = config.all_values()
    all_values[section].update(values)
    assert config.save(all_values) == []


# --- The gate -----------------------------------------------------------------


def test_off_by_default(isolated_config):
    client = create_app().test_client()
    assert client.get("/api/auth/me").json == {"enabled": False, "signup_open": False, "user": None}
    assert client.post("/api/auth/signup", json={}, headers=CSRF).status_code == 404
    assert client.get("/api/maps").status_code == 404


def test_the_classic_app_is_untouched_with_accounts_on(client):
    # No CSRF header, no cookie: the signed-out app's endpoints work as before.
    assert client.get("/api/config").status_code == 200
    assert "accounts" not in client.get("/api/config").json
    response = client.post("/api/save", json={"payload": {"nodes": []}})
    assert response.status_code == 200


def test_plain_http_from_the_network_works_but_says_so(client, signup):
    remote = {"REMOTE_ADDR": "192.168.1.20"}
    me = client.get("/api/auth/me", environ_base=remote).json
    assert me["enabled"] is True
    assert me["secure"] is False
    response = signup(client, "bob", environ_base=remote)
    # A browser drops a Secure cookie set over http://<LAN address>: no flag here.
    assert "Secure" not in session_cookie(response)
    assert client.get("/api/auth/me", environ_base=remote).json["user"]["username"] == "bob"
    logout = client.post("/api/auth/logout", headers=CSRF, environ_base=remote)
    assert "Secure" not in session_cookie(logout)


def test_secure_connections_keep_the_secure_cookie(client, signup):
    assert client.get("/api/auth/me").json["secure"] is True  # loopback
    assert "Secure" in session_cookie(signup(client, "alice"))
    remote = {"REMOTE_ADDR": "192.168.1.20"}
    https = signup(client, "bob", environ_base=remote, base_url="https://atlas.example")
    assert "Secure" in session_cookie(https)


def test_a_trusted_tls_proxy_counts_as_secure(accounts_app, client):
    set_values(accounts_app, "admin", trusted_proxies=1)
    remote = {"REMOTE_ADDR": "172.18.0.2"}
    assert client.get("/api/auth/me", environ_base=remote).json["secure"] is True


def test_state_changes_need_the_csrf_header(client, signup):
    response = client.post("/api/auth/signup", json={"username": "alice", "password": ACCOUNT_PASSWORD})
    assert response.status_code == 403
    signup(client)
    assert client.post("/api/maps", json={}).status_code == 403
    assert client.post("/api/auth/logout").status_code == 403
    assert client.get("/api/maps").status_code == 200


# --- Sign-up ------------------------------------------------------------------


def test_signup_signs_you_in(client, signup):
    response = signup(client, "Alice")
    assert response.json["user"]["username"] == "alice"
    assert whoami(client) == "alice"
    assert client.get("/api/auth/me").json["signup_open"] is True


def test_cookie_flags(client, signup):
    cookie = session_cookie(signup(client)).lower()
    for flag in ("httponly", "secure", "samesite=lax", "path=/;", f"max-age={SESSION_SECONDS}"):
        assert flag in cookie + ";"


def test_cookie_is_scoped_to_the_app_prefix(client, signup, monkeypatch):
    monkeypatch.setenv("ATLASMAP_BASE", "/pleiades/")
    assert "Path=/pleiades/" in session_cookie(signup(client))


def test_signup_closed(accounts_app, client):
    set_values(accounts_app, "accounts", signup_open=False)
    response = client.post("/api/auth/signup", json={"username": "alice", "password": ACCOUNT_PASSWORD}, headers=CSRF)
    assert response.status_code == 403
    assert client.get("/api/auth/me").json["signup_open"] is False


@pytest.mark.parametrize("name", ["ab", "a" * 33, "has space", "émile", "semi;colon", "", None, 5])
def test_bad_usernames(client, name):
    response = client.post("/api/auth/signup", json={"username": name, "password": ACCOUNT_PASSWORD}, headers=CSRF)
    assert response.status_code == 400


def test_usernames_are_case_insensitive_and_unique(client, signup):
    signup(client, "alice")
    other = client.application.test_client()
    response = other.post("/api/auth/signup", json={"username": "ALICE", "password": ACCOUNT_PASSWORD}, headers=CSRF)
    assert response.status_code == 409


def test_password_length(accounts_app, client):
    set_values(accounts_app, "accounts", min_password_length=12)
    short = client.post("/api/auth/signup", json={"username": "alice", "password": "a" * 11}, headers=CSRF)
    assert short.status_code == 400
    assert "12" in short.json["error"]
    huge = client.post("/api/auth/signup", json={"username": "alice", "password": "a" * 1025}, headers=CSRF)
    assert huge.status_code == 400


# --- Sign-in and out ----------------------------------------------------------


def test_login_and_logout(accounts_app, signup):
    signup(accounts_app.test_client())
    client = accounts_app.test_client()
    assert whoami(client) is None
    assert login(client, password="wrong password").status_code == 401
    assert login(client, "nobody").status_code == 401
    ok = login(client, " Alice ")
    assert ok.status_code == 200
    assert ok.json["user"] == {"username": "alice", "must_change_password": False}
    assert whoami(client) == "alice"

    token = client.get_cookie(COOKIE).value
    out = client.post("/api/auth/logout", headers=CSRF)
    assert out.status_code == 200
    assert client.get_cookie(COOKIE) is None
    # The token itself is dead, not just forgotten by this browser.
    client.set_cookie(COOKIE, token)
    assert whoami(client) is None


def test_wrong_and_unknown_names_answer_alike(accounts_app, signup):
    signup(accounts_app.test_client())
    client = accounts_app.test_client()
    assert login(client, password="wrong password").json == login(client, "nobody").json


def test_lockout_per_address(accounts_app, signup):
    signup(accounts_app.test_client())
    signup(accounts_app.test_client(), "bob")
    client = accounts_app.test_client()
    for _ in range(5):
        assert login(client, password="wrong password").status_code == 401
    locked = login(client, "bob")
    assert locked.status_code == 429
    assert int(locked.headers["Retry-After"]) > 0
    assert login(client, "bob", environ_base={"REMOTE_ADDR": "::1"}).status_code == 200


def test_lockout_per_username(accounts_app, signup):
    signup(accounts_app.test_client())
    client = accounts_app.test_client()
    for n in range(5):
        login(client, password="wrong password", environ_base={"REMOTE_ADDR": f"127.0.0.{n + 2}"})
    assert login(client, environ_base={"REMOTE_ADDR": "127.0.0.99"}).status_code == 429


def test_account_lockouts_leave_the_admin_alone(accounts_app, signup):
    client = accounts_app.test_client()
    config = accounts_app.extensions["atlasmap_config"]
    config.set_password(config.initial_password, "admin password")
    for _ in range(6):
        login(client, "nobody")
    assert client.post("/api/admin/login", json={"password": "admin password"}).status_code == 200


def test_disabled_accounts_are_signed_out_and_refused(accounts_app, client, signup):
    signup(client)
    with accounts_app.extensions["atlasmap_db"].connect() as conn:
        conn.execute("UPDATE users SET disabled = 1")
    assert whoami(client) is None
    assert client.get("/api/maps").status_code == 401
    assert login(accounts_app.test_client()).status_code == 401


def test_too_many_checks_at_once_is_busy(accounts_app, signup, monkeypatch):
    signup(accounts_app.test_client())
    # By module path: `server.accounts` the attribute is the blueprint.
    accounts_module = importlib.import_module("server.accounts")
    monkeypatch.setattr(accounts_module, "_checks", threading.BoundedSemaphore(1))
    accounts_module._checks.acquire()
    response = login(accounts_app.test_client())
    assert response.status_code == 503
    assert response.headers["Retry-After"] == "1"


# --- Session lifetime ---------------------------------------------------------


def test_sessions_slide_and_expire(accounts_app, clock, signup):
    client = accounts_app.test_client()
    signup(client)
    clock["t"] += TOUCH_SECONDS - 1
    quiet = client.get("/api/auth/me")
    assert quiet.json["user"] and COOKIE not in quiet.headers.get("Set-Cookie", "")

    clock["t"] += 1
    touched = client.get("/api/auth/me")
    assert f"Max-Age={SESSION_SECONDS}" in session_cookie(touched)

    # 30 days from that touch still counts; one second past doesn't.
    clock["t"] += SESSION_SECONDS - 1
    assert whoami(client) == "alice"
    clock["t"] += SESSION_SECONDS
    assert whoami(client) is None


def test_expired_sessions_are_swept_on_login(accounts_app, clock, signup):
    signup(accounts_app.test_client())
    clock["t"] += SESSION_SECONDS + 1
    login(accounts_app.test_client())
    with accounts_app.extensions["atlasmap_db"].connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1


def test_sessions_survive_a_restart(accounts_app, signup):
    client = accounts_app.test_client()
    signup(client)
    token = client.get_cookie(COOKIE).value
    restarted = create_app().test_client()
    restarted.set_cookie(COOKIE, token)
    assert whoami(restarted) == "alice"


# --- Landing ------------------------------------------------------------------


@pytest.fixture
def built(tmp_path, monkeypatch):
    """A stand-in frontend build, so `/` has pages to serve."""
    import server

    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<p>app</p>")
    (static / "home.html").write_text("<p>home</p>")
    monkeypatch.setattr(server, "STATIC_DIR", static)
    return static


def test_root_is_the_homepage_when_signed_out(client, built):
    response = client.get("/")
    assert response.status_code == 200
    assert response.data == b"<p>home</p>"
    assert response.headers["Cache-Control"] == "no-store"
    assert client.get("/", environ_base={"REMOTE_ADDR": "192.168.1.20"}).data == b"<p>home</p>"
    # A server map, and the app without an account, are the app itself.
    assert client.get("/?map=abcdefghijklmnop").data == b"<p>app</p>"
    assert client.get("/?local").data == b"<p>app</p>"


def test_root_goes_to_my_maps_when_signed_in(client, built, signup, monkeypatch):
    signup(client)
    response = client.get("/")
    assert response.status_code == 302
    assert response.headers["Location"] == "/account.html"
    assert response.headers["Cache-Control"] == "no-store"
    monkeypatch.setenv("ATLASMAP_BASE", "/pleiades/")
    assert client.get("/").headers["Location"] == "/pleiades/account.html"
    assert client.get("/?local").data == b"<p>app</p>"
    client.post("/api/auth/logout", headers=CSRF)
    assert client.get("/").data == b"<p>home</p>"


def test_root_ignores_a_dead_session(client, built):
    client.set_cookie(COOKIE, "not-a-real-token")
    assert client.get("/").data == b"<p>home</p>"


def test_root_is_the_homepage_when_accounts_are_off(accounts_app, client, built, signup):
    signup(client)
    set_values(accounts_app, "accounts", enabled=False)
    assert client.get("/").data == b"<p>home</p>"
    assert client.get("/?local").data == b"<p>app</p>"


def test_root_without_a_build_says_how_to_make_one(client, tmp_path, monkeypatch):
    import server

    monkeypatch.setattr(server, "STATIC_DIR", tmp_path)
    assert client.get("/").status_code == 503
    assert client.get("/?local").status_code == 503


def test_me_reports_the_password_minimum(client):
    assert client.get("/api/auth/me").json["min_password_length"] == 10
