"""Every test's app gets a throwaway config file and accounts database, never the real ones."""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient


@pytest.fixture(autouse=True)
def isolated_config(tmp_path, monkeypatch):
    path = tmp_path / "pleiades.toml"
    # The pre-rename ATLASMAP_* names are read too (server/env.py): clear both.
    for prefix in ("PLEIADES_", "ATLASMAP_"):
        for name in ("CONFIG", "TRUSTED_PROXIES", "DATA", "BASE", "HOST", "PORT"):
            monkeypatch.delenv(prefix + name, raising=False)
    monkeypatch.setenv("PLEIADES_CONFIG", str(path))
    # The accounts database lands next to the config, in tmp_path too.
    return path


# --- Accounts -----------------------------------------------------------------

ACCOUNT_PASSWORD = "long enough pw"
CSRF = {"X-Pleiades": "1"}


@pytest.fixture
def fast_scrypt(monkeypatch):
    """Real scrypt at a cost that keeps dozens of sign-ins quick. Hashes record their N."""
    import importlib

    # By module path: `server.accounts` the attribute is the blueprint.
    accounts_module = importlib.import_module("server.accounts")
    config_module = importlib.import_module("server.config")
    monkeypatch.setattr(config_module, "SCRYPT_N", 2**10)
    monkeypatch.setattr(accounts_module, "_dummy_hash", [])


@pytest.fixture
def accounts_app(isolated_config, fast_scrypt):
    """An app with accounts on and sign-up open."""
    from server import create_app

    app = create_app()
    config = app.extensions["pleiades_config"]
    values = config.all_values()
    values["accounts"]["enabled"] = True
    values["accounts"]["signup_open"] = True
    assert config.save(values) == []
    return app


@pytest.fixture
def signup():
    """signup(client, name) -> signs that client up and in as `name`."""

    def run(client, name="alice", password=ACCOUNT_PASSWORD, **kwargs):
        response = client.post(
            "/api/auth/signup", json={"username": name, "password": password}, headers=CSRF, **kwargs
        )
        assert response.status_code == 201, response.json
        return response

    return run


# --- Rooms (async) ------------------------------------------------------------


@pytest.fixture
def anyio_backend():
    """`@pytest.mark.anyio` tests run on asyncio, the loop uvicorn uses."""
    return "asyncio"


# --- Shared maps (test_sharing.py, test_links.py, test_bans.py) ---------------


@pytest.fixture
def three(accounts_app, signup):
    """owner, eddie, vicky — each a signed-in test client; owner has one map."""
    clients = {}
    for name in ("owner", "eddie", "vicky"):
        client = accounts_app.test_client()
        signup(client, name)
        clients[name] = client
    created = clients["owner"].post("/api/maps", json={"name": "Galaxy"}, headers=CSRF)
    assert created.status_code == 201
    clients["map"] = created.json["id"]
    return clients


class FakeRooms:
    def __init__(self):
        self.events = []

    def notify(self, map_id, event):
        self.events.append((map_id, event))

    def people(self, map_id):
        return []


@pytest.fixture
def rooms(accounts_app):
    fake = FakeRooms()
    accounts_app.extensions["pleiades_rooms"] = fake
    return fake


# --- The ASGI app with accounts on (test_ws.py, test_bans.py) -----------------


@pytest.fixture
def asgi(isolated_config, fast_scrypt):
    from server.asgi import create_asgi

    app = create_asgi()
    config = app.state.flask.extensions["pleiades_config"]
    values = config.all_values()
    values["accounts"]["enabled"] = True
    values["accounts"]["signup_open"] = True
    config.save(values)
    return app


@pytest.fixture
def world(asgi):
    with TestClient(asgi, base_url="http://testserver") as client:
        yield client
