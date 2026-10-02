/**
 * The map as a Yjs document (context/MOONSHOT.md, "The shared document").
 * Pure: no DOM, no three.js — it runs in Node, and the server mirrors it in
 * server/ydoc.py (the two must agree; ydoc-vectors.json pins that).
 *
 *   nodes: Y.Map<id, Y.Map>   notes is a Y.Text (live merge); everything else plain
 *   edges: Y.Map<id, Y.Map>   plain values
 *   meta:  Y.Map              every other top-level payload key (camera, envelope, unknown)
 *
 * Iteration order of a Y.Map is not guaranteed to match across peers, so
 * nothing may depend on node order in a materialised payload.
 */
import * as Y from 'yjs'
import { migrate } from './schema.js'

/** Transaction origin for an Open or New: the doc filled from a payload. */
export const LOAD = 'load'

export function nodeToY(node) {
  const map = new Y.Map()
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'notes') map.set(key, value)
  }
  map.set('notes', new Y.Text(typeof node.notes === 'string' ? node.notes : ''))
  return map
}

export function edgeToY(edge) {
  const map = new Y.Map()
  for (const [key, value] of Object.entries(edge)) map.set(key, value)
  return map
}

export function payloadToDoc(input, doc = new Y.Doc()) {
  const { nodes = [], edges = [], ...rest } = migrate(input)
  doc.transact(() => {
    const yNodes = doc.getMap('nodes')
    const yEdges = doc.getMap('edges')
    const meta = doc.getMap('meta')
    for (const node of nodes) yNodes.set(node.id, nodeToY(node))
    for (const edge of edges) yEdges.set(edge.id, edgeToY(edge))
    for (const [key, value] of Object.entries(rest)) meta.set(key, value)
  }, LOAD)
  return doc
}

const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)

/**
 * The edges every peer agrees to show. Two people can link the same pair at
 * the same moment, or link a star someone else just deleted; the doc keeps
 * both, and this decides, the same way everywhere: no edge with a missing
 * end, no self-loop, and of two links between the same pair (either
 * direction) the one with the smaller id.
 */
export function keptEdges(nodeIds, edges) {
  const byPair = new Map()
  for (const edge of edges) {
    if (edge.from === edge.to || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue
    const key = pairKey(edge.from, edge.to)
    const held = byPair.get(key)
    if (!held || edge.id < held.id) byPair.set(key, edge)
  }
  const kept = new Map()
  for (const edge of byPair.values()) kept.set(edge.id, edge)
  return kept
}

export function docToPayload(doc) {
  const nodes = []
  for (const node of doc.getMap('nodes').values()) nodes.push(node.toJSON())
  const ids = new Set(nodes.map((node) => node.id))
  const all = []
  for (const edge of doc.getMap('edges').values()) all.push(edge.toJSON())
  return { ...doc.getMap('meta').toJSON(), nodes, edges: [...keptEdges(ids, all).values()] }
}
