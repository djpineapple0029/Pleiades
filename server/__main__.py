"""Development entry point: python -m server (uvicorn, auto-reload)."""

from __future__ import annotations

import uvicorn

from .env import env

if __name__ == "__main__":
    uvicorn.run(
        "server.asgi:create_asgi",
        factory=True,
        host=env("HOST", "127.0.0.1"),
        # 5000 is taken by AirPlay Receiver on macOS.
        port=int(env("PORT", "5001")),
        reload=True,
        reload_dirs=["server"],
        # Same client-address behaviour as before: Flask's own trusted_proxies
        # logic reads X-Forwarded-For; uvicorn must not rewrite it first.
        proxy_headers=False,
    )
