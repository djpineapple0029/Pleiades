"""Coverage for the v2 container added by the password-system rework.

Not wired into a runner yet — there is no pytest config/CI in this repo yet
(see `context/V2.md` §2.7.1/§2.7.5) — but this belongs in the tree rather
than a scratchpad, and running it is one command in the meantime:

    uv run pytest server/tests/test_atlasfile_v2.py
"""

from __future__ import annotations

import struct

import pytest

from server import atlasfile as af

PAYLOAD = {"nodes": [{"id": "n1", "label": "hi"}], "edges": [], "camera": {}}


def test_v1_is_untouched():
    blob = af.encode(PAYLOAD, "hunter2")
    assert af.decode(blob, "hunter2") == PAYLOAD
    assert af.decode_any(blob, "hunter2") == PAYLOAD


def test_v2_password_round_trip():
    blob = af.encode_v2(PAYLOAD, "hunter2")
    assert blob[:5] == af.MAGIC + bytes([af.VERSION_2])
    assert blob[5] == af.MODE_PBKDF2_AESGCM
    assert af.decode_v2(blob, "hunter2") == PAYLOAD
    assert af.decode_any(blob, "hunter2") == PAYLOAD


def test_v2_wrong_password_rejected():
    blob = af.encode_v2(PAYLOAD, "hunter2")
    with pytest.raises(af.PasswordError):
        af.decode_v2(blob, "wrong")


def test_v2_no_password_round_trip():
    blob = af.encode_v2(PAYLOAD, "")
    assert blob[5] == af.MODE_NONE
    assert af.decode_v2(blob, "") == PAYLOAD
    # A NONE-mode file never checks the password at all.
    assert af.decode_any(blob, "anything") == PAYLOAD


@pytest.mark.parametrize("byte_offset", [10, -1])  # inside the salt; inside the ciphertext
def test_v2_tamper_detected(byte_offset):
    blob = bytearray(af.encode_v2(PAYLOAD, "hunter2"))
    blob[byte_offset] ^= 0xFF
    with pytest.raises(af.PasswordError):
        af.decode_v2(bytes(blob), "hunter2")


def test_v2_iteration_bounds_enforced():
    header = (
        af.MAGIC
        + bytes([af.VERSION_2, af.MODE_PBKDF2_AESGCM])
        + struct.pack(">I", 999_999_999)
        + b"0" * af.SALT_SIZE
        + b"0" * af.V2_NONCE_SIZE
        + b"ciphertext-doesnt-matter-bounds-checked-first"
    )
    with pytest.raises(af.FormatError):
        af.decode_v2(header, "whatever")


def test_decode_any_rejects_unknown_version():
    blob = af.MAGIC + bytes([99])
    with pytest.raises(af.FormatError):
        af.decode_any(blob, "whatever")
