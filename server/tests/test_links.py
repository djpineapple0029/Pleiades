"""Share links (server/sharing.py, /s/<token>) and guest names (server/guests.py)."""

from __future__ import annotations

import pytest

from server.guests import clean_guest_name

CSRF = {"X-Pleiades": "1"}  # `three` and `rooms` are conftest.py fixtures


def share(clients, who, role, by="owner"):
    return clients[by].post(f"/api/maps/{clients['map']}/members", json={"username": who, "role": role}, headers=CSRF)


def make_link(clients, role="viewer", by="owner", **extra):
    return clients[by].post(f"/api/maps/{clients['map']}/link", json={"role": role, **extra}, headers=CSRF)


def token_of(response):
    return response.json["url"].rsplit("/s/", 1)[1]


def visit(clients, token):
    return clients["owner"].application.test_client().get(f"/s/{token}")


def test_link_redirects_into_the_app_with_the_token_in_the_fragment(three):
    created = make_link(three)
    assert created.status_code == 201 and created.json["role"] == "viewer" and created.json["expires_at"] is None
    token = token_of(created)
    r = visit(three, token)
    assert r.status_code == 302 and r.headers["Location"].endswith(f"?map={three['map']}#link={token}")
    assert r.headers["Cache-Control"] == "no-store"


def test_a_bad_link_is_a_small_gone_page(three):
    r = visit(three, "not-a-token")
    assert r.status_code == 410 and b"doesn't work any more" in r.data
    assert r.headers["Cache-Control"] == "no-store" and r.mimetype == "text/html"


def test_new_link_kills_the_old_one(three):
    old = token_of(make_link(three))
    make_link(three)
    assert visit(three, old).status_code == 410


def test_revoked_link_is_gone(three):
    token = token_of(make_link(three))
    assert three["owner"].delete(f"/api/maps/{three['map']}/link", headers=CSRF).status_code == 200
    assert visit(three, token).status_code == 410


def test_expired_link_is_gone(three, monkeypatch):
    import server.db as dbmod

    created = make_link(three, expires_in_days=1)
    token = token_of(created)
    real = dbmod.now()
    assert created.json["expires_at"] >= real + 86400 - 5
    monkeypatch.setattr(dbmod, "now", lambda: real + 2 * 86400)
    assert visit(three, token).status_code == 410


def test_expiry_must_be_never_1_7_or_30_days(three):
    assert make_link(three, expires_in_days=3).status_code == 400
    assert make_link(three, expires_in_days=30).status_code == 201


def test_the_sharing_info_shows_the_link_but_never_its_token(three):
    token = token_of(make_link(three, role="editor", expires_in_days=7))
    link = three["owner"].get(f"/api/maps/{three['map']}/sharing").json["link"]
    assert link["role"] == "editor" and link["expires_at"] is not None and token not in str(link)


def test_making_a_link_needs_invite(three):
    share(three, "vicky", "viewer")
    assert make_link(three, by="vicky").status_code == 403
    assert three["vicky"].delete(f"/api/maps/{three['map']}/link", headers=CSRF).status_code == 403


def test_viewer_with_invite_cannot_make_an_edit_link(three):
    share(three, "vicky", "viewer")
    three["owner"].put(f"/api/maps/{three['map']}/roles/viewer", json={"perms": {"invite": True}}, headers=CSRF)
    assert make_link(three, role="editor", by="vicky").status_code == 403
    assert make_link(three, role="viewer", by="vicky").status_code == 201


def test_signed_in_join_adds_to_shared_with_me(three):
    token = token_of(make_link(three, role="viewer"))
    r = three["eddie"].post(f"/api/maps/{three['map']}/join", json={"link": token}, headers=CSRF)
    assert r.status_code == 200 and r.json["role"] == "viewer"
    assert [m["name"] for m in three["eddie"].get("/api/maps/shared").json["maps"]] == ["Galaxy"]


def test_signed_in_join_keeps_a_higher_role_and_raises_a_lower_one(three):
    share(three, "eddie", "editor")
    share(three, "vicky", "viewer")
    token = token_of(make_link(three, role="viewer"))
    assert three["eddie"].post(f"/api/maps/{three['map']}/join", json={"link": token}, headers=CSRF).json["role"] == (
        "editor"
    )
    edit = token_of(make_link(three, role="editor"))
    assert three["vicky"].post(f"/api/maps/{three['map']}/join", json={"link": edit}, headers=CSRF).json["role"] == (
        "editor"
    )


def test_the_owner_joining_by_their_own_link_stays_owner(three):
    token = token_of(make_link(three))
    assert three["owner"].post(f"/api/maps/{three['map']}/join", json={"link": token}, headers=CSRF).json["role"] == (
        "owner"
    )


def test_join_with_a_bad_link_is_404(three):
    r = three["eddie"].post(f"/api/maps/{three['map']}/join", json={"link": "nope"}, headers=CSRF)
    assert r.status_code == 404
    assert three["eddie"].get("/api/maps/shared").json["maps"] == []


def test_revoking_the_link_tells_the_room(three, rooms):
    make_link(three)
    three["owner"].delete(f"/api/maps/{three['map']}/link", headers=CSRF)
    assert rooms.events == [(three["map"], "access"), (three["map"], "access")]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  Sam  ", "Sam"),
        ("Sam\u0000Evil", "SamEvil"),
        ("<b>Sam</b>", "<b>Sam</b>"),  # kept as text; the client never renders it as markup
        ("👩‍🚀 Ari", "👩‍🚀 Ari"),
        ("مرحبا", "مرحبا"),
        ("a‮b", "ab"),  # RTL override stripped (category Cf)
        ("Sam   \t Lee", "Sam Lee"),
        ("", None),
        ("   ", None),
        ("​", None),
        ("x" * 24, "x" * 24),
        ("x" * 25, None),
        ("x" * 10_000, None),
        (5, None),
        (None, None),
    ],
)
def test_review_focus_4_guest_names(raw, expected):
    assert clean_guest_name(raw) == expected


def test_members_who_joined_by_link_are_marked(three):
    share(three, "vicky", "viewer")
    token = token_of(make_link(three, role="editor"))
    three["eddie"].post(f"/api/maps/{three['map']}/join", json={"link": token}, headers=CSRF)
    members = {m["username"]: m for m in three["owner"].get(f"/api/maps/{three['map']}/sharing").json["members"]}
    assert members["eddie"]["joined_by_link"] is True and members["vicky"]["joined_by_link"] is False
