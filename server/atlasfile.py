"""The `.atlasmap` container: password-derived key, authenticated encryption.

Layout, none of it negotiable once files exist on someone's disk:

    bytes 0-3    magic b"ATLM"
    byte  4      format version
    bytes 5-20   salt, 16 bytes, fresh on every save
    bytes 21+    Fernet token over the compact-JSON payload

The KDF parameters are *not* in the header, so VERSION is the only thing
pinning them: raising ITERATIONS without bumping VERSION would silently make
every existing file undecryptable, and the failure would look exactly like a
wrong password. A future version byte selects the parameter set to derive with.

The salt is regenerated on every save rather than carried over from the file
being replaced. Nothing needs the old one — decrypt reads the salt out of the
header it was handed — and a fresh one per write is strictly the safer default.

Fernet stamps each token with an unencrypted creation timestamp, so a file
leaks when it was written even to someone who cannot read it. That is the one
thing the container does not hide.
"""

from __future__ import annotations

import base64
import json
import secrets
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

MAGIC = b"ATLM"
VERSION = 1
SALT_SIZE = 16
HEADER_SIZE = len(MAGIC) + 1 + SALT_SIZE
# OWASP's floor for PBKDF2-HMAC-SHA256. ~130 ms per derivation here, which is
# once per save and once per open — not per frame, and not per node.
ITERATIONS = 600_000


class AtlasFileError(Exception):
    """Base for anything that stops a payload becoming a file, or back again."""


class FormatError(AtlasFileError):
    """Not an `.atlasmap` file, or one this build cannot read."""


class PasswordError(AtlasFileError):
    """The key derived from the given password does not open the token."""


def _key(password: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=ITERATIONS,
    )
    return base64.urlsafe_b64encode(kdf.derive(password.encode("utf-8")))


def encode(payload: dict[str, Any], password: str) -> bytes:
    """Serialises, encrypts, and frames a payload as `.atlasmap` bytes."""
    try:
        # allow_nan=False: Python would happily write bare NaN, which is not
        # JSON and which the browser refuses to parse back. Better to fail the
        # save than to hand the user a file that will not reopen.
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except ValueError as exc:
        raise FormatError("Payload holds values JSON cannot represent.") from exc

    salt = secrets.token_bytes(SALT_SIZE)
    token = Fernet(_key(password, salt)).encrypt(body)
    return MAGIC + bytes([VERSION]) + salt + token


def decode(blob: bytes, password: str) -> dict[str, Any]:
    """Unframes, decrypts, and parses `.atlasmap` bytes back into a payload."""
    if len(blob) <= HEADER_SIZE:
        raise FormatError("Not an .atlasmap file: too short to hold a header.")
    if blob[: len(MAGIC)] != MAGIC:
        raise FormatError("Not an .atlasmap file.")

    version = blob[len(MAGIC)]
    if version != VERSION:
        raise FormatError(f"This is an .atlasmap version {version} file; this build reads version {VERSION}.")

    salt = blob[len(MAGIC) + 1 : HEADER_SIZE]
    try:
        body = Fernet(_key(password, salt)).decrypt(blob[HEADER_SIZE:])
    except InvalidToken as exc:
        # Fernet authenticates before it decrypts, and cannot tell a wrong key
        # from a tampered token — so neither can this message.
        raise PasswordError("Wrong password, or the file has been altered since it was saved.") from exc

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise FormatError("Decrypted, but the contents are not valid JSON.") from exc
    if not isinstance(payload, dict):
        raise FormatError("Decrypted, but the contents are not a JSON object.")
    return payload
