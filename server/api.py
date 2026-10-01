"""The two endpoints the frontend needs: turn a payload into a file, and back.

No graph logic lives here. The payload is opaque JSON on the way through — the
frontend owns its shape, so a change to the graph model needs no server change.
"""

from __future__ import annotations

import io

from flask import Blueprint, Response, current_app, jsonify, request, send_file

from .account import effective_config
from .accounts import session_user
from .atlasfile import FormatError, PasswordError, decode_any, encode_v2
from .filenames import download_name

api = Blueprint("api", __name__, url_prefix="/api")


@api.after_request
def no_store(response: Response) -> Response:
    """Both directions carry decrypted graph data; keep it out of caches."""
    response.headers["Cache-Control"] = "no-store"
    return response


@api.errorhandler(413)
def too_large(_error: Exception) -> tuple[Response, int]:
    return fail("File is larger than this build will accept.", 413)


@api.get("/config")
def client_config() -> Response:
    """Keybinds and client settings for every page load. Nothing secret.

    Signed in, the user's own settings are layered over the admin's
    (server/account.py), and `account` says so: the app then keeps the look
    picked with V in the account rather than in this browser.
    """
    user = session_user()
    if user is None:
        return jsonify(current_app.extensions["pleiades_config"].client_values())
    _, effective, _ = effective_config(user["id"])
    return jsonify({**effective, "account": True})


def fail(message: str, status: int) -> tuple[Response, int]:
    return jsonify(error=message), status


@api.post("/save")
def save() -> Response | tuple[Response, int]:
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return fail("Expected a JSON object body.", 400)

    password = body.get("password") or ""
    payload = body.get("payload")
    if not isinstance(password, str):
        return fail("`password` must be a string.", 400)
    if not isinstance(payload, dict):
        return fail("`payload` must be a JSON object.", 400)

    try:
        blob = encode_v2(payload, password)
    except FormatError as exc:
        return fail(str(exc), 400)

    return send_file(
        io.BytesIO(blob),
        mimetype="application/octet-stream",
        as_attachment=True,
        download_name=download_name(body.get("filename")),
    )


@api.post("/open")
def open_file() -> Response | tuple[Response, int]:
    upload = request.files.get("file")
    password = request.form.get("password") or ""
    if upload is None:
        return fail("No file uploaded.", 400)

    try:
        payload = decode_any(upload.read(), password)
    except PasswordError as exc:
        return fail(str(exc), 401)
    except FormatError as exc:
        return fail(str(exc), 400)

    return jsonify(payload)
