"""Production entrypoint for containers.

run.py's terminal dashboard needs an interactive TTY and isn't meant for this;
this serves the app (and its WebSockets) over uvicorn, one worker, since live
map rooms are held in this process's memory.
"""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "server.asgi:create_asgi",
        factory=True,
        host=os.environ.get("HOST", "0.0.0.0"),  # noqa: S104 -- the container must listen on all interfaces
        port=int(os.environ.get("PORT", "5051")),
        workers=1,
        proxy_headers=False,
        ws_ping_interval=20,
        ws_ping_timeout=20,
        # Caps what a client may send in one frame (its own edits); the big initial
        # sync is server → client and not limited by this. ws.py checks the same cap.
        ws_max_size=2 * 1024 * 1024 + 64 * 1024,
    )
