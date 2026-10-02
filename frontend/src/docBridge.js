/**
 * Doc → graph, view and physics: the one path every change takes, whoever
 * made it (context/MOONSHOT.md, "One edit path"). commands.js writes the doc;
 * this applies it. The sync rules are the ones commands.js used to encode:
 * nodes added/removed → syncNodes; edges → syncEdges; positions → syncNodes +
 * updateEdgePositions; anything structural, positional or a change of kind
 * (star/core/nexus) → physics.invalidate. Text changes need none of it.
 *
 * Local positions snap (a move, an undo); remote ones fly, through
 * physics.flyTo, so someone else's Balance or move eases in.
 *
 * Edges are reconciled as a whole through keptEdges after every change, so a
 * link whose star was deleted concurrently, or a second link between the same
 * pair, never reaches the graph — on any peer.
 */
import { LOAD, keptEdges } from './format/ydoc.js'

const OWNED = new Set([
  'id',
  'label',
  'notes',
  'x',
  'y',
  'z',
  'cluster_color_id',
  'blend',
  'is_core',
  'is_nexus',
])
const sameBlend = (a, b) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]))

export function createDocBridge({
  mapDoc,
  graph,
  view,
  physics,
  onRemoved = () => {},
  onRemoteChange = () => {},
}) {
  const { doc, nodes: yNodes, edges: yEdges } = mapDoc

  function reconcileNode(id, local, flights, counters) {
    const ynode = yNodes.get(id)
    const current = graph.getNode(id)
    if (!ynode) {
      const removed = current ? graph.removeNode(id) : null
      if (removed) {
        counters.structure = true
        onRemoved({ kind: 'node', id, local })
        // Its links went with it, inside graph.removeNode.
        for (const edge of removed.edges) {
          counters.edgesDropped = true
          onRemoved({ kind: 'edge', id: edge.id, local })
        }
      }
      return
    }
    const plain = ynode.toJSON()
    if (!current) {
      const defaults = {
        label: '',
        notes: '',
        cluster_color_id: 0,
        blend: null,
        is_core: false,
        is_nexus: false,
      }
      const node = { ...defaults, ...plain }
      node.links = Array.isArray(plain.links) ? plain.links : []
      graph.restoreNode({ node, edges: [] })
      counters.structure = true
      return
    }
    const label = plain.label ?? ''
    const notes = plain.notes ?? ''
    if (current.label !== label || current.notes !== notes) graph.setNodeText(id, label, notes)
    if (current.is_core !== (plain.is_core === true) || current.is_nexus !== (plain.is_nexus === true)) {
      graph.setNexus(id, false)
      graph.setCore(id, plain.is_core === true)
      if (plain.is_nexus === true) graph.setNexus(id, true)
      counters.kind = true
    }
    const colour = Number.isInteger(plain.cluster_color_id) ? plain.cluster_color_id : 0
    const blend = plain.blend ?? null
    if (colour !== current.cluster_color_id || !sameBlend(blend, current.blend))
      counters.layout.set(id, { colour, blend })
    if (current.x !== plain.x || current.y !== plain.y || current.z !== plain.z) {
      if (local) {
        graph.setNodePosition(id, plain.x, plain.y, plain.z)
        counters.snapped = true
      } else flights.set(id, [plain.x, plain.y, plain.z])
    }
    const extra = {}
    for (const [key, value] of Object.entries(plain)) if (!OWNED.has(key)) extra[key] = value
    graph.setNodeFields(id, extra)
  }

  function reconcileEdges(local) {
    const all = []
    for (const yedge of yEdges.values()) all.push(yedge.toJSON())
    const kept = keptEdges(new Set(graph.nodes.keys()), all)
    let changed = false
    for (const id of [...graph.edges.keys()]) {
      const want = kept.get(id)
      const have = graph.getEdge(id)
      if (
        !want ||
        want.from !== have.from ||
        want.to !== have.to ||
        (want.directed === true) !== have.directed
      ) {
        graph.removeEdge(id)
        changed = true
        if (!want) onRemoved({ kind: 'edge', id, local })
      } else if ((want.label ?? '') !== have.label) graph.setEdgeLabel(id, want.label ?? '')
    }
    for (const [id, edge] of kept) {
      if (graph.getEdge(id)) continue
      graph.restoreEdge({ ...edge, label: edge.label ?? '', directed: edge.directed === true })
      changed = true
    }
    return changed
  }

  function onTransaction({ nodeIds, edgesTouched }, txn) {
    const local = txn.local
    const flights = new Map()
    const counters = { structure: false, edgesDropped: false, kind: false, snapped: false, layout: new Map() }
    for (const id of nodeIds) reconcileNode(id, local, flights, counters)
    if (counters.layout.size) {
      const positions = new Map()
      const colors = new Map()
      const blends = new Map()
      for (const [id, { colour, blend }] of counters.layout) {
        const node = graph.getNode(id)
        positions.set(id, [node.x, node.y, node.z])
        colors.set(id, colour)
        blends.set(id, blend)
      }
      graph.applyLayout({ positions, colors, blends, clusterCount: undefined })
    }
    const reconciled = edgesTouched || counters.structure ? reconcileEdges(local) : false
    const edgesChanged = reconciled || counters.edgesDropped
    if (counters.structure || counters.snapped) view.syncNodes()
    if (edgesChanged) view.syncEdges()
    if (counters.snapped) view.updateEdgePositions()
    if (flights.size) physics.flyTo(flights)
    else if (counters.structure || counters.kind || edgesChanged || counters.snapped) physics.invalidate()
    if (!local)
      onRemoteChange({ nodeIds, edgeIds: new Set(edgesTouched ? yEdges.keys() : []), origin: txn.origin })
  }

  // Both roots' deep events, gathered per transaction and handled once at its
  // end. What they touched is read as they arrive: an event's path is only
  // meaningful while its observer is being called.
  const pending = new Map() // transaction -> { nodeIds, edgesTouched }
  function touched(txn) {
    let entry = pending.get(txn)
    if (!entry) pending.set(txn, (entry = { nodeIds: new Set(), edgesTouched: false }))
    return entry
  }
  const onNodes = (events, txn) => {
    if (txn.origin === LOAD) return
    const { nodeIds } = touched(txn)
    for (const event of events) {
      if (event.target === yNodes) for (const key of event.changes.keys.keys()) nodeIds.add(key)
      else nodeIds.add(event.path[0])
    }
  }
  const onEdges = (events, txn) => {
    if (txn.origin === LOAD) return
    touched(txn).edgesTouched = true
  }
  yNodes.observeDeep(onNodes)
  yEdges.observeDeep(onEdges)
  const afterTransaction = (txn) => {
    const entry = pending.get(txn)
    if (!entry) return
    pending.delete(txn)
    onTransaction(entry, txn)
  }
  doc.on('afterTransaction', afterTransaction)

  return {
    dispose() {
      yNodes.unobserveDeep(onNodes)
      yEdges.unobserveDeep(onEdges)
      doc.off('afterTransaction', afterTransaction)
    },
  }
}
