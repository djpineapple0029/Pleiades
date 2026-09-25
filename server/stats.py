"""Request tallies for the admin dashboard and run.py's terminal dashboard."""

from __future__ import annotations

import threading
import time
from collections import Counter, deque
from collections.abc import Callable

from flask import Flask, Response, request

# The dashboard polls this; counting it would bury every real request.
UNCOUNTED = {"/api/admin/status"}


class Stats:
    """Request tallies, updated from Flask hooks under a lock."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.total = 0
        self.in_flight = 0
        self.status: Counter[int] = Counter()
        self.bytes_sent = 0
        self.clients: Counter[str] = Counter()
        self.recent: deque[dict] = deque(maxlen=20)
        self.started = time.monotonic()
        self.started_wall = time.time()

    def begin(self) -> None:
        with self.lock:
            self.in_flight += 1

    def finish(self, method: str, path: str, code: int, size: int, client: str) -> None:
        with self.lock:
            self.in_flight = max(0, self.in_flight - 1)
            self.total += 1
            self.status[code // 100] += 1
            self.bytes_sent += size
            self.clients[client] += 1
            self.recent.appendleft(
                {"time": time.time(), "method": method, "path": path[:80], "status": code, "client": client}
            )

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "total": self.total,
                "in_flight": self.in_flight,
                "status": {f"{k}xx": v for k, v in sorted(self.status.items())},
                "bytes_sent": self.bytes_sent,
                "unique_clients": len(self.clients),
                "top_clients": self.clients.most_common(5),
                "recent": list(self.recent),
                "uptime": time.monotonic() - self.started,
                "started": self.started_wall,
            }


def instrument(app: Flask, stats: Stats, client_of: Callable[[], str]) -> None:
    """`client_of()` gives the request's client address (proxy-aware)."""

    @app.before_request
    def _before() -> None:
        if request.path not in UNCOUNTED:
            stats.begin()

    @app.after_request
    def _after(response: Response) -> Response:
        if request.path in UNCOUNTED:
            return response
        try:
            size = response.calculate_content_length() or 0
        except Exception:
            size = 0
        stats.finish(request.method, request.path, response.status_code, size, client_of())
        return response
