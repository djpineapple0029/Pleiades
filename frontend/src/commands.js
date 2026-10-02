/**
 * Every edit to the map, as a transaction on its Yjs doc (`mapDoc.js`).
 * `docBridge.js` applies each one to the graph and the scene — the sync
 * recipe that used to live here (which view and physics calls follow which
 * change) lives there now — and `undo.js` turns each command into one undo
 * step of this tab's own edits (context/MOONSHOT.md).
 *
 * Commands read the graph to decide what to do and name it, and write only
 * the doc. A command that can't apply returns its "nothing happened" value
 * (null or false) and records nothing; so does every edit while `canEdit()`
 * says no.
 *
 * A Balance or orbit moves the graph frame by frame (physics.js); the doc
 * hears about the run once, when it settles — one transaction, one undo
 * step, filed where the stack stood when the run started, so edits made
 * while it ran undo first.
 *
 * No DOM and no three.js, so it runs in Node against stubs. The viewer never
 * imports it: an exported map has no edits to undo.
 */

import { nodeToY, edgeToY } from './format/ydoc.js'
import { randomId, nodeName } from './ids.js'

const sameBlend = (a, b) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]))

export function createCommands({ graph, physics, mapDoc, undo, newId = randomId, canEdit = () => true }) {
  const { nodes: yNodes, edges: yEdges } = mapDoc

  function edgeName(edge) {
    const ends = `${nodeName(graph.getNode(edge.from))} — ${nodeName(graph.getNode(edge.to))}`
    return edge.label ? `edge ${edge.label} · ${ends}` : `edge ${ends}`
  }

  const blankNode = (id, { x, y, z, label = '', notes = '' }) => ({
    id,
    label,
    notes,
    links: [],
    x,
    y,
    z,
    cluster_color_id: 0,
    blend: null,
    is_core: false,
    is_nexus: false,
  })

  // A node's kind is its two flags together — star, core or nexus — since
  // the two exclude each other.
  function setKind(id, { core, nexus }) {
    const ynode = yNodes.get(id)
    ynode.set('is_core', core && !nexus)
    ynode.set('is_nexus', nexus)
  }

  function setPosition(ynode, [x, y, z]) {
    if (ynode.get('x') !== x) ynode.set('x', x)
    if (ynode.get('y') !== y) ynode.set('y', y)
    if (ynode.get('z') !== z) ynode.set('z', z)
  }

  // --- Commands ---

  function spawn({ x, y, z }) {
    if (!canEdit()) return null
    const id = newId('n', graph.nodes)
    undo.step('new node', () => yNodes.set(id, nodeToY(blankNode(id, { x, y, z }))))
    return graph.getNode(id)
  }

  /** Returns the new edge, or null for a self-loop, a missing end or a pair already linked. */
  function connect(fromId, toId) {
    if (!canEdit() || fromId === toId || !graph.getNode(fromId) || !graph.getNode(toId)) return null
    for (const other of graph.neighbours(fromId)) if (other === toId) return null
    const id = newId('e', graph.edges)
    const edge = { id, from: fromId, to: toId, directed: false, label: '' }
    undo.step(`link ${edgeName(edge)}`, () => yEdges.set(id, edgeToY(edge)))
    return graph.getEdge(id)
  }

  function deleteNode(id) {
    const node = graph.getNode(id)
    if (!canEdit() || !node) return false
    const links = graph.degree(id)
    const label = `delete node ${nodeName(node)}${links ? ` (${links} link${links === 1 ? '' : 's'})` : ''}`
    // Deleted explicitly, not left dangling, so undoing the delete brings them back.
    const touching = [...graph.edges.values()].filter((edge) => edge.from === id || edge.to === id)
    undo.step(label, () => {
      for (const edge of touching) yEdges.delete(edge.id)
      yNodes.delete(id)
    })
    return true
  }

  function deleteEdge(id) {
    const edge = graph.getEdge(id)
    if (!canEdit() || !edge) return false
    undo.step(`delete ${edgeName(edge)}`, () => yEdges.delete(id))
    return true
  }

  function replaceText(ytext, value) {
    if (ytext.toString() === value) return
    ytext.delete(0, ytext.length)
    ytext.insert(0, value)
  }

  function setNodeText(id, label, notes) {
    const node = graph.getNode(id)
    if (!canEdit() || !node || (node.label === label && node.notes === notes)) return false
    undo.step(`edit node ${nodeName(node)}`, () => {
      const ynode = yNodes.get(id)
      if (ynode.get('label') !== label) ynode.set('label', label)
      replaceText(ynode.get('notes'), notes)
    })
    return true
  }

  /**
   * A live notes session: typing goes straight into the shared text, and
   * the whole session is one undo step. `{ text, end() }`, or null. Each
   * keystroke must go in through `mapDoc.transact` (origin LOCAL): an edit
   * made outside one is nobody's, and undo never sees it.
   */
  function editNotes(id) {
    const node = graph.getNode(id)
    if (!canEdit() || !node) return null
    const session = undo.group(`edit node ${nodeName(node)}`)
    return { text: yNodes.get(id).get('notes'), end: () => session.end() }
  }

  function setEdgeLabel(id, label) {
    const edge = graph.getEdge(id)
    if (!canEdit() || !edge || edge.label === label) return false
    undo.step(`edit ${edgeName(edge)}`, () => yEdges.get(id).set('label', label))
    return true
  }

  function toggleCore(id) {
    const node = graph.getNode(id)
    if (!canEdit() || !node) return false
    const core = !node.is_core
    undo.step(`${core ? 'mark' : 'unmark'} core ${nodeName(node)}`, () => setKind(id, { core, nexus: false }))
    return true
  }

  /** A star becomes a nexus (a small shared connection point), or back. */
  function toggleNexus(id) {
    const node = graph.getNode(id)
    if (!canEdit() || !node) return false
    const nexus = !node.is_nexus
    undo.step(`${nexus ? 'make nexus' : 'make star'} ${nodeName(node)}`, () =>
      setKind(id, { core: false, nexus }),
    )
    return true
  }

  /**
   * Makes a node a `'star'`, `'core'` or `'nexus'`: one undo entry, or none if
   * it already is one. Returns whether anything changed.
   */
  function setType(id, type) {
    const node = graph.getNode(id)
    if (!node) return false
    if (type === 'core') return !node.is_core && toggleCore(id)
    if (type === 'nexus') return !node.is_nexus && toggleNexus(id)
    if (node.is_core) return toggleCore(id)
    if (node.is_nexus) return toggleNexus(id)
    return false
  }

  /**
   * Replaces the link A–B with A–nexus–B: a new nexus at the link's midpoint,
   * so more stars can share the connection. A directed link stays directed
   * through it (A→N→B), and a named link's name moves to the nexus, which now
   * stands for the connection. One undo entry. Returns the nexus, or null.
   */
  function splitEdge(edgeId) {
    const edge = graph.getEdge(edgeId)
    if (!canEdit() || !edge) return null
    const a = graph.getNode(edge.from)
    const b = graph.getNode(edge.to)
    if (!a || !b) return null
    const nexusId = newId('n', graph.nodes)
    const taken = new Set(graph.edges.keys())
    const first = newId('e', taken)
    taken.add(first)
    const second = newId('e', taken)
    undo.step(`split ${edgeName(edge)} with a nexus`, () => {
      yEdges.delete(edgeId)
      const middle = [(a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2]
      const nexus = blankNode(nexusId, { x: middle[0], y: middle[1], z: middle[2], label: edge.label })
      nexus.is_nexus = true
      yNodes.set(nexusId, nodeToY(nexus))
      yEdges.set(first, edgeToY({ id: first, from: a.id, to: nexusId, directed: edge.directed, label: '' }))
      yEdges.set(second, edgeToY({ id: second, from: nexusId, to: b.id, directed: edge.directed, label: '' }))
    })
    return graph.getNode(nexusId)
  }

  function move(id, { x, y, z }) {
    const node = graph.getNode(id)
    if (!canEdit() || !node || (node.x === x && node.y === y && node.z === z)) return false
    undo.step(`move ${nodeName(node)}`, () => setPosition(yNodes.get(id), [x, y, z]))
    return true
  }

  // --- Layout runs ---

  let run = null // { label, before, at } while a local Balance or orbit is in flight

  // Called by physics once a local run ends — landed, toggled off, or cut
  // short — after the colours are faded. Writes what changed, once.
  physics.onSettled = (snapshot) => {
    if (!run) return
    const { label, before, at } = run
    run = null
    undo.step(
      label,
      () => {
        for (const [id, position] of snapshot.positions) {
          const ynode = yNodes.get(id)
          if (!ynode) continue // deleted while the run flew
          setPosition(ynode, position)
          const colour = snapshot.colors.get(id)
          if (ynode.get('cluster_color_id') !== colour) ynode.set('cluster_color_id', colour)
          const blend = snapshot.blends.get(id) ?? null
          if (!sameBlend(ynode.get('blend') ?? null, blend)) ynode.set('blend', blend)
        }
      },
      { before, at },
    )
  }

  /** One undo entry covering a whole layout run that `begin` starts. */
  function layoutRun(label, begin) {
    if (!canEdit()) return false
    const before = graph.contentRevision
    const at = undo.mark()
    if (!begin()) return false
    run = { label, before, at }
    return true
  }

  /** Balance on/off. Stopping a run settles it; it records nothing new. */
  function toggleBalance() {
    if (physics.isRunning) {
      physics.stop()
      return false
    }
    return layoutRun('balance', () => physics.start())
  }

  /**
   * Lays the map out round one star (`orbit.js`), as one undo entry the same
   * way a Balance is. A run already in flight is stopped where it got to
   * first, and that is what undo returns to.
   */
  function orbitAround(id, plane) {
    if (physics.isRunning) physics.stop()
    return layoutRun('orbit', () => physics.orbit(id, plane))
  }

  // A run in flight is settled (and so on the stack) before undo or redo looks.
  function settleFirst() {
    if (physics.isRunning) physics.stop()
  }

  /** Steps back one entry. Returns its label, or null if there was nothing to undo. */
  function undoStep() {
    settleFirst()
    return canEdit() ? undo.undo() : null
  }

  function redoStep() {
    settleFirst()
    return canEdit() ? undo.redo() : null
  }

  return {
    spawn,
    connect,
    deleteNode,
    deleteEdge,
    setNodeText,
    editNotes,
    setEdgeLabel,
    toggleCore,
    toggleNexus,
    setType,
    splitEdge,
    move,
    toggleBalance,
    orbitAround,
    undo: undoStep,
    redo: redoStep,
    clear() {
      run = null
      undo.clear()
    },
  }
}
