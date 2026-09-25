/**
 * What an HTML export carries. An export has no password, so anyone holding
 * the file can read it in a text editor: it gets an explicit **allowlist** of
 * what the viewer draws, never "everything minus what we remembered to
 * strip". `notes`, `links`, and any field a newer build passed through
 * (`graph.js`'s `passThrough`) stay in the `.atlasmap` file only.
 *
 * Adding a field here is a deliberate act, in the same change that makes the
 * viewer render it (V2.md §2.3.3). Ids stay: star looks and drift-mote phase
 * are hashed from them.
 */
import { envelope } from './schema.js'

const NODE_KEYS = ['id', 'label', 'x', 'y', 'z', 'cluster_color_id', 'blend', 'is_core']
const EDGE_KEYS = ['id', 'from', 'to', 'directed', 'label']

const pick = (object, keys) => Object.fromEntries(keys.filter((k) => k in object).map((k) => [k, object[k]]))

/** `graphPayload` is `graph.toPayload()`; `camera` the saved camera block. */
export function exportPayload(graphPayload, camera) {
  return {
    ...envelope(),
    nodes: graphPayload.nodes.map((node) => pick(node, NODE_KEYS)),
    edges: graphPayload.edges.map((edge) => pick(edge, EDGE_KEYS)),
    camera,
  }
}
