/**
 * A notes textarea bound to a star's Y.Text (context/MOONSHOT.md decision 8):
 * typing goes straight into the shared text, other people's typing comes
 * straight in, and your caret stays on the word you were typing. In a room,
 * where your caret is goes out through awareness for others to see
 * (room/notesCursors.js).
 */
import { cursorField } from './notesCursors.js'

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
 * selection along. With `cursor: { awareness, node }`, the selection is
 * published as awareness `cursor` while bound, and cleared after.
 */
export function bindTextarea(textarea, ytext, { origin, cursor = null }) {
  let applying = false
  textarea.value = ytext.toString()

  let published = ''
  function publishCursor() {
    if (!cursor) return
    const { selectionStart: start, selectionEnd: end } = textarea
    const key = `${start}:${end}:${textarea.selectionDirection}:${ytext.length}`
    if (key === published) return
    published = key
    cursor.awareness.setLocalStateField(
      'cursor',
      cursorField(cursor.node, ytext, start, end, textarea.selectionDirection),
    )
  }

  const onInput = () => {
    if (applying) return
    const { index, remove, insert } = diffText(ytext.toString(), textarea.value)
    if (remove || insert) {
      ytext.doc.transact(() => {
        if (remove) ytext.delete(index, remove)
        if (insert) ytext.insert(index, insert)
      }, origin)
    }
    publishCursor()
  }
  // Moving the caret without typing: arrows, clicks, selecting.
  const CARET_EVENTS = ['keyup', 'mouseup', 'select', 'selectionchange', 'focus']

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
  if (cursor) for (const type of CARET_EVENTS) textarea.addEventListener(type, publishCursor)
  ytext.observe(onChange)
  publishCursor()
  return {
    destroy() {
      textarea.removeEventListener('input', onInput)
      if (cursor) for (const type of CARET_EVENTS) textarea.removeEventListener(type, publishCursor)
      ytext.unobserve(onChange)
      cursor?.awareness.setLocalStateField('cursor', null)
    },
  }
}

/**
 * Trims the text's leading and trailing whitespace, as the notes editor's
 * Save always did, in one transaction under `origin` (so it joins the
 * session's undo step). Nothing at all if it's already trimmed.
 */
export function trimText(ytext, origin) {
  const value = ytext.toString()
  const start = value.length - value.trimStart().length
  const end = value.trimEnd().length
  if (start === 0 && end === value.length) return
  ytext.doc.transact(() => {
    ytext.delete(end, value.length - end)
    if (start) ytext.delete(0, Math.min(start, end))
  }, origin)
}
