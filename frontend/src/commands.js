/**
 * Every edit to the map, each paired with its inverse on the undo stack.
 *
 * This is the one place that knows which view and physics calls follow which
 * model change — the recipes every edit site used to copy by hand (V2.md
 * §2.4.1). The rules they encode:
 * - Nodes added or removed: `view.syncNodes()`, never `view.sync()`, which
 *   snaps sizes: neighbours of an edited node should ease to their new ones.
 * - Edges added or removed: `view.syncEdges()`.
 * - Positions: `syncNodes()` + `updateEdgePositions()`, which move the
 *   stars and their lines and recompute bounds, like a physics tick.
 * - Anything structural or positional: `physics.invalidate()`, so a Balance
 *   run in flight settles the new shape. Its re-seed copies the model's
 *   positions into the bodies, so a restored position wins over the run.
 * - Core flags: the view polls `graph.revision` by itself; only physics
 *   needs telling.
 *
 * No DOM and no three.js, so it runs in Node against stubs. The viewer never
 * imports it: an exported map has no edits to undo.
 */

const nodeName = (node) => node.label || node.id

export function createCommands({ graph, view, physics, history }) {
  function edgeName(edge) {
    const ends = `${nodeName(graph.getNode(edge.from))} — ${nodeName(graph.getNode(edge.to))}`
    return edge.label ? `edge ${edge.label} · ${ends}` : `edge ${ends}`
  }

  function record(label, before, undo, redo) {
    history.record({ label, before, after: graph.contentRevision, undo, redo })
  }

  // --- Synced primitives, shared by the commands and their inverses ---

  function removeNodeSynced(id) {
    const snapshot = graph.removeNode(id)
    view.syncNodes()
    view.syncEdges()
    physics.invalidate()
    return snapshot
  }

  function restoreNodeSynced(snapshot) {
    graph.restoreNode(snapshot)
    view.syncNodes()
    view.syncEdges()
    physics.invalidate()
  }

  function removeEdgeSynced(id) {
    const snapshot = graph.removeEdge(id)
    view.syncEdges()
    physics.invalidate()
    return snapshot
  }

  function restoreEdgeSynced(snapshot) {
    graph.restoreEdge(snapshot)
    view.syncEdges()
    physics.invalidate()
  }

  function syncPositions() {
    view.syncNodes()
    view.updateEdgePositions()
  }

  function placeNode(id, [x, y, z]) {
    graph.setNodePosition(id, x, y, z)
    syncPositions()
    physics.invalidate()
  }

  function setCoreSynced(id, value) {
    graph.setCore(id, value)
    physics.invalidate()
  }

  // --- Commands ---

  function spawn({ x, y, z }) {
    const before = graph.contentRevision
    const node = graph.addNode({ x, y, z })
    view.syncNodes()
    physics.invalidate()
    // Taken at undo time, not now: a Balance run may have moved it since, and
    // redo should put it back where it was last seen.
    let snapshot = null
    record(
      'new node',
      before,
      () => (snapshot = removeNodeSynced(node.id)),
      () => restoreNodeSynced(snapshot),
    )
    return node
  }

  /** Returns the new edge, or null if `graph.addEdge` refused it. */
  function connect(fromId, toId) {
    const before = graph.contentRevision
    const edge = graph.addEdge(fromId, toId)
    if (!edge) return null
    view.syncEdges()
    physics.invalidate()
    let snapshot = null
    record(
      `link ${edgeName(edge)}`,
      before,
      () => (snapshot = removeEdgeSynced(edge.id)),
      () => restoreEdgeSynced(snapshot),
    )
    return edge
  }

  function deleteNode(id) {
    const node = graph.getNode(id)
    if (!node) return false
    const before = graph.contentRevision
    const links = graph.degree(id)
    const label = `delete node ${nodeName(node)}${links ? ` (${links} link${links === 1 ? '' : 's'})` : ''}`
    let snapshot = removeNodeSynced(id)
    record(
      label,
      before,
      () => restoreNodeSynced(snapshot),
      () => (snapshot = removeNodeSynced(id)),
    )
    return true
  }

  function deleteEdge(id) {
    const edge = graph.getEdge(id)
    if (!edge) return false
    const before = graph.contentRevision
    const label = `delete ${edgeName(edge)}`
    let snapshot = removeEdgeSynced(id)
    record(
      label,
      before,
      () => restoreEdgeSynced(snapshot),
      () => (snapshot = removeEdgeSynced(id)),
    )
    return true
  }

  function setNodeText(id, label, notes) {
    const node = graph.getNode(id)
    if (!node || (node.label === label && node.notes === notes)) return false
    const before = graph.contentRevision
    const previous = [node.label, node.notes]
    graph.setNodeText(id, label, notes)
    record(
      `edit node ${nodeName(node)}`,
      before,
      () => graph.setNodeText(id, ...previous),
      () => graph.setNodeText(id, label, notes),
    )
    return true
  }

  function setEdgeLabel(id, label) {
    const edge = graph.getEdge(id)
    if (!edge || edge.label === label) return false
    const before = graph.contentRevision
    const previous = edge.label
    const name = edgeName(edge)
    graph.setEdgeLabel(id, label)
    record(
      `edit ${name}`,
      before,
      () => graph.setEdgeLabel(id, previous),
      () => graph.setEdgeLabel(id, label),
    )
    return true
  }

  function toggleCore(id) {
    const node = graph.getNode(id)
    if (!node) return false
    const before = graph.contentRevision
    const value = !node.is_core
    setCoreSynced(id, value)
    record(
      `${value ? 'mark' : 'unmark'} core ${nodeName(node)}`,
      before,
      () => setCoreSynced(id, !value),
      () => setCoreSynced(id, value),
    )
    return true
  }

  function move(id, { x, y, z }) {
    const node = graph.getNode(id)
    if (!node) return false
    const from = [node.x, node.y, node.z]
    const to = [x, y, z]
    if (from.every((value, i) => value === to[i])) return false
    const before = graph.contentRevision
    placeNode(id, to)
    record(
      `move ${nodeName(node)}`,
      before,
      () => placeNode(id, from),
      () => placeNode(id, to),
    )
    return true
  }

  function applyLayoutSynced(layout) {
    graph.applyLayout(layout)
    syncPositions()
  }

  /**
   * Balance on/off. Starting a run is one undo entry covering the whole run:
   * every position and cluster colour as they were before `recluster`, which
   * `physics.start()` calls first. Stopping one records nothing.
   *
   * The end state is captured on the first undo, after stopping the run —
   * not when the run ends, which nothing here observes. By the time this
   * entry is undone every later one already has been, so the layout at that
   * moment *is* where the run finished (or was cut short).
   */
  function toggleBalance() {
    if (physics.isRunning) {
      physics.stop()
      return false
    }
    const before = graph.contentRevision
    const layoutBefore = graph.layoutSnapshot()
    if (!physics.start()) return false
    let layoutAfter = null
    const entry = {
      label: 'balance',
      before,
      after: null,
      undo() {
        physics.stop()
        if (!layoutAfter) {
          layoutAfter = graph.layoutSnapshot()
          entry.after = graph.contentRevision
        }
        applyLayoutSynced(layoutBefore)
        physics.invalidate()
      },
      redo() {
        physics.stop()
        applyLayoutSynced(layoutAfter)
        physics.invalidate()
      },
    }
    history.record(entry)
    return true
  }

  /** Steps back one entry. Returns its label, or null if there was nothing to undo. */
  function undo() {
    const entry = history.undo()
    if (!entry) return null
    entry.undo()
    graph.setContentRevision(entry.before)
    return entry.label
  }

  function redo() {
    const entry = history.redo()
    if (!entry) return null
    entry.redo()
    graph.setContentRevision(entry.after)
    return entry.label
  }

  return {
    spawn,
    connect,
    deleteNode,
    deleteEdge,
    setNodeText,
    setEdgeLabel,
    toggleCore,
    move,
    toggleBalance,
    undo,
    redo,
    clear: () => history.clear(),
  }
}
