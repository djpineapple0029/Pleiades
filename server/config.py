"""The server's config file: keybinds, client settings, server and admin settings.

One TOML file (default `config/atlasmap.toml`, or `$ATLASMAP_CONFIG`) holds
everything the admin panel edits. What may go in it, with ranges and defaults,
is `settings_schema.json` — the frontend imports the same file, so the two can
never disagree about a default.

The file is created on first run with every default written out and a random
admin password (printed once; only its hash is stored). It is re-read when its
mtime changes, so a hand edit applies without a restart. Saves from the panel
go through tomlkit, which keeps the comments and layout of a hand-edited file.

A value that fails validation never stops the server: a bad setting falls
back to its default, a bad keybind set falls back to the default keymap, and
each fallback is listed in `problems` for the panel to show.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import math
import os
import secrets
import sys
import tempfile
import threading
import time
from copy import deepcopy
from pathlib import Path
from typing import Any

import tomlkit
import tomlkit.items
from tomlkit.exceptions import TOMLKitError

SCHEMA_PATH = Path(__file__).resolve().parent / "settings_schema.json"
SCHEMA: dict = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "config" / "atlasmap.toml"

ACTIONS: dict[str, dict] = {action["id"]: action for action in SCHEMA["keybinds"]}
SETTINGS: dict[tuple[str, str], dict] = {(s["section"], s["key"]): s for s in SCHEMA["settings"]}
SECTIONS: list[str] = list(dict.fromkeys(s["section"] for s in SCHEMA["settings"]))

MAX_BINDINGS = 3
MIN_PASSWORD_LENGTH = 8
# How often a request may stat the file to notice a hand edit.
RELOAD_CHECK_SECONDS = 1.0


# --- Chords -------------------------------------------------------------------

MODIFIERS = {"mod": "Mod", "ctrl": "Ctrl", "cmd": "Cmd", "alt": "Alt", "shift": "Shift"}
MODIFIER_ORDER = ["Mod", "Ctrl", "Cmd", "Alt", "Shift"]
NAMED_KEYS = {
    name.lower(): name
    for name in [
        "Space", "Shift", "Enter", "Tab", "Backspace", "Delete", "Insert", "Home", "End",
        "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape",
        *(f"F{n}" for n in range(1, 13)),
    ]
}
# Matched by the character typed (`event.key`), so they follow the layout.
# `+` is the separator and is left out.
CHAR_KEYS = set("/?[]{};:'\",.<>-_=`~!@#$%^&*()|\\")

# Chords a page can't reliably take from the browser (V2.md §3.5), and ones
# that would reload or close the tab. Each is listed per platform: Mod stands
# for both Ctrl and Cmd, so a Mod chord is refused if either half is here.
FORBIDDEN = {
    **{f"Ctrl+{k}": "the browser keeps it" for k in ["N", "T", "W", "R", "L", "I", "Shift+N", "Shift+T", "Shift+C", "Shift+P", "Shift+E", "Shift+R", "Shift+W"]},
    **{f"Cmd+{k}": "the browser keeps it" for k in ["N", "T", "W", "Q", "R", "L", "I", "H", "M", "Y", ",", "Shift+N", "Shift+T", "Shift+C", "Shift+P", "Shift+R", "Shift+W"]},
    **{f"{m}+{d}": "switches browser tabs" for m in ["Ctrl", "Cmd"] for d in "0123456789"},
    "F5": "reloads the page",
    "F11": "the browser keeps it",
    "F12": "opens developer tools",
    "Escape": "always releases the pointer; pages can't take it",
}


class ChordError(ValueError):
    pass


def parse_chord(text: object) -> dict:
    """`"Mod+Shift+S"` → `{"mods": {...}, "kind": "letter", "key": "S"}`, or raises ChordError."""
    if not isinstance(text, str) or not text.strip():
        raise ChordError("empty key")
    parts = [part.strip() for part in text.strip().split("+")]
    if any(not part for part in parts):
        raise ChordError(f"{text!r}: stray '+' (the + key itself can't be bound)")
    *mod_parts, key_part = parts
    mods: set[str] = set()
    for part in mod_parts:
        name = MODIFIERS.get(part.lower())
        if name is None:
            raise ChordError(f"{text!r}: {part!r} is not a modifier (use Mod, Ctrl, Cmd, Alt, Shift)")
        if name in mods:
            raise ChordError(f"{text!r}: {name} given twice")
        mods.add(name)
    if "Mod" in mods and ({"Ctrl", "Cmd"} & mods):
        raise ChordError(f"{text!r}: Mod already means Ctrl or Cmd")

    if len(key_part) == 1 and key_part.isascii() and key_part.isalpha():
        kind, key = "letter", key_part.upper()
    elif len(key_part) == 1 and key_part.isdigit():
        kind, key = "digit", key_part
    elif key_part.lower() in NAMED_KEYS:
        kind, key = "named", NAMED_KEYS[key_part.lower()]
    elif key_part in CHAR_KEYS:
        kind, key = "char", key_part
        # The character already says whether Shift was down: `?` is Shift+/
        # on a US layout and something else elsewhere. Matching ignores it.
        mods.discard("Shift")
    else:
        raise ChordError(f"{text!r}: unknown key {key_part!r}")
    if key == "Shift" and mods:
        raise ChordError(f"{text!r}: Shift as a key takes no modifiers")
    return {"mods": mods, "kind": kind, "key": key}


def chord_text(chord: dict) -> str:
    return "+".join([m for m in MODIFIER_ORDER if m in chord["mods"]] + [chord["key"]])


def chord_variants(chord: dict) -> set[str]:
    """Every concrete chord this one fires on, with Mod split into Ctrl and Cmd."""
    mods = chord["mods"]
    if "Mod" in mods:
        rest = mods - {"Mod"}
        return {chord_text({**chord, "mods": rest | {m}}) for m in ("Ctrl", "Cmd")}
    return {chord_text(chord)}


def validate_keybinds(raw: object) -> tuple[dict[str, list[str]], list[str]]:
    """Checks a whole keymap. Returns (canonical keymap, errors). Missing actions get their default."""
    errors: list[str] = []
    if not isinstance(raw, dict):
        return default_keybinds(), ["keybinds must be a table of action = [keys]"]
    for name in raw:
        if name not in ACTIONS:
            errors.append(f"keybinds.{name}: no such action")

    result: dict[str, list[str]] = {}
    parsed: dict[str, list[dict]] = {}
    for action_id, action in ACTIONS.items():
        value = raw.get(action_id, action["default"])
        where = f"keybinds.{action_id}"
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list):
            errors.append(f"{where}: must be a list of keys")
            continue
        chords: list[dict] = []
        seen: set[str] = set()
        for item in value:
            try:
                chord = parse_chord(item)
            except ChordError as exc:
                errors.append(f"{where}: {exc}")
                continue
            text = chord_text(chord)
            if text in seen:
                continue
            seen.add(text)
            problem = chord_problem(action, chord)
            if problem:
                errors.append(f"{where}: {text}: {problem}")
                continue
            chords.append(chord)
        if len(chords) > MAX_BINDINGS:
            errors.append(f"{where}: at most {MAX_BINDINGS} keys")
        if action.get("required") and not chords and not any(e.startswith(where) for e in errors):
            errors.append(f"{where}: needs at least one key (it's the only way out of that mode)")
        parsed[action_id] = chords
        result[action_id] = [chord_text(c) for c in chords]

    # Two actions that can both be live at once can't share a chord.
    owners: dict[str, list[str]] = {}
    for action_id, chords in parsed.items():
        for chord in chords:
            for variant in chord_variants(chord):
                owners.setdefault(variant, []).append(action_id)
    reported: set[tuple[str, str]] = set()
    for variant, ids in owners.items():
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                if a == b or (a, b) in reported:
                    continue
                shared = set(ACTIONS[a]["contexts"]) & set(ACTIONS[b]["contexts"])
                if shared:
                    reported.add((a, b))
                    # On both, since either one may be the change.
                    when = " / ".join(sorted(shared))
                    for mine, theirs in ((a, b), (b, a)):
                        errors.append(
                            f"keybinds.{mine}: {variant} clashes with "
                            f"{ACTIONS[theirs]['label'].lower()} ({theirs}) while {when}"
                        )
    return result, errors


def chord_problem(action: dict, chord: dict) -> str | None:
    mods, kind, key = chord["mods"], chord["kind"], chord["key"]
    for variant in chord_variants(chord):
        if variant in FORBIDDEN:
            return FORBIDDEN[variant]
    if action.get("movement"):
        if mods:
            return "flight keys take no modifiers"
        if kind == "char":
            return "flight keys are by position; use a letter, digit or named key"
        return None
    if key == "Shift":
        return "Shift on its own can only be a flight key"
    if "Shift" in mods and not (mods & {"Mod", "Ctrl", "Cmd", "Alt"}):
        return "Shift+key without Ctrl/Cmd/Alt fires while flying down; add a modifier"
    return None


def default_keybinds() -> dict[str, list[str]]:
    return {action_id: list(action["default"]) for action_id, action in ACTIONS.items()}


# --- Settings -----------------------------------------------------------------


def validate_setting(spec: dict, value: object) -> tuple[Any, str | None]:
    where = f"{spec['section']}.{spec['key']}"
    kind = spec["type"]
    if kind == "boolean":
        if isinstance(value, bool):
            return value, None
        return None, f"{where}: must be true or false"
    if kind in ("number", "integer"):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None, f"{where}: must be a number"
        if kind == "integer" and not float(value).is_integer():
            return None, f"{where}: must be a whole number"
        if not math.isfinite(value) or not spec["min"] <= value <= spec["max"]:
            return None, f"{where}: must be between {spec['min']} and {spec['max']}"
        return (int(value) if kind == "integer" else float(value)), None
    if kind == "networks":
        if isinstance(value, str):
            value = [line for line in value.replace(",", "\n").splitlines() if line.strip()]
        if not isinstance(value, list) or not value:
            return None, f"{where}: needs at least one network"
        networks = []
        for item in value:
            try:
                networks.append(str(ipaddress.ip_network(str(item).strip(), strict=False)))
            except ValueError:
                return None, f"{where}: {item!r} is not an address or CIDR range"
        return networks, None
    return None, f"{where}: unknown type {kind}"


def default_settings() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {section: {} for section in SECTIONS}
    for (section, key), spec in SETTINGS.items():
        out[section][key] = deepcopy(spec["default"])
    return out


def validate_values(raw: dict, *, strict: bool) -> tuple[dict, list[str]]:
    """Validate `{"keybinds": {...}, "<section>": {...}}`.

    strict (a save from the panel): any error means nothing is applied.
    Lenient (loading the file): each bad value falls back to its default.
    """
    errors: list[str] = []
    keybinds, kb_errors = validate_keybinds(raw.get("keybinds", {}))
    if kb_errors:
        errors += kb_errors
        keybinds = default_keybinds()
    settings = default_settings()
    for section in SECTIONS:
        given = raw.get(section, {})
        if not isinstance(given, dict):
            errors.append(f"{section}: must be a table")
            continue
        for key, value in given.items():
            spec = SETTINGS.get((section, key))
            if spec is None:
                errors.append(f"{section}.{key}: no such setting")
                continue
            clean, error = validate_setting(spec, value)
            if error:
                errors.append(error)
            else:
                settings[section][key] = clean
    return {"keybinds": keybinds, **settings}, errors


# --- Passwords ----------------------------------------------------------------

# scrypt at N=2^15 is ~60 ms here: slow enough to make guessing expensive,
# fast enough that a sign-in doesn't feel it.
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**15, 8, 1


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, maxmem=64 * 1024 * 1024)
    b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${b64(salt)}${b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(
            password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
            maxmem=64 * 1024 * 1024, dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# --- The file -----------------------------------------------------------------

HEADER = """\
AtlasMap server config. Edit it here or at http://<host>:<port>/admin.
Hand edits apply within a second, no restart needed. A value that doesn't
validate falls back to its default and shows up as a problem in the panel.

Keys: optional modifiers Mod (Ctrl or Cmd), Ctrl, Cmd, Alt, Shift, then one
key: a letter, a digit, a symbol like / or ?, or a name: Space, Shift, Enter,
Tab, Backspace, Delete, Insert, Home, End, PageUp, PageDown, ArrowUp,
ArrowDown, ArrowLeft, ArrowRight, F1-F12. Each action takes up to three.
Changes reach a browser the next time it loads the page."""

ADMIN_PASSWORD_NOTE = (
    "To reset a forgotten password, type a new one into `password` in plain\n"
    "text. On the next read it is replaced by `password_hash`."
)


def build_document(values: dict, password_hash: str) -> tomlkit.TOMLDocument:
    doc = tomlkit.document()
    for line in HEADER.splitlines():
        doc.add(tomlkit.comment(line) if line else tomlkit.nl())
    doc.add(tomlkit.nl())

    keybinds = tomlkit.table()
    group = None
    for action in SCHEMA["keybinds"]:
        if action["group"] != group:
            group = action["group"]
            keybinds.add(tomlkit.comment(group))
        keybinds.add(action["id"], commented(values["keybinds"][action["id"]], action["label"]))
    doc.add("keybinds", keybinds)

    for section in SECTIONS:
        table = tomlkit.table()
        if section == "admin":
            for line in ADMIN_PASSWORD_NOTE.splitlines():
                table.add(tomlkit.comment(line))
            table.add("password", "")
            table.add("password_hash", password_hash)
        for (sec, key), spec in SETTINGS.items():
            if sec != section:
                continue
            table.add(key, commented(values[section][key], spec["label"]))
        doc.add(section, table)
    return doc


def commented(value: Any, comment: str | None) -> Any:
    item = tomlkit.item(value)
    if comment:
        item.comment(comment)
    return item


def assign(table: Any, key: str, value: Any) -> None:
    """Set a value, keeping the end-of-line comment a hand edit may have put on it."""
    old = table.get(key) if key in table else None
    comment = old.trivia.comment.lstrip("# ").strip() if isinstance(old, tomlkit.items.Item) else None
    table[key] = commented(value, comment)


def write_atomically(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        # The file holds a password hash: owner-only.
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


class ConfigStore:
    """Thread-safe owner of the config file (Waitress and run.py serve on threads)."""

    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path or os.environ.get("ATLASMAP_CONFIG") or DEFAULT_PATH)
        self.lock = threading.RLock()
        self.values: dict = {}
        self.problems: list[str] = []
        self.password_hash = ""
        # Set only when this process generated the password, for run.py's
        # dashboard; never written anywhere.
        self.initial_password: str | None = None
        self._doc: tomlkit.TOMLDocument | None = None
        self._mtime: float | None = None
        self._checked = 0.0
        self.load()

    # Reading ------------------------------------------------------------------

    def load(self) -> None:
        with self.lock:
            if not self.path.exists():
                self._create()
                return
            try:
                text = self.path.read_text(encoding="utf-8")
                doc = tomlkit.parse(text)
            except (OSError, TOMLKitError) as exc:
                # Keep serving whatever was last good; say why the edit didn't take.
                if not self.values:
                    self.values = validate_values({}, strict=False)[0]
                self.problems = [f"{self.path.name} could not be read, using the last good values: {exc}"]
                self._mtime = self._stat()
                return
            raw = doc.unwrap()
            values, problems = validate_values({k: v for k, v in raw.items() if k != "admin"} | {
                "admin": {k: v for k, v in raw.get("admin", {}).items() if k not in ("password", "password_hash")}
            }, strict=False)
            unknown = [f"{name}: no such section" for name in raw if name not in ("keybinds", *SECTIONS)]
            self._doc = doc
            self.values = values
            self.problems = unknown + problems

            admin = raw.get("admin", {})
            plain = admin.get("password") or ""
            stored = admin.get("password_hash") or ""
            if plain:
                # A hand-typed reset: hash it and take the plain text back out.
                self.password_hash = hash_password(str(plain))
                self._set_admin_secret(self.password_hash)
            elif stored:
                self.password_hash = str(stored)
            else:
                self._generate_password()
            self._mtime = self._stat()

    def _create(self) -> None:
        self.values = validate_values({}, strict=False)[0]
        seeded = os.environ.get("ATLASMAP_TRUSTED_PROXIES")
        if seeded and seeded.isdigit():
            self.values["admin"]["trusted_proxies"] = min(int(seeded), 5)
        self.problems = []
        self._doc = build_document(self.values, "")
        self._generate_password()

    def _generate_password(self) -> None:
        password = secrets.token_urlsafe(12)
        self.initial_password = password
        self.password_hash = hash_password(password)
        self._set_admin_secret(self.password_hash)
        print(
            f"AtlasMap: new admin password for /admin: {password}\n"
            f"          (only its hash is kept, in {self.path}; change it in the panel)",
            file=sys.stderr,
            flush=True,
        )

    def _set_admin_secret(self, password_hash: str) -> None:
        assert self._doc is not None
        admin = self._doc.setdefault("admin", tomlkit.table())
        admin["password"] = ""
        admin["password_hash"] = password_hash
        self._write()

    def _stat(self) -> float | None:
        try:
            return self.path.stat().st_mtime_ns
        except OSError:
            return None

    def refresh(self) -> None:
        """Re-read the file if it changed on disk; cheap enough to call per request."""
        now = time.monotonic()
        if now - self._checked < RELOAD_CHECK_SECONDS:
            return
        with self.lock:
            self._checked = now
            if self._stat() != self._mtime:
                self.load()

    def get(self, section: str, key: str) -> Any:
        self.refresh()
        return self.values[section][key]

    def client_values(self) -> dict:
        """What every browser gets: keybinds and client-scoped settings. Nothing secret."""
        self.refresh()
        out: dict[str, Any] = {"version": SCHEMA["version"], "keybinds": deepcopy(self.values["keybinds"])}
        for (section, key), spec in SETTINGS.items():
            if spec["scope"] == "client":
                out.setdefault(section, {})[key] = self.values[section][key]
        return out

    def all_values(self) -> dict:
        self.refresh()
        return deepcopy(self.values)

    # Writing ------------------------------------------------------------------

    def save(self, raw: dict) -> list[str]:
        """Validate and write a full set of values. Returns errors; nothing is written if any."""
        values, errors = validate_values(raw, strict=True)
        if errors:
            return errors
        with self.lock:
            assert self._doc is not None
            doc = self._doc
            keybinds = doc.setdefault("keybinds", tomlkit.table())
            for action_id, chords in values["keybinds"].items():
                assign(keybinds, action_id, chords)
            for section in SECTIONS:
                table = doc.setdefault(section, tomlkit.table())
                for key, value in values[section].items():
                    assign(table, key, value)
            self._write()
            self.values = values
            self.problems = []
        return []

    def check_password(self, password: str) -> bool:
        with self.lock:
            stored = self.password_hash
        return bool(stored) and verify_password(password, stored)

    def set_password(self, current: str, new: str) -> str | None:
        """Returns an error message, or None when the password was changed."""
        if not self.check_password(current):
            return "The current password is wrong."
        if len(new) < MIN_PASSWORD_LENGTH:
            return f"The new password needs at least {MIN_PASSWORD_LENGTH} characters."
        if new == current:
            return "The new password is the same as the current one."
        with self.lock:
            self.password_hash = hash_password(new)
            self.initial_password = None
            self._set_admin_secret(self.password_hash)
        return None

    def _write(self) -> None:
        assert self._doc is not None
        write_atomically(self.path, tomlkit.dumps(self._doc))
        self._mtime = self._stat()
