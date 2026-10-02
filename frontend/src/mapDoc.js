/**
 * The open map's Yjs document (context/MOONSHOT.md). Every edit is a
 * transaction on it: `LOCAL` for this tab's commands, `LOAD` for an Open or
 * New (which the bridge ignores — the caller loads the graph directly), and
 * a room's provider for edits from other people.
 */
import * as Y from 'yjs'
import { LOAD, payloadToDoc } from './format/ydoc.js'

export const LOCAL = 'local'

export function createMapDoc() {
  const doc = new Y.Doc()
  const nodes = doc.getMap('nodes')
  const edges = doc.getMap('edges')
  const meta = doc.getMap('meta')

  /** Swaps in another map's content, keeping this Y.Doc (and its observers). */
  function replace(payload) {
    doc.transact(() => {
      for (const map of [nodes, edges, meta]) for (const key of [...map.keys()]) map.delete(key)
    }, LOAD)
    payloadToDoc(payload, doc)
  }

  return {
    doc,
    nodes,
    edges,
    meta,
    LOCAL,
    replace,
    transact: (fn, origin = LOCAL) => doc.transact(fn, origin),
  }
}
