"""Every test's app gets a throwaway config file, never the real config/atlasmap.toml."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def isolated_config(tmp_path, monkeypatch):
    path = tmp_path / "atlasmap.toml"
    monkeypatch.setenv("ATLASMAP_CONFIG", str(path))
    monkeypatch.delenv("ATLASMAP_TRUSTED_PROXIES", raising=False)
    return path
