/**
 * A notes textarea bound to a star's Y.Text (context/MOONSHOT.md decision 8):
 * typing goes straight into the shared text, other people's typing comes
 * straight in, and your caret stays on the word you were typing.
 */

/** The single splice turning `before` into `after` (common prefix and suffix). */
export function diffText(before, after) {
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before[start] === after[start]) start++
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  return { index: start, remove: endBefore - start, insert: after.slice(start, endAfter) }
}

/**
 * Where a caret at `index` (in the old text) lands after a Yjs `delta`. An
 * insert exactly at the caret stays after it, so my next keystroke carries
 * on my word rather than landing inside theirs.
 */
export function transformIndex(index, delta) {
  let oldPos = 0
  let shift = 0
  for (const op of delta) {
    if (oldPos > index) break
    if (op.retain !== undefined) oldPos += op.retain
    else if (op.insert !== undefined) {
      if (oldPos < index) shift += typeof op.insert === 'string' ? op.insert.length : 1
    } else if (op.delete !== undefined) {
      shift -= Math.min(op.delete, Math.max(0, index - oldPos))
      oldPos += op.delete
    }
  }
  return Math.max(0, index + shift)
}

/**
 * Binds `textarea` to `ytext` both ways until `destroy()`. Local typing is
 * one transaction per input event, under `origin` (mapDoc's LOCAL, so undo
 * sees it); changes from anyone else rewrite the textarea and carry the
 * selection along.
 */
export function bindTextarea(textarea, ytext, { origin }) {
  let applying = false
  textarea.value = ytext.toString()

  const onInput = () => {
    if (applying) return
    const { index, remove, insert } = diffText(ytext.toString(), textarea.value)
    if (!remove && !insert) return
    ytext.doc.transact(() => {
      if (remove) ytext.delete(index, remove)
      if (insert) ytext.insert(index, insert)
    }, origin)
  }

  const onChange = (event, txn) => {
    if (txn.origin === origin) return
    const start = transformIndex(textarea.selectionStart, event.delta)
    const end = transformIndex(textarea.selectionEnd, event.delta)
    applying = true
    textarea.value = ytext.toString()
    textarea.setSelectionRange(start, end)
    applying = false
  }

  textarea.addEventListener('input', onInput)
  ytext.observe(onChange)
  return {
    destroy() {
      textarea.removeEventListener('input', onInput)
      ytext.unobserve(onChange)
    },
  }
}
