"""Roles and permissions for shared maps (server/permissions.py)."""

from server.permissions import DEFAULTS, PERMS, can_grant, effective


def test_owner_has_everything():
    assert effective("owner", None, None) == dict.fromkeys(PERMS, True)


def test_role_defaults_match_the_spec_table():
    assert DEFAULTS["editor"] == {"balance": True, "export": True, "invite": True, "history": False, "chat": True}
    assert DEFAULTS["viewer"] == {"balance": False, "export": False, "invite": False, "history": False, "chat": False}


def test_map_role_defaults_then_person_override():
    perms = effective("editor", {"history": True}, {"export": False})
    assert perms["history"] is True and perms["export"] is False and perms["balance"] is True


def test_viewer_can_never_balance_even_if_granted():
    assert effective("viewer", {"balance": True}, {"balance": True})["balance"] is False


def test_viewer_chat_only_when_granted():
    assert effective("viewer", None, None)["chat"] is False
    assert effective("viewer", {"chat": True}, None)["chat"] is True


def test_unknown_perm_keys_are_ignored():
    assert "fly" not in effective("editor", {"fly": True}, None)


def test_granting_never_above_your_own_role():
    editor = effective("editor", None, None)
    viewer_with_invite = effective("viewer", {"invite": True}, None)
    assert can_grant("editor", editor, "editor")
    assert can_grant("editor", editor, "viewer")
    assert not can_grant("viewer", viewer_with_invite, "editor")
    assert can_grant("viewer", viewer_with_invite, "viewer")
    assert not can_grant("editor", {**editor, "invite": False}, "viewer")
    assert not can_grant("owner", effective("owner", None, None), "owner")
