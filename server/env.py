"""Names from before the project was renamed Pleiades (it was AtlasMap).

Existing deployments still set `ATLASMAP_*` variables and still have an
`atlasmap.toml` config and an `atlasmap.db` database on disk, so the new names
win when both exist and the old ones are honoured otherwise. The `.atlasmap`
file format keeps its name: it's pinned to every map already written.
"""

from __future__ import annotations

import os
from pathlib import Path

LEGACY_FILES = {"pleiades.toml": "atlasmap.toml", "pleiades.db": "atlasmap.db"}


def env(name: str, default: str = "") -> str:
    """`$PLEIADES_<name>`, else `$ATLASMAP_<name>`, else `default`."""
    for prefix in ("PLEIADES_", "ATLASMAP_"):
        value = os.environ.get(prefix + name)
        if value is not None:
            return value
    return default


def legacy(path: Path) -> Path:
    """`path`, or its pre-rename sibling when only the sibling exists."""
    old = LEGACY_FILES.get(path.name)
    if old is None or path.exists() or not path.with_name(old).exists():
        return path
    return path.with_name(old)
