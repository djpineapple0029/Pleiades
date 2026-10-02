"""The ASGI host: Flask still answers every HTTP path, and WebSockets work."""

from __future__ import annotations

from starlette.testclient import TestClient


def make_client():
    from server.asgi import create_asgi

    return TestClient(create_asgi())


def test_flask_routes_still_answer_through_asgi():
    with make_client() as client:
        response = client.get("/api/config")
        assert response.status_code == 200
        assert "keybinds" in response.json()


def test_flask_404_is_still_flask():
    with make_client() as client:
        assert client.get("/api/nope").status_code == 404


def test_live_map_rooms_are_wired_in():
    with make_client() as client:
        assert client.app.state.flask.extensions["pleiades_rooms"] is not None


def test_flask_app_is_reachable_for_other_modules():
    from server.asgi import create_asgi

    asgi = create_asgi()
    assert asgi.state.flask.extensions["pleiades_config"] is not None
