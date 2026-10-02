"""The map as a Yjs document, server side (context/MOONSHOT.md). Mirrors
frontend/src/format/ydoc.js; frontend/tests/fixtures/ydoc-vectors.json keeps
the two in step.

Also the shape checks a room runs on every node and edge an update touches,
so a buggy or hostile client can't put something into a map that the app
would then refuse to open.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from typing import Any

from pycrdt import Doc, Map, Text

MAX_TEXT = 10_000  # label length; notes are capped by the frame size instead
MAX_NOTES = 200_000


def payload_to_doc(payload: dict[str, Any]) -> Doc:
    """Like ydoc.js `payloadToDoc`: nodes and edges as maps (notes shared
    text), every other top-level key in `meta`. Doesn't invent a `schema` —
    ydoc.js runs `migrate()`, which leaves a schema-1 payload as it is."""
    doc = Doc()
    nodes = doc.get("nodes", type=Map)
    edges = doc.get("edges", type=Map)
    meta = doc.get("meta", type=Map)
    rest = {k: v for k, v in payload.items() if k not in ("nodes", "edges")}
    with doc.transaction(origin="load"):
        for node in payload.get("nodes", []):
            target = Map()
            nodes[node["id"]] = target
            for key, value in node.items():
                if key != "notes":
                    target[key] = value
            notes = node.get("notes")
            target["notes"] = Text(notes if isinstance(notes, str) else "")
        for edge in payload.get("edges", []):
            target = Map()
            edges[edge["id"]] = target
            for key, value in edge.items():
                target[key] = value
        for key, value in rest.items():
            meta[key] = value
    return doc


def _pair(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


def kept_edges(node_ids: set[str], edges: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """The edges every peer agrees to show: no missing end, no self-loop, and
    of two links between the same pair (either direction) the smaller id."""
    by_pair: dict[tuple[str, str], dict[str, Any]] = {}
    for edge in edges:
        a, b = edge.get("from"), edge.get("to")
        if not isinstance(a, str) or not isinstance(b, str) or a == b or a not in node_ids or b not in node_ids:
            continue
        key = _pair(a, b)
        held = by_pair.get(key)
        if held is None or edge["id"] < held["id"]:
            by_pair[key] = edge
    return {edge["id"]: edge for edge in by_pair.values()}


def _int_if_integral(value: Any) -> Any:
    return int(value) if isinstance(value, float) and value.is_integer() else value


def doc_to_payload(doc: Doc) -> dict[str, Any]:
    nodes_map = doc.get("nodes", type=Map)
    edges_map = doc.get("edges", type=Map)
    meta = doc.get("meta", type=Map).to_py() or {}
    nodes = []
    for node in (nodes_map.to_py() or {}).values():
        # Yrs reads every number back as a float; the colour id is an index.
        if "cluster_color_id" in node:
            node["cluster_color_id"] = _int_if_integral(node["cluster_color_id"])
        nodes.append(node)
    ids = {node["id"] for node in nodes}
    edges = list(kept_edges(ids, (edges_map.to_py() or {}).values()).values())
    return {**meta, "nodes": nodes, "edges": edges}


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def node_problem(node: dict[str, Any]) -> str | None:
    """None if a node is something the app can open, else a short reason."""
    for axis in ("x", "y", "z"):
        if not _finite(node.get(axis)):
            return f"{axis} is not a finite number"
    label = node.get("label", "")
    if not isinstance(label, str) or len(label) > MAX_TEXT:
        return "label is not a string of at most 10 000 characters"
    notes = node.get("notes", "")
    if not isinstance(notes, str) or len(notes) > MAX_NOTES:
        return "notes too long"
    colour = node.get("cluster_color_id", 0)
    if not _finite(colour) or colour < 0 or float(colour) != int(colour):
        return "cluster_color_id is not a non-negative integer"
    blend = node.get("blend")
    if blend is not None and not (
        isinstance(blend, list) and len(blend) == 3 and all(_finite(v) and 0 <= v <= 1 for v in blend)
    ):
        return "blend is not three channels on 0..1"
    for flag in ("is_core", "is_nexus"):
        if not isinstance(node.get(flag, False), bool):
            return f"{flag} is not a boolean"
    links = node.get("links", [])
    if not isinstance(links, list) or not all(isinstance(link, str) for link in links):
        return "links is not a list of strings"
    return None


def edge_problem(edge: dict[str, Any]) -> str | None:
    """None if an edge is something the app can open, else a short reason."""
    if not isinstance(edge.get("from"), str) or not isinstance(edge.get("to"), str):
        return "an end is not an id"
    if not isinstance(edge.get("directed", False), bool):
        return "directed is not a boolean"
    label = edge.get("label", "")
    if not isinstance(label, str) or len(label) > MAX_TEXT:
        return "label is not a string of at most 10 000 characters"
    return None
