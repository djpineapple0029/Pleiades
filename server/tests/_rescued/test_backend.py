"""Session 3 backend verification: crypto round trip + every endpoint path."""
import io, json, sys
sys.path.insert(0, "/Users/dempseypalmer/PycharmProjects/AtlasMap")

from server import create_app
from server.api import download_name
from server.atlasfile import HEADER_SIZE, MAGIC, FormatError, PasswordError, decode, encode

ok = fails = 0
def check(name, cond, extra=""):
    global ok, fails
    if cond: ok += 1; print(f"  pass  {name}")
    else: fails += 1; print(f"  FAIL  {name} {extra}")

PAYLOAD = {
    "nodes": [
        {"id": "n1", "label": "root", "notes": "line one\nline two — ünïcode ✦",
         "links": [], "x": 1.5, "y": -2.25, "z": 0.0, "cluster_color_id": 0, "is_core": True},
        {"id": "n2", "label": "", "notes": "", "links": ["n1"],
         "x": -40.125, "y": 7.0, "z": 3.5, "cluster_color_id": 2, "is_core": False},
    ],
    "edges": [{"id": "e1", "from": "n1", "to": "n2", "directed": False, "label": "why"}],
    "camera": {"position": [0.0, 0.0, 260.0], "rotation": [0.1, -0.2, 0.0]},
}

print("atlasfile")
blob = encode(PAYLOAD, "correct horse battery staple")
check("magic + version header", blob[:4] == MAGIC and blob[4] == 1, blob[:5])
check("round trip is exact", decode(blob, "correct horse battery staple") == PAYLOAD)
check("salt differs per save", encode(PAYLOAD, "pw")[5:21] != encode(PAYLOAD, "pw")[5:21])
check("ciphertext differs per save", encode(PAYLOAD, "pw")[21:] != encode(PAYLOAD, "pw")[21:])

try:
    decode(blob, "wrong password"); check("wrong password raises", False)
except PasswordError: check("wrong password raises PasswordError", True)

for name, bad in [
    ("empty", b""),
    ("short", b"ATL"),
    ("header only", MAGIC + b"\x01" + b"0" * 16),
    ("bad magic", b"NOPE" + blob[4:]),
    ("future version", blob[:4] + bytes([9]) + blob[5:]),
]:
    try:
        decode(bad, "pw"); check(f"rejects {name}", False)
    except FormatError: check(f"rejects {name}", True)
    except PasswordError: check(f"rejects {name} as format not password", False)

# A flipped byte in the token is tampering, not a format problem.
tampered = bytearray(blob); tampered[-3] ^= 0xFF
try:
    decode(bytes(tampered), "correct horse battery staple"); check("detects tampering", False)
except PasswordError: check("detects tampering", True)

# Salt is per-file: a token cannot be read with another file's salt.
other = encode(PAYLOAD, "correct horse battery staple")
spliced = other[:5] + blob[5:21] + other[21:]
try:
    decode(spliced, "correct horse battery staple"); check("salt is bound to token", False)
except PasswordError: check("salt is bound to token", True)

try:
    encode({"x": float("nan")}, "pw"); check("rejects NaN at save", False)
except FormatError: check("rejects NaN at save", True)

check("empty-string password still derives", decode(encode({"a": 1}, ""), "") == {"a": 1})

print("download_name")
for raw, want in [
    ("mine", "mine.atlasmap"), ("mine.atlasmap", "mine.atlasmap"),
    ("../../etc/passwd", "passwd.atlasmap"), ("..\\..\\win.ini", "win.ini.atlasmap"),
    ("", "map.atlasmap"), ("...", "map.atlasmap"), (None, "map.atlasmap"), (42, "map.atlasmap"),
    ('a"b:c*d?', "abcd.atlasmap"), ("my map.atlasmap", "my map.atlasmap"),
    ("地図", "地図.atlasmap"), ("x\r\ny", "xy.atlasmap"), (".hidden", "hidden.atlasmap"),
    ("z" * 300, "z" * 120 + ".atlasmap"),
]:
    got = download_name(raw)
    check(f"name {raw!r} -> {got!r}", got == want, f"wanted {want!r}")

print("endpoints")
app = create_app()
c = app.test_client()

r = c.post("/api/save", json={"password": "pw", "payload": PAYLOAD, "filename": "my map"})
check("save 200", r.status_code == 200, r.status_code)
check("save is attachment", "attachment" in r.headers.get("Content-Disposition", ""), r.headers.get("Content-Disposition"))
check("save names the file", "my map.atlasmap" in r.headers.get("Content-Disposition", ""), r.headers.get("Content-Disposition"))
check("save is no-store", r.headers.get("Cache-Control") == "no-store", r.headers.get("Cache-Control"))
check("save is octet-stream", r.mimetype == "application/octet-stream", r.mimetype)
saved = r.data
check("save bytes decode", decode(saved, "pw") == PAYLOAD)

# The whole point of the session: bytes off /api/save go straight back into /api/open.
r = c.post("/api/open", data={"file": (io.BytesIO(saved), "my map.atlasmap"), "password": "pw"},
           content_type="multipart/form-data")
check("open 200", r.status_code == 200, r.status_code)
check("open round trip is exact", r.get_json() == PAYLOAD, r.get_json())
check("open is no-store", r.headers.get("Cache-Control") == "no-store")

r = c.post("/api/open", data={"file": (io.BytesIO(saved), "m.atlasmap"), "password": "nope"},
           content_type="multipart/form-data")
check("open wrong password is 401", r.status_code == 401, r.status_code)
check("401 carries a message", bool(r.get_json().get("error")), r.get_json())

r = c.post("/api/open", data={"file": (io.BytesIO(b"not an atlasmap file at all"), "m.atlasmap"), "password": "pw"},
           content_type="multipart/form-data")
check("open garbage is 400", r.status_code == 400, r.status_code)

r = c.post("/api/open", data={"password": "pw"}, content_type="multipart/form-data")
check("open without a file is 400", r.status_code == 400, r.status_code)
r = c.post("/api/open", data={"file": (io.BytesIO(saved), "m.atlasmap")}, content_type="multipart/form-data")
check("open without a password is 400", r.status_code == 400, r.status_code)

for name, body in [
    ("no password", {"payload": {}}), ("empty password", {"password": "", "payload": {}}),
    ("no payload", {"password": "pw"}), ("payload is a list", {"password": "pw", "payload": []}),
    ("password is a number", {"password": 1, "payload": {}}),
]:
    r = c.post("/api/save", json=body)
    check(f"save rejects {name}", r.status_code == 400, r.status_code)
    check(f"save {name} answers JSON", r.is_json and "error" in r.get_json(), r.data[:80])

r = c.post("/api/save", data="not json", content_type="application/json")
check("save rejects non-JSON body", r.status_code == 400, r.status_code)

r = c.post("/api/open", data={"file": (io.BytesIO(b"x" * (65 * 1024 * 1024)), "big.atlasmap"), "password": "pw"},
           content_type="multipart/form-data")
check("oversized upload is 413", r.status_code == 413, r.status_code)
check("413 answers JSON", r.is_json and "error" in r.get_json(), r.data[:120])

print(f"\n{ok} passed, {fails} failed")
sys.exit(1 if fails else 0)
