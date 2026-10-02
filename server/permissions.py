"""Roles and permissions for shared maps (context/MOONSHOT.md, "Permissions").

Pure rules, no database: access.py feeds them what's stored. Owner has every
permission. Editor and Viewer start from DEFAULTS, then the map's role
defaults, then a per-person override. Viewers can never Balance (they can't
edit at all).
"""

from __future__ import annotations

from collections.abc import Mapping

PERMS = ("balance", "export", "invite", "history", "chat")
ROLE_RANK = {"viewer": 1, "editor": 2, "owner": 3}
DEFAULTS: dict[str, dict[str, bool]] = {
    "editor": {"balance": True, "export": True, "invite": True, "history": False, "chat": True},
    "viewer": {"balance": False, "export": False, "invite": False, "history": False, "chat": False},
}


def _clean(values: Mapping[str, object] | None) -> dict[str, bool]:
    return {k: v for k, v in (values or {}).items() if k in PERMS and isinstance(v, bool)}


def effective(
    role: str, role_defaults: Mapping[str, object] | None, override: Mapping[str, object] | None
) -> dict[str, bool]:
    if role == "owner":
        return dict.fromkeys(PERMS, True)
    perms = {**DEFAULTS[role], **_clean(role_defaults), **_clean(override)}
    if role == "viewer":
        perms["balance"] = False
    return perms


def can_grant(granter_role: str, granter_perms: Mapping[str, bool], target_role: str) -> bool:
    """May someone with this role and these perms give `target_role` to another person?"""
    if target_role not in ("editor", "viewer"):
        return False
    return bool(granter_perms.get("invite")) and ROLE_RANK[target_role] <= ROLE_RANK[granter_role]
