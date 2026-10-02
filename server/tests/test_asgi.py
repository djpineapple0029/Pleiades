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


# --- Final review: share-link tokens never reach the server's logs -----------


def test_link_tokens_are_redacted_from_uvicorn_logs(isolated_config, caplog):
    import logging

    from server.asgi import create_asgi

    create_asgi()
    secret = "S3cr3t-tok_en"
    with caplog.at_level(logging.INFO):
        logging.getLogger("uvicorn.error").info(
            '%s - "WebSocket %s" [accepted]', "1.2.3.4:5", f"/ws/maps/abc?link={secret}&name=Ari&guest=k"
        )
        logging.getLogger("uvicorn.access").info(
            '%s - "%s %s HTTP/%s" %d', "1.2.3.4:5", "GET", f"/pleiades/s/{secret}", "1.1", 302
        )
    text = caplog.text
    assert secret not in text
    assert "link=[redacted]" in text and "/pleiades/s/[redacted]" in text and "name=Ari" in text
