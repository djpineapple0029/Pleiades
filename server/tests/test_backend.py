"""Ported from tests/_rescued/test_backend.py (session 3): crypto round trip
plus every /api endpoint path. Restructured from the original flat ok/fails
script into fixtures + parametrize — pytest imports a module fully before
running any test function, so a flat script's top-level `sys.exit()` would
kill collection outright, and its shared state (the encoded blob, the client,
the saved bytes) maps cleanly onto fixtures instead of module-level globals.
"""

from __future__ import annotations

import io

import pytest

from server import create_app
from server.api import download_name
from server.atlasfile import FormatError, PasswordError, decode, decode_any, encode

PAYLOAD = {
    "nodes": [
        {
            "id": "n1",
            "label": "root",
            "notes": "line one\nline two — ünïcode ✦",
            "links": [],
            "x": 1.5,
            "y": -2.25,
            "z": 0.0,
            "cluster_color_id": 0,
            "is_core": True,
        },
        {
            "id": "n2",
            "label": "",
            "notes": "",
            "links": ["n1"],
            "x": -40.125,
            "y": 7.0,
            "z": 3.5,
            "cluster_color_id": 2,
            "is_core": False,
        },
    ],
    "edges": [{"id": "e1", "from": "n1", "to": "n2", "directed": False, "label": "why"}],
    "camera": {"position": [0.0, 0.0, 260.0], "rotation": [0.1, -0.2, 0.0]},
}


@pytest.fixture
def blob():
    return encode(PAYLOAD, "correct horse battery staple")


class TestAtlasfile:
    def test_magic_and_version_header(self, blob):
        from server.atlasfile import MAGIC

        assert blob[:4] == MAGIC
        assert blob[4] == 1

    def test_round_trip_is_exact(self, blob):
        assert decode(blob, "correct horse battery staple") == PAYLOAD

    def test_salt_differs_per_save(self):
        assert encode(PAYLOAD, "pw")[5:21] != encode(PAYLOAD, "pw")[5:21]

    def test_ciphertext_differs_per_save(self):
        assert encode(PAYLOAD, "pw")[21:] != encode(PAYLOAD, "pw")[21:]

    def test_wrong_password_raises_password_error(self, blob):
        with pytest.raises(PasswordError):
            decode(blob, "wrong password")

    @pytest.mark.parametrize(
        "name,bad",
        [
            ("empty", b""),
            ("short", b"ATL"),
        ],
    )
    def test_rejects_malformed_input(self, name, bad):
        with pytest.raises(FormatError):
            decode(bad, "pw")

    def test_rejects_header_only(self, blob):
        from server.atlasfile import MAGIC

        with pytest.raises(FormatError):
            decode(MAGIC + b"\x01" + b"0" * 16, "pw")

    def test_rejects_bad_magic(self, blob):
        with pytest.raises(FormatError):
            decode(b"NOPE" + blob[4:], "pw")

    def test_rejects_future_version(self, blob):
        with pytest.raises(FormatError):
            decode(blob[:4] + bytes([9]) + blob[5:], "pw")

    def test_detects_tampering(self, blob):
        # A flipped byte in the token is tampering, not a format problem.
        tampered = bytearray(blob)
        tampered[-3] ^= 0xFF
        with pytest.raises(PasswordError):
            decode(bytes(tampered), "correct horse battery staple")

    def test_salt_is_bound_to_token(self, blob):
        # Salt is per-file: a token cannot be read with another file's salt.
        other = encode(PAYLOAD, "correct horse battery staple")
        spliced = other[:5] + blob[5:21] + other[21:]
        with pytest.raises(PasswordError):
            decode(spliced, "correct horse battery staple")

    def test_rejects_nan_at_save(self):
        with pytest.raises(FormatError):
            encode({"x": float("nan")}, "pw")

    def test_empty_string_password_still_derives(self):
        assert decode(encode({"a": 1}, ""), "") == {"a": 1}


@pytest.mark.parametrize(
    "raw,want",
    [
        ("mine", "mine.atlasmap"),
        ("mine.atlasmap", "mine.atlasmap"),
        ("../../etc/passwd", "passwd.atlasmap"),
        ("..\\..\\win.ini", "win.ini.atlasmap"),
        ("", "map.atlasmap"),
        ("...", "map.atlasmap"),
        (None, "map.atlasmap"),
        (42, "map.atlasmap"),
        ('a"b:c*d?', "abcd.atlasmap"),
        ("my map.atlasmap", "my map.atlasmap"),
        ("地図", "地図.atlasmap"),
        ("x\r\ny", "xy.atlasmap"),
        (".hidden", "hidden.atlasmap"),
        ("z" * 300, "z" * 120 + ".atlasmap"),
    ],
)
def test_download_name(raw, want):
    assert download_name(raw) == want


@pytest.fixture
def client():
    return create_app().test_client()


@pytest.fixture
def saved(client):
    return client.post("/api/save", json={"password": "pw", "payload": PAYLOAD, "filename": "my map"})


class TestSaveEndpoint:
    def test_status_200(self, saved):
        assert saved.status_code == 200

    def test_is_attachment(self, saved):
        assert "attachment" in saved.headers.get("Content-Disposition", "")

    def test_names_the_file(self, saved):
        assert "my map.atlasmap" in saved.headers.get("Content-Disposition", "")

    def test_is_no_store(self, saved):
        assert saved.headers.get("Cache-Control") == "no-store"

    def test_is_octet_stream(self, saved):
        assert saved.mimetype == "application/octet-stream"

    def test_bytes_decode(self, saved):
        # /api/save writes v2 now (password-system rework); decode() is the
        # v1-only reader, so a v2 blob needs decode_any.
        assert decode_any(saved.data, "pw") == PAYLOAD

    @pytest.mark.parametrize(
        "name,body",
        [
            ("no payload", {"password": "pw"}),
            ("payload is a list", {"password": "pw", "payload": []}),
            ("password is a number", {"password": 1, "payload": {}}),
        ],
    )
    def test_rejects_bad_body(self, client, name, body):
        r = client.post("/api/save", json=body)
        assert r.status_code == 400
        assert r.is_json and "error" in r.get_json()

    @pytest.mark.parametrize("body", [{"payload": {}}, {"password": "", "payload": {}}])
    def test_missing_or_blank_password_saves_unencrypted(self, client, body):
        # Password-system rework: a missing or blank password is a real
        # choice (no encryption), not a validation error.
        r = client.post("/api/save", json=body)
        assert r.status_code == 200
        assert decode_any(r.data, "") == {}

    def test_rejects_non_json_body(self, client):
        r = client.post("/api/save", data="not json", content_type="application/json")
        assert r.status_code == 400


class TestOpenEndpoint:
    # The whole point of the session: bytes off /api/save go straight back
    # into /api/open.
    def test_round_trip_is_exact(self, client, saved):
        r = client.post(
            "/api/open",
            data={"file": (io.BytesIO(saved.data), "my map.atlasmap"), "password": "pw"},
            content_type="multipart/form-data",
        )
        assert r.status_code == 200
        assert r.get_json() == PAYLOAD

    def test_is_no_store(self, client, saved):
        r = client.post(
            "/api/open",
            data={"file": (io.BytesIO(saved.data), "my map.atlasmap"), "password": "pw"},
            content_type="multipart/form-data",
        )
        assert r.headers.get("Cache-Control") == "no-store"

    def test_wrong_password_is_401(self, client, saved):
        r = client.post(
            "/api/open",
            data={"file": (io.BytesIO(saved.data), "m.atlasmap"), "password": "nope"},
            content_type="multipart/form-data",
        )
        assert r.status_code == 401
        assert r.get_json().get("error")

    def test_garbage_is_400(self, client):
        r = client.post(
            "/api/open",
            data={"file": (io.BytesIO(b"not an atlasmap file at all"), "m.atlasmap"), "password": "pw"},
            content_type="multipart/form-data",
        )
        assert r.status_code == 400

    def test_without_file_is_400(self, client):
        r = client.post("/api/open", data={"password": "pw"}, content_type="multipart/form-data")
        assert r.status_code == 400

    def test_without_password_field_is_401_against_an_encrypted_file(self, client, saved):
        # A missing password field normalizes to "" (password-system
        # rework), same as an explicit blank one — against a file that's
        # actually encrypted, that's a wrong-credentials 401, not a 400.
        r = client.post(
            "/api/open",
            data={"file": (io.BytesIO(saved.data), "m.atlasmap")},
            content_type="multipart/form-data",
        )
        assert r.status_code == 401

    def test_oversized_upload_is_413(self, client):
        r = client.post(
            "/api/open",
            data={"file": (io.BytesIO(b"x" * (65 * 1024 * 1024)), "big.atlasmap"), "password": "pw"},
            content_type="multipart/form-data",
        )
        assert r.status_code == 413
        assert r.is_json and "error" in r.get_json()
