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

---

Version 2 is a second, independent container living alongside v1 below,
**never replacing it**: every v1 file already on someone's disk has to keep
opening forever, so `decode()`/`encode()`/`VERSION`/`ITERATIONS` above are
frozen exactly as they are. v2 exists for two things v1 cannot do: a file
with no password at all, and (when the frontend has a secure context)
encrypting entirely in the browser so neither the password nor the plaintext
map ever has to reach this server. See `frontend/src/format/container.js` for
the browser-side twin of this format — the two must stay byte-compatible.

    bytes 0-3    magic b"ATLM"                (shared with v1)
    byte  4      format version = 2
    byte  5      crypto mode: 0 = none, 1 = PBKDF2-SHA256 + AES-256-GCM
    mode 0:
      bytes 6+     the JSON payload, verbatim, **not encrypted**
    mode 1:
      bytes 6-9    iterations, big-endian uint32 (bounded on read, see below)
      bytes 10-25  salt, 16 bytes
      bytes 26-37  GCM nonce, 12 bytes
      bytes 38+    AES-256-GCM ciphertext, tag appended (`AESGCM.encrypt`'s
                   own output shape)

Everything from byte 0 up to the start of the ciphertext is passed to AES-GCM
as additional authenticated data, so flipping any header byte — the mode,
the claimed iteration count, the salt — fails authentication instead of
silently deriving a different key or accepting a forged iteration count.
Iterations are bounds-checked on read for the same reason `decode()` never
lets a *v1* file choose its own KDF cost: an unbounded value from an
untrusted file could hang the tab (or the server) for as long as it likes.

Mode 0 writes the map in the clear — this is the explicit "no password"
option the UI now offers, not a fallback or a bug. Callers must not treat a
mode-0 file as equivalent to "give up on reading the password field"; it is
only ever written when someone typed nothing on purpose.
"""

from __future__ import annotations

import base64
import json
import secrets
import struct
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

MAGIC = b"ATLM"
VERSION = 1
SALT_SIZE = 16
HEADER_SIZE = len(MAGIC) + 1 + SALT_SIZE
# OWASP's floor for PBKDF2-HMAC-SHA256. ~130 ms per derivation here, which is
# once per save and once per open — not per frame, and not per node.
ITERATIONS = 600_000

# --- v2 -----------------------------------------------------------------

VERSION_2 = 2
MODE_NONE = 0
MODE_PBKDF2_AESGCM = 1
V2_NONCE_SIZE = 12
V2_KEY_SIZE = 32  # AES-256
# Same floor as v1's fixed count, and a ceiling so a hostile file can't make
# a derivation take arbitrarily long — both ends bound what an untrusted
# header is allowed to ask for.
V2_MIN_ITERATIONS = 100_000
V2_MAX_ITERATIONS = 10_000_000
V2_DEFAULT_ITERATIONS = 600_000


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

    return _parse_json_object(body)


def _parse_json_object(body: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as exc:
        raise FormatError("Decrypted, but the contents are not valid JSON.") from exc
    if not isinstance(payload, dict):
        raise FormatError("Decrypted, but the contents are not a JSON object.")
    return payload


def _key_v2(password: str, salt: bytes, iterations: int) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=V2_KEY_SIZE, salt=salt, iterations=iterations)
    return kdf.derive(password.encode("utf-8"))


def encode_v2(payload: dict[str, Any], password: str) -> bytes:
    """Like `encode`, but writes v2: AES-256-GCM, and a real no-password mode.

    An empty or `None` password writes mode 0 — the payload in the clear.
    That is a deliberate choice made by the caller (an empty password field
    submitted on purpose), never an error path; the UI is what's responsible
    for warning the human before it gets here.
    """
    try:
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except ValueError as exc:
        raise FormatError("Payload holds values JSON cannot represent.") from exc

    header_start = MAGIC + bytes([VERSION_2])
    if not password:
        return header_start + bytes([MODE_NONE]) + body

    salt = secrets.token_bytes(SALT_SIZE)
    nonce = secrets.token_bytes(V2_NONCE_SIZE)
    header = header_start + bytes([MODE_PBKDF2_AESGCM]) + struct.pack(">I", V2_DEFAULT_ITERATIONS) + salt + nonce
    key = _key_v2(password, salt, V2_DEFAULT_ITERATIONS)
    # The whole header is authenticated data: tampering with the claimed
    # iteration count, salt, or mode byte then fails the tag check below
    # instead of quietly deriving the wrong key.
    ciphertext = AESGCM(key).encrypt(nonce, body, header)
    return header + ciphertext


def decode_v2(blob: bytes, password: str) -> dict[str, Any]:
    """The v2 counterpart to `decode`. See the module docstring for the layout."""
    prefix_size = len(MAGIC) + 2  # magic + version + mode
    if len(blob) < prefix_size:
        raise FormatError("Not an .atlasmap file: too short to hold a header.")

    mode = blob[len(MAGIC) + 1]
    if mode == MODE_NONE:
        return _parse_json_object(blob[prefix_size:])
    if mode != MODE_PBKDF2_AESGCM:
        raise FormatError(f"Unrecognised v2 crypto mode ({mode}); this build cannot read this file.")

    header_size = prefix_size + 4 + SALT_SIZE + V2_NONCE_SIZE
    if len(blob) < header_size:
        raise FormatError("Not an .atlasmap file: too short to hold a v2 header.")

    (iterations,) = struct.unpack(">I", blob[prefix_size : prefix_size + 4])
    if not (V2_MIN_ITERATIONS <= iterations <= V2_MAX_ITERATIONS):
        # A file cannot be allowed to name its own KDF cost with no ceiling —
        # that turns "open a file" into a denial-of-service the file controls.
        raise FormatError("This file's KDF parameters are out of the range this build accepts.")

    salt_start = prefix_size + 4
    nonce_start = salt_start + SALT_SIZE
    ciphertext_start = nonce_start + V2_NONCE_SIZE
    salt = blob[salt_start:nonce_start]
    nonce = blob[nonce_start:ciphertext_start]
    header = blob[:ciphertext_start]

    key = _key_v2(password, salt, iterations)
    try:
        body = AESGCM(key).decrypt(nonce, blob[ciphertext_start:], header)
    except Exception as exc:  # cryptography raises InvalidTag, not a public alias
        raise PasswordError("Wrong password, or the file has been altered since it was saved.") from exc

    return _parse_json_object(body)


def decode_any(blob: bytes, password: str) -> dict[str, Any]:
    """Reads a v1 *or* v2 `.atlasmap`, dispatching on the version byte.

    This is what `/api/open` should call from now on — everything already on
    disk is v1, and everything newly written by a secure-context browser (or
    by `encode_v2` here, for the insecure-context fallback) is v2.
    """
    if len(blob) <= len(MAGIC):
        raise FormatError("Not an .atlasmap file: too short to hold a header.")
    if blob[: len(MAGIC)] != MAGIC:
        raise FormatError("Not an .atlasmap file.")

    version = blob[len(MAGIC)]
    if version == VERSION:
        return decode(blob, password)
    if version == VERSION_2:
        return decode_v2(blob, password)
    raise FormatError(f"This is an .atlasmap version {version} file; this build reads versions 1 and 2.")
