"""Development entry point: python -m server"""

from __future__ import annotations

from . import create_app
from .env import env

if __name__ == "__main__":
    create_app().run(
        host=env("HOST", "127.0.0.1"),
        # 5000 is taken by AirPlay Receiver on macOS.
        port=int(env("PORT", "5001")),
        debug=True,
    )
