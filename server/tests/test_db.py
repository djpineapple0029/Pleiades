"""The accounts database (server/db.py): creation, migrations, pragmas."""

from __future__ import annotations

import sqlite3
import stat

import pytest

from server import create_app
from server.db import MIGRATIONS, Database, schema_version


@pytest.fixture
def database(tmp_path) -> Database:
    return Database(tmp_path / "data" / "pleiades.db")


def test_first_use_creates_the_schema_owner_only(database):
    assert not database.path.exists()
    with database.connect() as conn:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        assert schema_version(conn) == len(MIGRATIONS)
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert {"meta", "users", "sessions", "maps", "snapshots", "user_settings"} <= tables
    assert stat.S_IMODE(database.path.stat().st_mode) == 0o600


def test_migrations_run_once(database):
    database.ensure()
    # A second process opening the same file finds nothing to do.
    again = Database(database.path)
    with again.connect() as conn:
        assert schema_version(conn) == len(MIGRATIONS)
        assert conn.execute("SELECT COUNT(*) FROM meta").fetchone()[0] == 1


def test_a_newer_database_is_refused(database):
    database.ensure()
    with database.connect() as conn:
        conn.execute("UPDATE meta SET value = ? WHERE key = 'schema_version'", (str(len(MIGRATIONS) + 1),))
    with pytest.raises(RuntimeError, match="newer than this build"):
        Database(database.path).ensure()


def test_deleting_a_user_cascades(database):
    with database.transaction() as conn:
        conn.execute("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'a', 'x', 0)")
        conn.execute(
            "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('t', 1, 0, 1, 0)"
        )
        conn.execute(
            "INSERT INTO maps (id, user_id, name, payload, revision, size_bytes, node_count, created_at, updated_at) "
            "VALUES ('m', 1, 'n', x'00', 1, 1, 0, 0, 0)"
        )
        conn.execute(
            "INSERT INTO snapshots (map_id, revision, payload, created_at, reason) VALUES ('m', 1, x'00', 0, 'rolling')"
        )
    with database.connect() as conn:
        conn.execute("DELETE FROM users WHERE id = 1")
        for table in ("sessions", "maps", "snapshots"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0  # noqa: S608 -- fixed names


def test_a_failed_transaction_rolls_back(database):
    with pytest.raises(sqlite3.IntegrityError), database.transaction() as conn:
        conn.execute("INSERT INTO users (username, password_hash, created_at) VALUES ('a', 'x', 0)")
        conn.execute("INSERT INTO users (username, password_hash, created_at) VALUES ('a', 'x', 0)")
    with database.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0


def test_accounts_off_never_creates_the_file(isolated_config):
    app = create_app()
    client = app.test_client()
    assert client.get("/api/auth/me").json["enabled"] is False
    assert client.get("/api/maps").status_code == 404
    assert client.post("/api/auth/login", json={}, headers={"X-Pleiades": "1"}).status_code == 404
    assert not app.extensions["pleiades_db"].path.exists()
    assert app.extensions["pleiades_db"].path == isolated_config.parent / "pleiades.db"


def test_data_dir_follows_the_environment(isolated_config, tmp_path, monkeypatch):
    monkeypatch.setenv("PLEIADES_DATA", str(tmp_path / "elsewhere"))
    assert create_app().extensions["pleiades_db"].path == tmp_path / "elsewhere" / "pleiades.db"
