"""A map's history (server/history.py, the snapshot routes in server/maps.py)."""

from __future__ import annotations

import importlib
import sqlite3

import pytest

from server import history
from server.db import Database, migrate, schema_version
from server.history import DAY, HOUR, MAX_RECENT, to_keep

CSRF = {"X-Pleiades": "1"}
START = 1_800_000_000


def payload(*labels):
    return {"format": "atlasmap", "schema": 1, "nodes": [{"id": f"n{i}", "label": x} for i, x in enumerate(labels)]}


@pytest.fixture
def clock(monkeypatch):
    """The database's clock, moved by hand: `clock.at += HOUR`."""
    db_module = importlib.import_module("server.db")

    class Clock:
        at = START

    monkeypatch.setattr(db_module, "now", lambda: Clock.at)
    return Clock


@pytest.fixture
def alice(accounts_app, signup, clock):
    client = accounts_app.test_client()
    signup(client, "alice")
    return client


@pytest.fixture
def bob(accounts_app, signup, clock):
    client = accounts_app.test_client()
    signup(client, "bob")
    return client


def create(client, body=None):
    response = client.post("/api/maps", json={"name": "Vega", "payload": body or payload()}, headers=CSRF)
    assert response.status_code == 201, response.json
    return response.json["id"]


def save(client, map_id, revision, body):
    response = client.put(f"/api/maps/{map_id}", json={"payload": body}, headers={**CSRF, "If-Match": str(revision)})
    assert response.status_code == 200, response.json
    return response.json["revision"]


def versions(client, map_id):
    response = client.get(f"/api/maps/{map_id}/snapshots")
    assert response.status_code == 200, response.json
    return response.json["snapshots"]


def restore(client, map_id, snapshot_id):
    return client.post(f"/api/maps/{map_id}/snapshots/{snapshot_id}/restore", headers=CSRF)


# --- Pruning, as a rule --------------------------------------------------------


def test_the_last_hour_is_all_kept():
    snaps = [(i, START - i * 60) for i in range(10)]
    assert to_keep(snaps, START) == set(range(10))


def test_the_last_hour_is_capped():
    snaps = [(i, START - i) for i in range(MAX_RECENT + 5)]
    assert to_keep(snaps, START) == set(range(MAX_RECENT))


def test_then_the_newest_per_hour_for_a_day_and_per_day_for_a_month():
    now = (START // DAY) * DAY + 12 * HOUR
    # One every 10 minutes for 40 days, oldest first.
    snaps = [(i, now - 40 * DAY + i * 600) for i in range(40 * DAY // 600)]
    keep = to_keep(snaps, now)
    kept = sorted(at for i, at in snaps if i in keep)
    ages = [now - at for at in kept]
    assert max(ages) < 30 * DAY
    older_than_a_day = [at for at in kept if now - at >= DAY]
    assert len({at // DAY for at in older_than_a_day}) == len(older_than_a_day)
    within_a_day = [at for at in kept if HOUR <= now - at < DAY]
    assert len({at // HOUR for at in within_a_day}) == len(within_a_day)
    # About 6 from the last hour, one per hour after, one per day after that.
    assert 6 + 22 + 28 <= len(kept) <= 6 + 24 + 31
    # Stable: pruning what's left again drops nothing.
    assert to_keep([(i, at) for i, at in snaps if i in keep], now) == keep


def test_the_newest_is_always_kept():
    assert to_keep([(1, START - 90 * DAY), (2, START - 60 * DAY)], START) == {2}
    assert to_keep([], START) == set()


# --- Rolling snapshots ---------------------------------------------------------


def test_a_save_keeps_what_it_replaces_at_most_hourly(alice, clock):
    map_id = create(alice, payload("first"))
    assert versions(alice, map_id) == []

    # The first save keeps revision 1.
    clock.at += 60
    rev = save(alice, map_id, 1, payload("second"))
    [first] = versions(alice, map_id)
    assert (first["revision"], first["reason"], first["node_count"]) == (1, "rolling", 1)
    assert first["size_bytes"] > 0
    assert first["created_at"] == clock.at

    # More saves within the hour keep nothing more.
    for step in range(5):
        clock.at += 600
        rev = save(alice, map_id, rev, payload("second", str(step)))
    assert len(versions(alice, map_id)) == 1

    # An hour after the last one, the next save keeps the revision it replaces.
    clock.at = first["created_at"] + HOUR
    save(alice, map_id, rev, payload("third"))
    newest = versions(alice, map_id)[0]
    assert (newest["revision"], newest["reason"], newest["node_count"]) == (rev, "rolling", 2)


def test_a_refused_save_keeps_nothing(alice, clock):
    map_id = create(alice)
    stale = alice.put(f"/api/maps/{map_id}", json={"payload": payload("x")}, headers={**CSRF, "If-Match": "7"})
    assert stale.status_code == 409
    assert stale.json["revision"] == 1
    assert versions(alice, map_id) == []


def test_a_day_of_hourly_saves_prunes_as_it_goes(alice, clock):
    map_id = create(alice)
    rev = 1
    for hour in range(60):
        clock.at = START + hour * HOUR
        rev = save(alice, map_id, rev, payload(str(hour)))
    kept = versions(alice, map_id)
    assert len(kept) == len({s["id"] for s in kept})
    # 24 hourly and a couple of days' worth, not 60.
    assert 24 <= len(kept) <= 24 + 3
    assert kept[0]["revision"] == rev - 1


# --- Restore -------------------------------------------------------------------


def test_restore_makes_a_new_revision_and_can_be_undone(alice, clock):
    map_id = create(alice, payload("old"))
    clock.at += 60
    save(alice, map_id, 1, payload("new", "er"))
    [old] = versions(alice, map_id)

    clock.at += 60
    restored = restore(alice, map_id, old["id"])
    assert restored.status_code == 200
    assert restored.json == {"revision": 3, "updated_at": clock.at}
    current = alice.get(f"/api/maps/{map_id}").json
    assert current["revision"] == 3
    assert current["payload"] == payload("old")
    [listed] = alice.get("/api/maps").json["maps"]
    assert listed["node_count"] == 1

    # What it replaced was kept first.
    before = versions(alice, map_id)[0]
    assert (before["reason"], before["revision"], before["node_count"]) == ("before-restore", 2, 2)

    # A tab still on revision 2 finds out at its next save.
    stale = alice.put(f"/api/maps/{map_id}", json={"payload": payload()}, headers={**CSRF, "If-Match": "2"})
    assert stale.status_code == 409

    # And the restore itself can be undone.
    assert restore(alice, map_id, before["id"]).json["revision"] == 4
    assert alice.get(f"/api/maps/{map_id}").json["payload"] == payload("new", "er")


def test_restore_only_reaches_this_maps_snapshots(alice, bob, clock):
    mine = create(alice)
    other = create(alice)
    theirs = create(bob)
    for client, map_id in ((alice, mine), (alice, other), (bob, theirs)):
        clock.at += 1
        save(client, map_id, 1, payload("x"))
    [other_snap] = versions(alice, other)
    [bob_snap] = versions(bob, theirs)

    assert restore(alice, mine, other_snap["id"]).status_code == 404
    assert restore(alice, theirs, bob_snap["id"]).status_code == 404
    assert restore(alice, mine, 999_999).status_code == 404
    assert alice.get(f"/api/maps/{theirs}/snapshots").status_code == 404
    assert alice.get("/api/maps/not-an-id/snapshots").status_code == 404
    # Nothing moved.
    assert bob.get(f"/api/maps/{theirs}").json["revision"] == 2
    assert alice.get(f"/api/maps/{mine}").json["revision"] == 2


def test_history_needs_the_csrf_header_and_a_session(alice, accounts_app, clock):
    map_id = create(alice)
    clock.at += 1
    save(alice, map_id, 1, payload("x"))
    [snap] = versions(alice, map_id)
    assert alice.post(f"/api/maps/{map_id}/snapshots/{snap['id']}/restore").status_code == 403
    assert alice.post(f"/api/maps/{map_id}/snapshots", json={"payload": payload()}).status_code == 403
    stranger = accounts_app.test_client()
    assert stranger.get(f"/api/maps/{map_id}/snapshots").status_code == 401
    assert restore(stranger, map_id, snap["id"]).status_code == 401


# --- Unsaved edits kept on "load theirs" ---------------------------------------


def test_edits_a_tab_drops_are_kept(alice, clock):
    map_id = create(alice)
    clock.at += 60
    save(alice, map_id, 1, payload("theirs"))

    kept = alice.post(
        f"/api/maps/{map_id}/snapshots", json={"payload": payload("mine", "too"), "revision": 1}, headers=CSRF
    )
    assert kept.status_code == 201
    newest = versions(alice, map_id)[0]
    assert newest["id"] == kept.json["id"]
    assert (newest["reason"], newest["revision"], newest["node_count"]) == ("unsaved-edits", 1, 2)
    # Keeping them changes nothing about the map itself.
    assert alice.get(f"/api/maps/{map_id}").json["revision"] == 2

    # Restoring them is an ordinary restore.
    assert restore(alice, map_id, newest["id"]).status_code == 200
    assert alice.get(f"/api/maps/{map_id}").json["payload"] == payload("mine", "too")


@pytest.mark.parametrize("revision", [None, 0, 99, "1", True])
def test_an_odd_base_revision_means_the_current_one(alice, revision):
    map_id = create(alice)
    body = {"payload": payload()} if revision is None else {"payload": payload(), "revision": revision}
    assert alice.post(f"/api/maps/{map_id}/snapshots", json=body, headers=CSRF).status_code == 201
    assert versions(alice, map_id)[0]["revision"] == 1


def test_kept_edits_must_be_a_payload(alice, bob):
    map_id = create(alice)
    url = f"/api/maps/{map_id}/snapshots"
    assert alice.post(url, json={"payload": [1]}, headers=CSRF).status_code == 400
    assert alice.post(url, json={"payload": {"x": float("nan")}}, headers=CSRF).status_code == 400
    assert bob.post(url, json={"payload": payload()}, headers=CSRF).status_code == 404
    assert versions(alice, map_id) == []


def test_deleting_a_map_deletes_its_history(alice, accounts_app, clock):
    map_id = create(alice)
    clock.at += 1
    save(alice, map_id, 1, payload("x"))
    assert alice.delete(f"/api/maps/{map_id}", headers=CSRF).status_code == 200
    with accounts_app.extensions["pleiades_db"].connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0] == 0


# --- Migration -----------------------------------------------------------------


def test_migration_2_adds_sizes_to_existing_snapshots(tmp_path, monkeypatch):
    db_module = importlib.import_module("server.db")
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path, isolation_level=None)
    # A database written by the build before history: schema 1, a snapshot row.
    with monkeypatch.context() as patch:
        patch.setattr(db_module, "MIGRATIONS", db_module.MIGRATIONS[:1])
        migrate(conn)
    assert schema_version(conn) == 1
    conn.execute("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'a', 'x', 0)")
    conn.execute(
        "INSERT INTO maps (id, user_id, name, payload, revision, size_bytes, node_count, created_at, updated_at) "
        "VALUES ('m', 1, 'n', x'00', 1, 1, 0, 0, 0)"
    )
    conn.execute(
        "INSERT INTO snapshots (map_id, revision, payload, created_at, reason) VALUES ('m', 1, x'0102', 0, 'rolling')"
    )
    conn.close()

    database = Database(path)
    with database.connect() as conn:
        assert schema_version(conn) >= 2  # and on through any later migration
        [row] = history.listing(conn, "m")
    assert (row["size_bytes"], row["node_count"]) == (2, 0)
