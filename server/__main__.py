"""Development entry point: python -m server"""

from __future__ import annotations

import os

from . import create_app

if __name__ == "__main__":
    create_app().run(
        host=os.environ.get("ATLASMAP_HOST", "127.0.0.1"),
        # 5000 is taken by AirPlay Receiver on macOS.
        port=int(os.environ.get("ATLASMAP_PORT", "5001")),
        debug=True,
    )
