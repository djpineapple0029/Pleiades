"""Sharing a map by username (server/sharing.py) and what each role may do
through the map routes (server/maps.py asking server/access.py)."""

from __future__ import annotations

ACCOUNT_PASSWORD = "long enough pw"  # conftest.py's signup fixture uses the same
CSRF = {"X-Pleiades": "1"}


def share(clients, who, role, by="owner"):
    return clients[by].post(f"/api/maps/{clients['map']}/members", json={"username": who, "role": role}, headers=CSRF)


def me(client):
    return client.get("/api/auth/me").json["user"]["id"]


def test_auth_me_says_who_you_are(three):
    assert isinstance(me(three["owner"]), int) and me(three["owner"]) != me(three["eddie"])


def test_owner_shares_by_username(three):
    assert share(three, "eddie", "editor").status_code == 201
    shared = three["eddie"].get("/api/maps/shared").json["maps"]
    assert [m["name"] for m in shared] == ["Galaxy"]
    assert shared[0]["role"] == "editor" and shared[0]["owner"] == "owner" and shared[0]["new"] is True


def test_usernames_are_matched_without_case(three):
    assert share(three, "EDDIE", "viewer").status_code == 201


def test_unknown_username_is_404(three):
    response = share(three, "nobody", "viewer")
    assert response.status_code == 404 and "nobody" in response.json["error"]


def test_bad_role_is_400(three):
    assert share(three, "eddie", "owner").status_code == 400
    assert share(three, "eddie", "admin").status_code == 400


def test_owner_cannot_be_added_as_a_member(three):
    assert share(three, "owner", "editor").status_code == 409


def test_editor_can_invite_editor_viewer_cannot_invite_at_all(three):
    share(three, "eddie", "editor")
    share(three, "vicky", "viewer")
    assert share(three, "vicky", "viewer", by="eddie").status_code == 409  # editor may invite; vi already has access
    three["owner"].delete(f"/api/maps/{three['map']}/members/{me(three['vicky'])}", headers=CSRF)
    assert share(three, "vicky", "viewer", by="eddie").status_code == 201
    assert share(three, "eddie", "editor", by="vicky").status_code == 403  # viewers have no invite by default


def test_sharing_lists_members_and_your_access(three):
    share(three, "eddie", "editor")
    sharing = three["eddie"].get(f"/api/maps/{three['map']}/sharing").json
    assert sharing["you"]["role"] == "editor" and sharing["you"]["perms"]["invite"] is True
    assert sharing["owner"]["username"] == "owner"
    assert [(m["username"], m["role"]) for m in sharing["members"]] == [("eddie", "editor")]
    assert sharing["link"] is None


def test_a_map_you_cannot_see_is_404_not_403(three):
    assert three["eddie"].get(f"/api/maps/{three['map']}").status_code == 404
    assert three["eddie"].get(f"/api/maps/{three['map']}/sharing").status_code == 404
    assert share(three, "vicky", "viewer", by="eddie").status_code == 404


def test_viewer_lacks_export_so_download_is_403_with_the_permission(three):
    share(three, "vicky", "viewer")
    response = three["vicky"].get(f"/api/maps/{three['map']}")
    assert response.status_code == 403 and response.json["permission"] == "export"


def test_editor_can_download_and_save(three):
    share(three, "eddie", "editor")
    got = three["eddie"].get(f"/api/maps/{three['map']}")
    assert got.status_code == 200
    saved = three["eddie"].put(
        f"/api/maps/{three['map']}",
        json={"payload": {"nodes": [], "edges": []}},
        headers={**CSRF, "If-Match": str(got.json["revision"])},
    )
    assert saved.status_code == 200


def test_viewer_cannot_save(three):
    share(three, "vicky", "viewer")
    response = three["vicky"].put(
        f"/api/maps/{three['map']}", json={"payload": {"nodes": [], "edges": []}}, headers={**CSRF, "If-Match": "1"}
    )
    assert response.status_code == 403 and response.json["permission"] == "edit"


def test_only_owner_renames_or_deletes(three):
    share(three, "eddie", "editor")
    assert three["eddie"].patch(f"/api/maps/{three['map']}", json={"name": "x"}, headers=CSRF).status_code == 403
    assert three["eddie"].delete(f"/api/maps/{three['map']}", headers=CSRF).status_code == 403


def test_history_needs_the_history_permission(three):
    share(three, "eddie", "editor")
    response = three["eddie"].get(f"/api/maps/{three['map']}/snapshots")
    assert response.status_code == 403 and response.json["permission"] == "history"
    assert three["owner"].get(f"/api/maps/{three['map']}/snapshots").status_code == 200


def test_duplicate_lands_in_your_own_list(three):
    share(three, "eddie", "editor")
    copy = three["eddie"].post(f"/api/maps/{three['map']}/duplicate", headers=CSRF)
    assert copy.status_code == 201
    assert copy.json["id"] in [m["id"] for m in three["eddie"].get("/api/maps").json["maps"]]


def test_owner_changes_a_role_others_cannot(three):
    share(three, "eddie", "editor")
    share(three, "vicky", "viewer")
    url = f"/api/maps/{three['map']}/members/{me(three['vicky'])}"
    assert three["eddie"].patch(url, json={"role": "editor"}, headers=CSRF).status_code == 403
    assert three["owner"].patch(url, json={"role": "editor"}, headers=CSRF).status_code == 200
    assert three["vicky"].get(f"/api/maps/{three['map']}/sharing").json["you"]["role"] == "editor"


def test_member_can_leave(three):
    share(three, "eddie", "editor")
    assert (
        three["eddie"].delete(f"/api/maps/{three['map']}/members/{me(three['eddie'])}", headers=CSRF).status_code == 200
    )
    assert three["eddie"].get("/api/maps/shared").json["maps"] == []


def test_member_cannot_remove_someone_else(three):
    share(three, "eddie", "editor")
    share(three, "vicky", "viewer")
    url = f"/api/maps/{three['map']}/members/{me(three['vicky'])}"
    assert three["eddie"].delete(url, headers=CSRF).status_code == 403


def test_shared_maps_count_only_against_the_owner(three, accounts_app):
    config = accounts_app.extensions["pleiades_config"]
    values = config.all_values()
    values["accounts"]["max_maps_per_user"] = 1
    config.save(values)
    share(three, "eddie", "editor")
    assert three["eddie"].post("/api/maps", json={"name": "Mine"}, headers=CSRF).status_code == 201


def test_sharing_switched_off_hides_shared_maps(three, accounts_app):
    share(three, "eddie", "editor")
    config = accounts_app.extensions["pleiades_config"]
    values = config.all_values()
    values["sharing"]["enabled"] = False
    config.save(values)
    assert three["eddie"].get(f"/api/maps/{three['map']}").status_code == 404
    assert three["owner"].get(f"/api/maps/{three['map']}").status_code == 200


def test_deleting_the_owner_account_removes_access(three):
    share(three, "eddie", "editor")
    three["owner"].delete("/api/account", json={"password": ACCOUNT_PASSWORD}, headers=CSRF)
    assert three["eddie"].get("/api/maps/shared").json["maps"] == []


def stored_ydoc(accounts_app, map_id):
    with accounts_app.extensions["pleiades_db"].connect() as conn:
        return tuple(conn.execute("SELECT ydoc, ydoc_epoch FROM maps WHERE id = ?", (map_id,)).fetchone())


def room_write(accounts_app, map_id, base):
    from server import db as dbmod
    from server.maps import write_payload

    with accounts_app.app_context(), accounts_app.extensions["pleiades_db"].transaction() as conn:
        return write_payload(
            conn, map_id, {"nodes": [], "edges": []}, now=dbmod.now(), ydoc=b"state", ydoc_epoch="E", base_revision=base
        )


def test_a_room_write_keeps_its_ydoc_and_a_stale_one_is_refused(three, accounts_app):
    assert room_write(accounts_app, three["map"], 1) == 2
    assert stored_ydoc(accounts_app, three["map"]) == (b"state", "E")
    assert room_write(accounts_app, three["map"], 1) is None


def test_a_put_clears_the_ydoc_and_tells_the_room_to_reload(three, accounts_app, rooms):
    room_write(accounts_app, three["map"], 1)
    response = three["owner"].put(
        f"/api/maps/{three['map']}", json={"payload": {"nodes": [], "edges": []}}, headers={**CSRF, "If-Match": "2"}
    )
    assert response.status_code == 200
    assert stored_ydoc(accounts_app, three["map"]) == (None, None)
    assert (three["map"], "reload") in rooms.events


def test_a_restore_clears_the_ydoc_and_tells_the_room_to_reload(three, accounts_app, rooms):
    room_write(accounts_app, three["map"], 1)
    with accounts_app.extensions["pleiades_db"].connect() as conn:
        conn.execute(
            "INSERT INTO snapshots (map_id, revision, payload, created_at, reason) "
            "SELECT id, 1, payload, 0, 'rolling' FROM maps WHERE id = ?",
            (three["map"],),
        )
        (snapshot,) = conn.execute("SELECT id FROM snapshots").fetchone()
    restored = three["owner"].post(f"/api/maps/{three['map']}/snapshots/{snapshot}/restore", headers=CSRF)
    assert restored.status_code == 200
    assert stored_ydoc(accounts_app, three["map"]) == (None, None)
    assert (three["map"], "reload") in rooms.events


def test_delete_and_membership_changes_reach_the_room(three, rooms):
    share(three, "eddie", "editor")
    assert (three["map"], "access") in rooms.events
    three["owner"].delete(f"/api/maps/{three['map']}", headers=CSRF)
    assert (three["map"], "deleted") in rooms.events


def test_only_the_owner_can_put_a_version_into_history(three):
    share(three, "eddie", "editor")
    planted = three["eddie"].post(
        f"/api/maps/{three['map']}/snapshots", json={"payload": {"nodes": [], "edges": []}}, headers=CSRF
    )
    assert planted.status_code == 403


# --- Milestone 2: role defaults and per-person overrides -------------------


def test_owner_sets_role_defaults_and_they_apply(three):
    share(three, "eddie", "editor")
    r = three["owner"].put(
        f"/api/maps/{three['map']}/roles/editor", json={"perms": {"history": True, "fly": True}}, headers=CSRF
    )
    assert r.status_code == 200
    sharing = three["eddie"].get(f"/api/maps/{three['map']}/sharing").json
    assert sharing["you"]["perms"]["history"] is True and "fly" not in sharing["you"]["perms"]
    assert sharing["role_defaults"]["editor"]["history"] is True
    assert three["eddie"].get(f"/api/maps/{three['map']}/snapshots").status_code == 200


def test_role_defaults_keep_only_known_boolean_perms(three):
    url = f"/api/maps/{three['map']}/roles/viewer"
    assert three["owner"].put(url, json={"perms": {"chat": "yes", "export": True}}, headers=CSRF).status_code == 200
    defaults = three["owner"].get(f"/api/maps/{three['map']}/sharing").json["role_defaults"]["viewer"]
    assert defaults["export"] is True and defaults["chat"] is False


def test_role_defaults_need_a_known_role_and_perms_object(three):
    url = f"/api/maps/{three['map']}/roles"
    assert three["owner"].put(f"{url}/owner", json={"perms": {}}, headers=CSRF).status_code == 400
    assert three["owner"].put(f"{url}/editor", json={"perms": []}, headers=CSRF).status_code == 400


def test_per_person_override_beats_role_default(three):
    share(three, "eddie", "editor")
    eddie = me(three["eddie"])
    url = f"/api/maps/{three['map']}/members/{eddie}"
    assert three["owner"].patch(url, json={"perms": {"export": False}}, headers=CSRF).status_code == 200
    assert three["eddie"].get(f"/api/maps/{three['map']}").status_code == 403
    member = three["owner"].get(f"/api/maps/{three['map']}/sharing").json["members"][0]
    assert member["perms_override"] == {"export": False} and member["effective"]["export"] is False
    assert three["owner"].patch(url, json={"perms": None}, headers=CSRF).status_code == 200
    assert three["eddie"].get(f"/api/maps/{three['map']}").status_code == 200


def test_patch_member_may_change_role_and_perms_together_or_alone(three):
    share(three, "eddie", "editor")
    url = f"/api/maps/{three['map']}/members/{me(three['eddie'])}"
    r = three["owner"].patch(url, json={"role": "viewer", "perms": {"chat": True}}, headers=CSRF)
    assert r.status_code == 200
    you = three["eddie"].get(f"/api/maps/{three['map']}/sharing").json["you"]
    assert you["role"] == "viewer" and you["perms"]["chat"] is True
    assert three["owner"].patch(url, json={}, headers=CSRF).status_code == 400


def test_only_owner_edits_permissions(three):
    share(three, "eddie", "editor")
    r = three["eddie"].put(f"/api/maps/{three['map']}/roles/viewer", json={"perms": {"chat": True}}, headers=CSRF)
    assert r.status_code == 403
    url = f"/api/maps/{three['map']}/members/{me(three['eddie'])}"
    assert three["eddie"].patch(url, json={"perms": {"history": True}}, headers=CSRF).status_code == 403


def test_permission_changes_reach_the_room(three, rooms):
    share(three, "eddie", "editor")
    rooms.events.clear()
    three["owner"].put(f"/api/maps/{three['map']}/roles/editor", json={"perms": {"chat": False}}, headers=CSRF)
    url = f"/api/maps/{three['map']}/members/{me(three['eddie'])}"
    three["owner"].patch(url, json={"perms": {"chat": True}}, headers=CSRF)
    assert rooms.events == [(three["map"], "access"), (three["map"], "access")]
