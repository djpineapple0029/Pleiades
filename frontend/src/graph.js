/**
 * Graph model — plain data, no Three.js and no DOM.
 *
 * Node and edge shapes match the `.atlasmap` payload in `atlasmap-build-plan.md`,
 * so persistence is a straight JSON round-trip: `toPayload` hands them over
 * as-is and `load` puts them back. Fields later sessions own (`links`,
 * `directed`) are initialised here, round-tripped verbatim, and otherwise left
 * alone.
 *
 * Node sizes are derived, not stored: `sizeOf` reads a cache that every
 * mutation below throws away, so nothing outside this module has to remember
 * to recompute them. `is_core` is one of their inputs, which is why it changes
 * through `setCore` rather than by assignment.
 *
 * `cluster_color_id` is the other way round — it *is* stored, because it has to
 * survive a re-partition and a reopen to stay stable (see `clustering.js`).
 * `recluster` is the only thing that writes it.
 */

import { computeSizes } from './sizing.js'
import { computeClusters } from './clustering.js'

/** Thrown by `load` when a decrypted payload is not a graph. */
export class PayloadError extends Error {}

// Deliberately strict: `Number(null)`, `Number('')` and `Number(false)` are all
// 0, so coercing here would quietly park a damaged node at the origin instead
// of refusing the file. Every payload this app writes holds real numbers.
function requireFinite(value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PayloadError(`${what} is not a number.`)
  }
  return value
}

function readString(value) {
  return typeof value === 'string' ? value : ''
}

/** Highest `n`/`e` suffix in use, so fresh ids carry on above a loaded file. */
function highestSuffix(ids, prefix) {
  let highest = 0
  const pattern = new RegExp(`^${prefix}(\\d+)$`)
  for (const id of ids) {
    const match = pattern.exec(id)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest
}

export function createGraph() {
  const nodes = new Map()
  const edges = new Map()
  // Incident edge ids per node id, so delete and degree lookups don't scan.
  const incident = new Map()
  let nodeSeq = 0
  let edgeSeq = 0
  // Bumped by every change that can move a node's size: structure, a load, a
  // core flag. Consumers compare it to the value they last saw.
  let revision = 0
  // Bumped by every change worth saving: everything `revision` tracks, plus
  // label/notes text and a manual node move — neither of which affects size
  // or tint, so `revision` must not move for them. `files.js`'s dirty check
  // compares this against the value at the last successful save or open.
  let contentRevision = 0
  let sizes = null // id -> size multiplier, rebuilt on demand
  let clusterCount = 0 // communities that earned a colour in the last run

  function changed() {
    revision++
    contentRevision++
    sizes = null
  }

  /** Bumps only contentRevision — for a change that's worth saving but has no
   *  size/tint effect: a physics run starting or stopping, a manual move. */
  function touchContent() {
    contentRevision++
  }

  // A loaded file can hold ids this counter would otherwise hand out again —
  // ids it did not generate at all, if the file was edited by something else.
  // Skipping over anything taken is cheaper than trusting the counter.
  function mintId(prefix, taken, next) {
    let id
    do id = `${prefix}${next()}`
    while (taken.has(id))
    return id
  }

  function addNode({ x, y, z, label = '', notes = '' }) {
    const id = mintId('n', nodes, () => ++nodeSeq)
    const node = {
      id,
      label,
      notes,
      links: [],
      x,
      y,
      z,
      cluster_color_id: 0,
      is_core: false,
    }
    nodes.set(id, node)
    incident.set(id, new Set())
    changed()
    return node
  }

  /** Returns the new edge, or null if it is a self-loop or already exists. */
  function addEdge(fromId, toId) {
    if (fromId === toId) return null
    if (!nodes.has(fromId) || !nodes.has(toId)) return null
    for (const edgeId of incident.get(fromId)) {
      const existing = edges.get(edgeId)
      if (existing.from === toId || existing.to === toId) return null
    }

    const id = mintId('e', edges, () => ++edgeSeq)
    const edge = { id, from: fromId, to: toId, directed: false, label: '' }
    edges.set(id, edge)
    incident.get(fromId).add(id)
    incident.get(toId).add(id)
    changed()
    return edge
  }

  function removeEdge(id) {
    const edge = edges.get(id)
    if (!edge) return false
    incident.get(edge.from)?.delete(id)
    incident.get(edge.to)?.delete(id)
    edges.delete(id)
    changed()
    return true
  }

  /** Removes the node and every edge touching it. */
  function removeNode(id) {
    if (!nodes.has(id)) return false
    for (const edgeId of [...incident.get(id)]) removeEdge(edgeId)
    incident.delete(id)
    nodes.delete(id)
    changed()
    return true
  }

  /** Assigns label/notes in place (labels.js polls `node.label`, so it must
   *  stay the same object) and marks the map dirty. Never bumps `revision`:
   *  text doesn't change a node's size or tint. */
  function setNodeText(id, label, notes) {
    const node = nodes.get(id)
    if (!node) return false
    node.label = label
    node.notes = notes
    contentRevision++
    return true
  }

  function setEdgeLabel(id, label) {
    const edge = edges.get(id)
    if (!edge) return false
    edge.label = label
    contentRevision++
    return true
  }

  /** Flags or unflags a core node. Returns false if the node does not exist. */
  function setCore(id, value) {
    const node = nodes.get(id)
    if (!node) return false
    if (node.is_core !== Boolean(value)) {
      node.is_core = Boolean(value)
      changed()
    }
    return true
  }

  /**
   * Re-partitions the graph and writes every node's `cluster_color_id`; see
   * `clustering.js`. Returns `{ clusters, moved }`.
   *
   * Deliberately *not* wired into `changed()` the way sizes are. Louvain costs
   * orders of magnitude more than the size BFS, and a partition that shifted
   * the instant a node was connected would recolour the map out from under
   * someone still building it. A Balance run calls this, so the colours and the
   * layout are always the same partition made visible.
   */
  function recluster() {
    const { colors, count } = computeClusters(nodes, edges)
    let moved = 0
    for (const [id, color] of colors) {
      const node = nodes.get(id)
      if (node.cluster_color_id === color) continue
      node.cluster_color_id = color
      moved++
    }
    clusterCount = count
    // Nothing else changed, but the view eases tints off the revision exactly
    // as it eases sizes, so a recolour has to bump it.
    if (moved) changed()
    return { clusters: count, moved }
  }

  /** Size multiplier of the base node radius; see `sizing.js`. 1 for an unknown id. */
  function sizeOf(id) {
    if (!sizes) sizes = computeSizes(nodes, incident, edges)
    return sizes.get(id) ?? 1
  }

  /**
   * The graph as `.atlasmap` payload fields. Copies, not the live objects:
   * physics writes x/y/z on the model every tick, and a save should be a value
   * rather than a view onto a layout still in motion.
   */
  function toPayload() {
    return {
      nodes: [...nodes.values()].map((node) => ({ ...node, links: [...node.links] })),
      edges: [...edges.values()].map((edge) => ({ ...edge })),
    }
  }

  /**
   * Replaces the graph with a decrypted payload's nodes and edges.
   *
   * Everything is validated into local maps before a single field of the live
   * graph is touched, so a payload that turns out to be broken half way through
   * leaves the map the user already had open intact. Throws `PayloadError`.
   */
  function load(payload) {
    if (!payload || typeof payload !== 'object') throw new PayloadError('Payload is not an object.')
    const nodeList = payload.nodes ?? []
    const edgeList = payload.edges ?? []
    if (!Array.isArray(nodeList)) throw new PayloadError('`nodes` is not an array.')
    if (!Array.isArray(edgeList)) throw new PayloadError('`edges` is not an array.')

    const nextNodes = new Map()
    const nextIncident = new Map()
    for (const raw of nodeList) {
      if (!raw || typeof raw !== 'object') throw new PayloadError('A node is not an object.')
      const id = raw.id
      if (typeof id !== 'string' || !id) throw new PayloadError('A node has no id.')
      if (nextNodes.has(id)) throw new PayloadError(`Two nodes share the id ${id}.`)
      nextNodes.set(id, {
        id,
        label: readString(raw.label),
        notes: readString(raw.notes),
        links: Array.isArray(raw.links) ? raw.links.filter((link) => typeof link === 'string') : [],
        x: requireFinite(raw.x, `node ${id} x`),
        y: requireFinite(raw.y, `node ${id} y`),
        z: requireFinite(raw.z, `node ${id} z`),
        cluster_color_id: Number.isInteger(raw.cluster_color_id) ? raw.cluster_color_id : 0,
        is_core: raw.is_core === true,
      })
      nextIncident.set(id, new Set())
    }

    const nextEdges = new Map()
    for (const raw of edgeList) {
      if (!raw || typeof raw !== 'object') throw new PayloadError('An edge is not an object.')
      const { id, from, to } = raw
      if (typeof id !== 'string' || !id) throw new PayloadError('An edge has no id.')
      if (nextEdges.has(id)) throw new PayloadError(`Two edges share the id ${id}.`)
      if (!nextNodes.has(from) || !nextNodes.has(to)) {
        throw new PayloadError(`Edge ${id} joins a node that is not in the file.`)
      }
      // Self-loops and repeats are what `addEdge` refuses to create, so a file
      // holding one is already outside the model's invariants. Dropping it is
      // the only way to load the rest without carrying the breakage in.
      if (from === to) continue
      let duplicate = false
      for (const edgeId of nextIncident.get(from)) {
        const other = nextEdges.get(edgeId)
        if (other.from === to || other.to === to) duplicate = true
      }
      if (duplicate) continue

      nextEdges.set(id, { id, from, to, directed: raw.directed === true, label: readString(raw.label) })
      nextIncident.get(from).add(id)
      nextIncident.get(to).add(id)
    }

    // Validation is done; commit. These three maps are handed out by reference
    // to the view and the physics layer, so they are refilled, never replaced.
    nodes.clear()
    edges.clear()
    incident.clear()
    for (const [id, node] of nextNodes) nodes.set(id, node)
    for (const [id, edge] of nextEdges) edges.set(id, edge)
    for (const [id, set] of nextIncident) incident.set(id, set)
    nodeSeq = highestSuffix(nodes.keys(), 'n')
    edgeSeq = highestSuffix(edges.keys(), 'e')
    // The file's colours are authoritative — a reopened map keeps the clusters
    // it was saved with, and is not re-partitioned until the next Balance. An
    // older file with no colours in it simply reads as unclustered.
    clusterCount = new Set(
      [...nodes.values()].map((node) => node.cluster_color_id).filter(Boolean)
    ).size
    changed()
  }

  return {
    nodes,
    edges,
    addNode,
    addEdge,
    removeNode,
    removeEdge,
    setCore,
    setNodeText,
    setEdgeLabel,
    touchContent,
    sizeOf,
    recluster,
    toPayload,
    load,
    getNode: (id) => nodes.get(id) ?? null,
    getEdge: (id) => edges.get(id) ?? null,
    degree: (id) => incident.get(id)?.size ?? 0,
    get revision() {
      return revision
    },
    get contentRevision() {
      return contentRevision
    },
    /** Clusters in the last partition. 0 until the first Balance run. */
    get clusterCount() {
      return clusterCount
    },
  }
}
