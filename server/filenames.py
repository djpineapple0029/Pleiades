"""What a map file is called on someone's disk: `<name>.plm`, never `.atlasmap`.

Shared by the classic save (`/api/save`) and the account zip
(`/api/account/export.zip`), which both hand files to a download directory.
"""

from __future__ import annotations

SUFFIX = ".plm"
# Files were `.atlasmap` before the rename to Pleiades; same bytes, saved again as `.plm`.
LEGACY_SUFFIX = ".atlasmap"
DEFAULT_NAME = f"map{SUFFIX}"
MAX_NAME_LENGTH = 120
# Reserved on some filesystem or other, plus the separators that would let a
# name climb out of the download directory.
UNSAFE_CHARS = set('"\\/:*?<>|')


def download_name(raw: object) -> str:
    """A filename safe to put in a Content-Disposition header, `.plm`-suffixed (never `.atlasmap`)."""
    if not isinstance(raw, str):
        return DEFAULT_NAME
    name = raw.replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(ch for ch in name if ch.isprintable() and ch not in UNSAFE_CHARS)
    # Leading dots would hide the file; trailing dots and spaces are dropped by
    # some filesystems anyway. Strip after truncating too, or the cut can leave one.
    name = name.strip(" .")[:MAX_NAME_LENGTH].strip(" .")
    if not name:
        return DEFAULT_NAME
    return name.removesuffix(LEGACY_SUFFIX).removesuffix(SUFFIX) + SUFFIX


def map_name(filename: object) -> str | None:
    """An uploaded file's name as a map name: `Trip.plm` → `Trip`. None if nothing's left."""
    if not isinstance(filename, str):
        return None
    name = filename.replace("\\", "/").rsplit("/", 1)[-1]
    name = name.removesuffix(LEGACY_SUFFIX).removesuffix(SUFFIX).strip()
    return name or None
