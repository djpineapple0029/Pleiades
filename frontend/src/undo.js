/**
 * Undo/redo of this tab's own edits (context/MOONSHOT.md decision 9), over
 * the map's Yjs doc. Replaces history.js's stacks; the labels and the
 * saved-state tokens work as they did there: each entry remembers the graph's
 * content token before and after, so undoing back to what was saved reads as
 * clean again.
 *
 * Y.UndoManager merges transactions that land within `captureTimeout`; this
 * sets it effectively infinite and closes the group explicitly instead
 * (`stopCapturing`) — before and after every `step`, and at the end of a
 * `group` (one notes-editing session is one undo step).
 *
 * Only `LOCAL` transactions are tracked, so someone else's edit is never
 * taken back by this tab's Ctrl+Z.
 */
import * as Y from 'yjs'

const NEVER = 2 ** 31 - 1

export function createUndo({ mapDoc, graph, limit = 200 }) {
  const manager = new Y.UndoManager([mapDoc.nodes, mapDoc.edges, mapDoc.meta], {
    trackedOrigins: new Set([mapDoc.LOCAL]),
    captureTimeout: NEVER,
  })
  let pending = null // { label, before } for the next stack item a step or group adds

  manager.on('stack-item-added', ({ stackItem, type }) => {
    if (type !== 'undo' || !pending || stackItem.meta.has('label')) return
    stackItem.meta.set('label', pending.label)
    stackItem.meta.set('before', pending.before)
    if (manager.undoStack.length > limit) manager.undoStack.shift()
  })
  // Undoing an entry makes a fresh one on the redo stack (and redoing, on
  // the undo stack); Yjs doesn't carry `meta` across, so copy it.
  manager.on('stack-item-popped', ({ stackItem, type }) => {
    const target = type === 'undo' ? manager.redoStack : manager.undoStack
    const moved = target.at(-1)
    if (moved && moved !== stackItem) for (const [key, value] of stackItem.meta) moved.meta.set(key, value)
  })

  function closeGroup(name) {
    const top = manager.undoStack.at(-1)
    if (top && top.meta.get('label') === name && pending) top.meta.set('after', graph.contentRevision)
    pending = null
    manager.stopCapturing()
  }

  /** Runs `fn` as one transaction and one undo step called `name`. Returns what `fn` returns. */
  function step(name, fn, { before = graph.contentRevision } = {}) {
    manager.stopCapturing()
    pending = { label: name, before }
    let result
    try {
      mapDoc.transact(() => {
        result = fn()
      })
    } finally {
      closeGroup(name)
    }
    return result
  }

  /** Every local transaction until `end()` is one undo step called `name`. */
  function group(name) {
    manager.stopCapturing()
    pending = { label: name, before: graph.contentRevision }
    return { end: () => closeGroup(name) }
  }

  function undo() {
    const item = manager.undo()
    if (!item) return null
    graph.setContentRevision(item.meta.get('before'))
    return item.meta.get('label') ?? 'edit'
  }

  function redo() {
    const item = manager.redo()
    if (!item) return null
    graph.setContentRevision(item.meta.get('after'))
    return item.meta.get('label') ?? 'edit'
  }

  return {
    step,
    group,
    undo,
    redo,
    clear: () => manager.clear(),
    get canUndo() {
      return manager.undoStack.length > 0
    },
    get canRedo() {
      return manager.redoStack.length > 0
    },
    get size() {
      return manager.undoStack.length
    },
  }
}
