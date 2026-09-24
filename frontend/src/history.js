/**
 * Undo/redo stacks — plain data, no graph, no DOM.
 *
 * An entry is `{ label, undo(), redo(), before, after }`: the two functions
 * do the work (see `commands.js`), `label` is what the HUD names it, and
 * `before`/`after` are the graph's content tokens either side of it, so
 * stepping back to the state a file was saved in reads as clean again.
 *
 * Memory only, never written to a file, and cleared whenever the graph is
 * replaced wholesale (Open, New map).
 */

const DEFAULT_LIMIT = 200

export function createHistory({ limit = DEFAULT_LIMIT } = {}) {
  const done = []
  const undone = []

  /** A new action: it becomes the next undo, and anything undone is gone for good. */
  function record(entry) {
    done.push(entry)
    if (done.length > limit) done.shift()
    undone.length = 0
  }

  /** Moves the latest entry onto the redo stack and returns it (the caller applies it), or null. */
  function undo() {
    const entry = done.pop()
    if (!entry) return null
    undone.push(entry)
    return entry
  }

  function redo() {
    const entry = undone.pop()
    if (!entry) return null
    done.push(entry)
    return entry
  }

  function clear() {
    done.length = 0
    undone.length = 0
  }

  return {
    record,
    undo,
    redo,
    clear,
    get canUndo() {
      return done.length > 0
    },
    get canRedo() {
      return undone.length > 0
    },
    get size() {
      return done.length
    },
  }
}
