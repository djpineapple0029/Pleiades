"""The accounts database: one SQLite file holding users, sessions and maps.

Opened lazily, on the first request that needs it, so a server with accounts
switched off never creates it. Each use opens its own connection (cheap for
SQLite, and safe across Waitress's threads); writes that read-then-write take
`BEGIN IMMEDIATE` so two requests can't interleave between the check and the
change.

Migrations only ever move forward: MIGRATIONS[n] takes the schema from version
n to n+1, and a file newer than this build is refused rather than guessed at.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

FILENAME = "atlasmap.db"
BUSY_TIMEOUT_MS = 5000

MIGRATIONS: list[list[str]] = [
    [
        """CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_login_at INTEGER,
            disabled INTEGER NOT NULL DEFAULT 0,
            must_change_password INTEGER NOT NULL DEFAULT 0
        )""",
        """CREATE TABLE sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            user_agent TEXT NOT NULL DEFAULT ''
        )""",
        "CREATE INDEX sessions_user ON sessions(user_id)",
        """CREATE TABLE maps (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            payload BLOB NOT NULL,
            revision INTEGER NOT NULL,
            size_bytes INTEGER NOT NULL,
            node_count INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_opened_at INTEGER
        )""",
        "CREATE INDEX maps_user ON maps(user_id)",
        """CREATE TABLE snapshots (
            id INTEGER PRIMARY KEY,
            map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
            revision INTEGER NOT NULL,
            payload BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            reason TEXT NOT NULL
        )""",
        "CREATE INDEX snapshots_map ON snapshots(map_id)",
        """CREATE TABLE user_settings (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            json TEXT NOT NULL
        )""",
    ],
    # 2: history (server/history.py). A version's size and star count, so the
    # list doesn't have to unpack every payload to show them.
    [
        "ALTER TABLE snapshots ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE snapshots ADD COLUMN node_count INTEGER NOT NULL DEFAULT 0",
        "UPDATE snapshots SET size_bytes = length(payload)",
        "DROP INDEX snapshots_map",
        "CREATE INDEX snapshots_map ON snapshots(map_id, created_at)",
    ],
]


def now() -> int:
    """Unix seconds. Every timestamp in the database is one of these."""
    return int(time.time())


class Database:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._ready = False

    def _open(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
        return conn

    def ensure(self) -> None:
        """Create the file and bring its schema up to date, once per process."""
        if self._ready:
            return
        with self._lock:
            if self._ready:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if not self.path.exists():
                # Password hashes and readable maps: owner-only. SQLite gives
                # the -wal and -shm files the same mode as this one.
                os.close(os.open(self.path, os.O_CREAT | os.O_WRONLY, 0o600))
            conn = self._open()
            try:
                conn.execute("PRAGMA journal_mode = WAL")
                migrate(conn)
            finally:
                conn.close()
            self._ready = True

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        """A connection in autocommit mode; each statement is its own transaction."""
        self.ensure()
        conn = self._open()
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """A write transaction, taken up front so a check and its write can't be split."""
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                if conn.in_transaction:
                    conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")


def schema_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
    return int(row[0]) if row else 0


def migrate(conn: sqlite3.Connection) -> None:
    conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    while True:
        conn.execute("BEGIN IMMEDIATE")
        try:
            # Read inside the lock, in case another process migrated meanwhile.
            version = schema_version(conn)
            if version > len(MIGRATIONS):
                raise RuntimeError(
                    f"The accounts database is schema {version}, newer than this build knows "
                    f"({len(MIGRATIONS)}). Update the server rather than let it guess."
                )
            if version == len(MIGRATIONS):
                conn.execute("ROLLBACK")
                return
            for statement in MIGRATIONS[version]:
                conn.execute(statement)
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(version + 1),),
            )
        except BaseException:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")
