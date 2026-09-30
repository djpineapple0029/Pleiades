"""A map's history (USERS.md, "Snapshots"): earlier versions kept beside it.

A snapshot is a full copy of a payload as stored (zlib JSON), never a delta;
maps are small enough that copies are the simple, safe choice. They're taken:

- `rolling`: when a save lands and the newest snapshot is more than an hour
  old (or there is none), the payload being replaced is kept first. So a map
  edited all afternoon keeps roughly one version per hour.
- `before-restore`: the current version, just before a restore replaces it,
  so a restore can itself be undone.
- `unsaved-edits`: edits a tab never got to save, sent by the conflict panel's
  "load theirs" before it drops them.

Pruning runs whenever one is added: everything from the last hour stays (so a
restore or dropped edits are still there to undo), then the newest per hour
for a day, the newest per day for 30 days, and always the newest of all.

Everything here runs inside the caller's transaction and trusts that the
caller has already checked the map belongs to the signed-in user.
"""

from __future__ import annotations

import sqlite3

HOUR = 3600
DAY = 24 * HOUR
ROLLING_EVERY = HOUR
KEEP_ALL_FOR = HOUR
# Only restores and kept edits land inside an hour; this caps a runaway client.
MAX_RECENT = 20
HOURLY_FOR = DAY
DAILY_FOR = 30 * DAY

REASONS = ("rolling", "before-restore", "unsaved-edits", "before-upload-replace")


def to_keep(snapshots: list[tuple[int, int]], now: int) -> set[int]:
    """Which of these `(id, created_at)` snapshots pruning leaves in place."""
    ordered = sorted(snapshots, key=lambda s: (s[1], s[0]), reverse=True)
    keep: set[int] = set()
    buckets: set[tuple[str, int]] = set()
    recent = 0
    for snapshot_id, created_at in ordered:
        age = now - created_at
        if age < KEEP_ALL_FOR:
            if recent < MAX_RECENT:
                keep.add(snapshot_id)
                recent += 1
            continue
        if age < HOURLY_FOR:
            bucket = ("hour", created_at // HOUR)
        elif age < DAILY_FOR:
            bucket = ("day", created_at // DAY)
        else:
            continue
        # Newest first, so the first one seen in a bucket is its newest.
        if bucket not in buckets:
            buckets.add(bucket)
            keep.add(snapshot_id)
    if ordered:
        keep.add(ordered[0][0])
    return keep


def prune(conn: sqlite3.Connection, map_id: str, now: int) -> None:
    rows = conn.execute("SELECT id, created_at FROM snapshots WHERE map_id = ?", (map_id,)).fetchall()
    keep = to_keep([(row["id"], row["created_at"]) for row in rows], now)
    drop = [(row["id"],) for row in rows if row["id"] not in keep]
    if drop:
        conn.executemany("DELETE FROM snapshots WHERE id = ?", drop)


def add(
    conn: sqlite3.Connection,
    map_id: str,
    *,
    revision: int,
    payload: bytes,
    node_count: int,
    reason: str,
    now: int,
) -> int:
    """Keeps `payload` as a snapshot of the map, prunes, and returns the new id."""
    assert reason in REASONS  # noqa: S101 -- a typo here would be a bug, not input
    cursor = conn.execute(
        "INSERT INTO snapshots (map_id, revision, payload, created_at, reason, size_bytes, node_count) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (map_id, revision, payload, now, reason, len(payload), node_count),
    )
    snapshot_id = cursor.lastrowid
    assert snapshot_id is not None  # noqa: S101 -- an INSERT always has one
    prune(conn, map_id, now)
    return snapshot_id


def rolling_due(conn: sqlite3.Connection, map_id: str, now: int) -> bool:
    """Whether a save landing now should keep the version it replaces."""
    (newest,) = conn.execute("SELECT MAX(created_at) FROM snapshots WHERE map_id = ?", (map_id,)).fetchone()
    return newest is None or now - newest >= ROLLING_EVERY


def listing(conn: sqlite3.Connection, map_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT id, revision, created_at, reason, size_bytes, node_count FROM snapshots "
        "WHERE map_id = ? ORDER BY created_at DESC, id DESC",
        (map_id,),
    ).fetchall()
    return [dict(row) for row in rows]
