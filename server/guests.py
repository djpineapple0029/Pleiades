"""Display names for signed-out guests on a share link (context/MOONSHOT.md).

Shown as text everywhere (the client never renders a name as markup), so
this only has to make a name that can't hide or reorder what's around it:
no control, format (bidi overrides, zero-width), surrogate, private-use or
unassigned characters — except the zero-width joiner, which emoji sequences
like 👩‍🚀 need.
"""

from __future__ import annotations

import re
import unicodedata

MAX_NAME = 24
_DROP = {"Cc", "Cf", "Cs", "Co", "Cn"}
_ZWJ = "‍"


def clean_guest_name(raw: object) -> str | None:
    """NFC, the dropped categories gone, whitespace runs one space, trimmed;
    1–24 characters, else None."""
    if not isinstance(raw, str) or len(raw) > 4 * MAX_NAME:
        return None
    text = unicodedata.normalize("NFC", raw)
    text = "".join(ch for ch in text if ch == _ZWJ or unicodedata.category(ch) not in _DROP)
    text = re.sub(r"\s+", " ", text).strip().strip(_ZWJ).strip()
    return text if 1 <= len(text) <= MAX_NAME else None
