"""Every test's app gets a throwaway config file and accounts database, never the real ones."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def isolated_config(tmp_path, monkeypatch):
    path = tmp_path / "atlasmap.toml"
    monkeypatch.setenv("ATLASMAP_CONFIG", str(path))
    monkeypatch.delenv("ATLASMAP_TRUSTED_PROXIES", raising=False)
    # The accounts database lands next to the config, in tmp_path too.
    monkeypatch.delenv("ATLASMAP_DATA", raising=False)
    monkeypatch.delenv("ATLASMAP_BASE", raising=False)
    return path


# --- Accounts -----------------------------------------------------------------

ACCOUNT_PASSWORD = "long enough pw"
CSRF = {"X-Atlas": "1"}


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
    config = app.extensions["atlasmap_config"]
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
