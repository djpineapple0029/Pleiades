"""server/ydoc.py agrees with frontend/src/format/ydoc.js (via the generated vectors)."""

from __future__ import annotations

import base64
import json
import math
from pathlib import Path

import pytest
from pycrdt import Doc

from server.ydoc import doc_to_payload, edge_problem, kept_edges, node_problem, payload_to_doc

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "frontend/tests/fixtures/ydoc-vectors.json").read_text())


def by_id(items):
    return sorted(items, key=lambda item: item["id"])


@pytest.mark.parametrize("name", sorted(VECTORS))
def test_reads_what_yjs_wrote(name):
    vector = VECTORS[name]
    doc = Doc()
    doc.apply_update(base64.b64decode(vector["update"]))
    payload = doc_to_payload(doc)
    expected = vector["payload"]
    assert by_id(payload["nodes"]) == by_id(expected["nodes"])
    assert by_id(payload["edges"]) == by_id(expected["edges"])
    assert payload.get("camera") == expected.get("camera")


@pytest.mark.parametrize("name", sorted(VECTORS))
def test_round_trips_through_python(name):
    payload = VECTORS[name]["payload"]
    back = doc_to_payload(payload_to_doc(payload))
    assert by_id(back["nodes"]) == by_id(payload["nodes"])
    assert by_id(back["edges"]) == by_id(payload["edges"])
    assert {k: v for k, v in back.items() if k not in ("nodes", "edges")} == {
        k: v for k, v in payload.items() if k not in ("nodes", "edges")
    }


def test_python_updates_read_back_the_same_through_a_second_doc():
    payload = VECTORS["small"]["payload"]
    copy = Doc()
    copy.apply_update(payload_to_doc(payload).get_update())
    assert by_id(doc_to_payload(copy)["nodes"]) == by_id(payload["nodes"])


def test_cluster_color_id_comes_back_an_int():
    payload = {"nodes": [{"id": "n1", "x": 0, "y": 0, "z": 0, "cluster_color_id": 4}], "edges": []}
    node = doc_to_payload(payload_to_doc(payload))["nodes"][0]
    assert node["cluster_color_id"] == 4 and isinstance(node["cluster_color_id"], int)


def test_kept_edges_smallest_id_of_a_pair_wins():
    kept = kept_edges({"a", "b"}, [{"id": "e-z", "from": "a", "to": "b"}, {"id": "e-a", "from": "b", "to": "a"}])
    assert list(kept) == ["e-a"]


def test_kept_edges_drops_dangling_and_self_loops():
    assert kept_edges({"a"}, [{"id": "e1", "from": "a", "to": "gone"}, {"id": "e2", "from": "a", "to": "a"}]) == {}


GOOD_NODE = {
    "id": "n1",
    "label": "",
    "notes": "",
    "x": 0.0,
    "y": 0.0,
    "z": 0.0,
    "cluster_color_id": 0,
    "blend": None,
    "is_core": False,
    "is_nexus": False,
    "links": [],
}


def test_valid_node_has_no_problem():
    assert node_problem(GOOD_NODE) is None
    assert node_problem({**GOOD_NODE, "future_field": {"anything": 1}}) is None
    # pycrdt reads numbers back as floats: 3.0 is still a fine colour id.
    assert node_problem({**GOOD_NODE, "cluster_color_id": 3.0}) is None


@pytest.mark.parametrize(
    "patch",
    [
        {"x": math.inf},
        {"x": "1"},
        {"cluster_color_id": -1},  # V2.md §2.1.5: a negative id froze the app
        {"cluster_color_id": 1.5},
        {"blend": [1, 2]},
        {"blend": [0.1, 0.2, 9]},
        {"is_core": "yes"},
        {"links": "https://x"},
        {"label": 5},
        {"label": "x" * 10_001},
    ],
)
def test_bad_node_fields_are_problems(patch):
    assert node_problem({**GOOD_NODE, **patch}) is not None


def test_edge_problems():
    good = {"id": "e1", "from": "a", "to": "b", "directed": False, "label": ""}
    assert edge_problem(good) is None
    assert edge_problem({**good, "from": 3}) is not None
    assert edge_problem({**good, "directed": "no"}) is not None
