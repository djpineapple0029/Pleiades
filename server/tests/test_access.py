"""Who may open a map, with which role and permissions (server/access.py)."""

import pytest

from server import access as accessmod
from server import db as dbmod


@pytest.fixture
def conn(tmp_path):
    database = dbmod.Database(tmp_path / "t.db")
    with database.transaction() as c:
        for uid, name in ((1, "owner"), (2, "ed"), (3, "vi"), (4, "stranger")):
            c.execute("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, 'x', 0)", (uid, name))
        c.execute(
            "INSERT INTO maps (id, user_id, name, payload, revision, size_bytes, node_count, created_at, updated_at) "
            "VALUES ('m' , 1, 'Map', x'', 1, 0, 0, 0, 0)"
        )
        c.execute("INSERT INTO map_members (map_id, user_id, role, added_at) VALUES ('m', 2, 'editor', 0)")
        c.execute("INSERT INTO map_members (map_id, user_id, role, added_at) VALUES ('m', 3, 'viewer', 0)")
    with database.connect() as c:
        yield c


def test_owner(conn):
    a = accessmod.resolve(conn, "m", user_id=1)
    assert a is not None and a.role == "owner" and a.perms["history"] is True


def test_editor_and_viewer(conn):
    editor = accessmod.resolve(conn, "m", user_id=2)
    viewer = accessmod.resolve(conn, "m", user_id=3)
    assert editor is not None and editor.role == "editor" and editor.can_edit
    assert viewer is not None and viewer.role == "viewer" and not viewer.can_edit


def test_stranger_and_missing_map_are_none(conn):
    assert accessmod.resolve(conn, "m", user_id=4) is None
    assert accessmod.resolve(conn, "nope", user_id=1) is None
    assert accessmod.resolve(conn, "m") is None


def test_role_defaults_and_overrides_apply(conn):
    conn.execute("INSERT INTO map_roles (map_id, role, perms_json) VALUES ('m', 'editor', '{\"history\": true}')")
    conn.execute("UPDATE map_members SET perms_json = '{\"export\": false}' WHERE user_id = 2")
    found = accessmod.resolve(conn, "m", user_id=2)
    assert found is not None
    assert found.perms["history"] is True and found.perms["export"] is False


def test_garbled_stored_perms_fall_back_to_defaults(conn):
    conn.execute("UPDATE map_members SET perms_json = 'not json' WHERE user_id = 2")
    found = accessmod.resolve(conn, "m", user_id=2)
    assert found is not None and found.perms["export"] is True


def test_sharing_switched_off_leaves_only_the_owner(conn):
    off = accessmod.Switches(sharing=False)
    assert accessmod.resolve(conn, "m", user_id=2, switches=off) is None
    owner = accessmod.resolve(conn, "m", user_id=1, switches=off)
    assert owner is not None and owner.role == "owner"
