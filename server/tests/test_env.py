"""The pre-rename names (AtlasMap → Pleiades) still work: env vars, config file, database."""

from __future__ import annotations

from server import create_app
from server.env import env, legacy


def test_new_name_wins_then_old_then_default(monkeypatch):
    assert env("PORT", "5001") == "5001"
    monkeypatch.setenv("ATLASMAP_PORT", "6000")
    assert env("PORT", "5001") == "6000"
    monkeypatch.setenv("PLEIADES_PORT", "7000")
    assert env("PORT", "5001") == "7000"


def test_legacy_file_only_when_the_new_one_is_missing(tmp_path):
    new = tmp_path / "pleiades.toml"
    assert legacy(new) == new
    (tmp_path / "atlasmap.toml").write_text("")
    assert legacy(new) == tmp_path / "atlasmap.toml"
    new.write_text("")
    assert legacy(new) == new


def test_other_names_are_left_alone(tmp_path):
    (tmp_path / "atlasmap.toml").write_text("")
    assert legacy(tmp_path / "custom.toml") == tmp_path / "custom.toml"


def test_an_existing_deployment_keeps_its_config_and_database(isolated_config, monkeypatch):
    old_config = isolated_config.with_name("atlasmap.toml")
    old_db = isolated_config.with_name("atlasmap.db")
    old_config.write_text('[server]\nmax_upload_mb = 7\n\n[admin]\npassword_hash = "x"\n')
    old_db.write_bytes(b"")
    monkeypatch.delenv("PLEIADES_CONFIG")
    monkeypatch.setenv("ATLASMAP_CONFIG", str(isolated_config))
    app = create_app()
    assert app.extensions["pleiades_config"].path == old_config
    assert app.extensions["pleiades_config"].get("server", "max_upload_mb") == 7
    assert app.extensions["pleiades_db"].path == old_db


def test_the_old_csrf_header_is_still_accepted(accounts_app, signup):
    client = accounts_app.test_client()
    signup(client)
    assert client.post("/api/auth/logout").status_code == 403
    assert client.post("/api/auth/logout", headers={"X-Atlas": "1"}).status_code < 400
