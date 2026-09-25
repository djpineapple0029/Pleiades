"""Run AtlasMap and watch it from a small terminal dashboard.

    uv run python run.py          # or: .venv/bin/python run.py

Binds the Flask app on every interface so other devices on your network can
reach it, then draws a TUI with the URLs to connect to and a running tally of
requests. The screen does not refresh on its own — press Enter to redraw it,
or type q then Enter (or Ctrl+C) to stop the server and exit.

The admin panel is at /admin on the same port. On the very first run the
dashboard shows the generated admin password; change it in the panel.

Environment:
    ATLASMAP_HOST     bind address (default 0.0.0.0 — all interfaces)
    ATLASMAP_PORT     bind port (default 5051; 5000 is AirPlay on macOS)
    ATLASMAP_CONFIG   config file (default config/atlasmap.toml)
"""

from __future__ import annotations

import logging
import os
import socket
import sys
import threading
import time
import urllib.request
from datetime import timedelta

from werkzeug.serving import make_server

from server import create_app

HOST = os.environ.get("ATLASMAP_HOST", "0.0.0.0")
PORT = int(os.environ.get("ATLASMAP_PORT", "5051"))

# ANSI helpers -----------------------------------------------------------------
CLEAR = "\x1b[2J\x1b[H"
DIM = "\x1b[2m"
BOLD = "\x1b[1m"
CYAN = "\x1b[36m"
GREEN = "\x1b[32m"
YELLOW = "\x1b[33m"
RED = "\x1b[31m"
RESET = "\x1b[0m"


def lan_ip() -> str:
    """Best guess at this machine's address on the local network."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no packets sent for UDP; just picks a route
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def public_ip() -> str:
    """Ask ipify for the internet-facing address. Returns '' if offline."""
    try:
        with urllib.request.urlopen("https://api.ipify.org", timeout=3) as r:
            return r.read().decode().strip()
    except Exception:
        return ""


def human_bytes(n: int) -> str:
    step = 1024.0
    for unit in ("B", "KB", "MB", "GB"):
        if n < step:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= step
    return f"{n:.1f} TB"


def render(stats: dict, addrs: dict, first_password: str | None) -> str:
    up = str(timedelta(seconds=int(stats["uptime"])))
    st = stats["status"]

    lines = []
    lines.append(f"{BOLD}{CYAN}  AtlasMap{RESET}  {DIM}3D galaxy mind mapping{RESET}")
    lines.append(f"  {DIM}{'─' * 58}{RESET}")
    lines.append(f"  {BOLD}Connect from{RESET}")
    lines.append(f"    this machine    {GREEN}http://127.0.0.1:{PORT}{RESET}")
    if addrs["lan"]:
        lines.append(f"    same network     {GREEN}http://{addrs['lan']}:{PORT}{RESET}")
    if addrs["public"]:
        lines.append(
            f"    internet         {YELLOW}http://{addrs['public']}:{PORT}{RESET} "
            f"{DIM}(needs a port-forward){RESET}"
        )
    else:
        lines.append(f"    internet         {DIM}offline / unknown{RESET}")
    lines.append("")
    lines.append(f"  {BOLD}Server{RESET}   bind {HOST}:{PORT}   pid {os.getpid()}   up {up}")
    lines.append(f"  {BOLD}Admin{RESET}    {GREEN}http://127.0.0.1:{PORT}/admin{RESET}")
    if first_password:
        lines.append(
            f"           {YELLOW}first-run password: {first_password}{RESET} {DIM}(change it in the panel){RESET}"
        )
    lines.append("")
    lines.append(f"  {BOLD}Requests{RESET}")
    lines.append(
        f"    total {stats['total']:>6}     in flight {stats['in_flight']:>2}"
        f"     data {human_bytes(stats['bytes_sent'])}"
    )
    lines.append(
        f"    {GREEN}2xx {st.get("2xx", 0):>5}{RESET}   {CYAN}3xx {st.get("3xx", 0):>5}{RESET}   "
        f"{YELLOW}4xx {st.get("4xx", 0):>5}{RESET}   {RED}5xx {st.get("5xx", 0):>5}{RESET}"
    )
    lines.append(
        f"    unique clients {stats['unique_clients']:>3}"
        + (
            "   " + ", ".join(f"{ip}×{n}" for ip, n in stats["top_clients"])
            if stats["top_clients"]
            else ""
        )
    )
    lines.append("")
    lines.append(f"  {BOLD}Recent{RESET}")
    if stats["recent"]:
        for r in stats["recent"][:8]:
            stamp = time.strftime("%H:%M:%S", time.localtime(r["time"]))
            row = f"{stamp}  {r['method']:4} {r['path'][:34]:34} {r['status']}  {r['client']}"
            lines.append(f"    {DIM}{row}{RESET}")
    else:
        lines.append(f"    {DIM}waiting for the first request…{RESET}")
    lines.append("")
    lines.append(f"  {DIM}Enter to refresh · q then Enter (or Ctrl+C) to stop{RESET}")
    return CLEAR + "\n".join(lines) + "\n"


def main() -> int:
    # Werkzeug's per-request log lines would scribble over the dashboard.
    logging.getLogger("werkzeug").setLevel(logging.ERROR)

    app = create_app()
    stats = app.extensions["atlasmap_stats"]
    config = app.extensions["atlasmap_config"]

    try:
        server = make_server(HOST, PORT, app, threaded=True)
    except OSError as exc:
        print(f"Could not bind {HOST}:{PORT}: {exc}", file=sys.stderr)
        print("Set ATLASMAP_PORT to a free port and try again.", file=sys.stderr)
        return 1

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    addrs = {"lan": lan_ip(), "public": public_ip()}

    out = sys.stdout
    try:
        while True:
            out.write(render(stats.snapshot(), addrs, config.initial_password))
            out.flush()
            # Block here until the user acts — the screen never moves on its own.
            line = sys.stdin.readline()
            if line == "" or line.strip().lower() == "q":  # EOF (Ctrl+D) or quit
                break
    except KeyboardInterrupt:
        pass
    finally:
        out.write("\n")
        out.flush()
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
