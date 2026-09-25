"""Golden files: every `.atlasmap` ever written must keep opening (V2.md §2.7.2).

The fixtures live in `frontend/tests/fixtures/` (shared with the Vitest twin,
`frontend/tests/unit/golden.test.js`) and were written once by the code named
in that folder's README. Compare decoded JSON, never ciphertext: the salt and
nonce are fresh per save. A failure here means the format broke — never
regenerate a fixture to make it pass.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from server import atlasfile as af

FIXTURES = Path(__file__).resolve().parents[2] / "frontend" / "tests" / "fixtures"
KNOWN = "correct horse ✦ battery"
GOLDEN = [
    ("twelve", "open sesame", 1),
    ("v1-known-password", KNOWN, 1),
    ("v2-encrypted", KNOWN, 2),
    ("v2-no-password", "", 2),
]


def load(name: str) -> tuple[bytes, dict]:
    # A missing fixture raises here, so the test fails rather than skips.
    blob = (FIXTURES / f"{name}.atlasmap").read_bytes()
    expected = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
    return blob, expected


@pytest.mark.parametrize(("name", "password", "version"), GOLDEN)
def test_golden_decodes(name: str, password: str, version: int) -> None:
    blob, expected = load(name)
    assert blob[:4] == af.MAGIC
    assert blob[4] == version
    assert af.decode_any(blob, password) == expected


@pytest.mark.parametrize(("name", "password", "version"), [g for g in GOLDEN if g[2] == 1])
def test_golden_v1_through_the_frozen_decoder(name: str, password: str, version: int) -> None:
    blob, expected = load(name)
    assert af.decode(blob, password) == expected


@pytest.mark.parametrize(("name", "password", "version"), [g for g in GOLDEN if g[1]])
def test_golden_wrong_password_is_refused(name: str, password: str, version: int) -> None:
    blob, _ = load(name)
    with pytest.raises(af.PasswordError):
        af.decode_any(blob, password + "x")


def test_kdf_params_pinned() -> None:
    message = (
        "These are pinned by every .atlasmap file already written. Changing one "
        "makes old files fail as 'wrong password'. Add a new version branch instead."
    )
    assert af.VERSION == 1, message
    assert af.ITERATIONS == 600_000, message
    assert af.SALT_SIZE == 16, message
    assert af.VERSION_2 == 2, message
    assert af.V2_KEY_SIZE == 32, message
    assert af.V2_NONCE_SIZE == 12, message
    assert af.V2_MIN_ITERATIONS <= af.V2_DEFAULT_ITERATIONS <= af.V2_MAX_ITERATIONS, message
