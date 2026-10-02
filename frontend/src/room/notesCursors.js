/**
 * Other people's carets in a star's notes (context/MOONSHOT.md decision 8).
 * Each person's selection travels in awareness as `cursor: { node, anchor,
 * head }`, the two ends as Yjs relative positions, so a caret stays on its
 * word however much is typed before it. The notes editor draws everyone
 * else's in their colour, with a small name flag.
 *
 * `cursorField` and `cursorsFor` are pure; `createCursorOverlay` draws.
 */
import * as Y from 'yjs'

/** This selection in `ytext` as the awareness `cursor` field (JSON). */
export function cursorField(nodeId, ytext, start, end, direction = 'forward') {
  const at = (index) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, index))
  const [anchor, head] = direction === 'backward' ? [end, start] : [start, end]
  return { node: nodeId, anchor: at(anchor), head: at(head) }
}

function resolve(json, doc, ytext) {
  try {
    const position = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), doc)
    return position && position.type === ytext ? position.index : null
  } catch {
    return null
  }
}

/**
 * Everyone else's selection in this star's notes, as indices into the text
 * now. A cursor that no longer resolves (its star deleted, or nonsense)
 * is left out.
 */
export function cursorsFor(nodeId, states, doc, { exclude } = {}) {
  const ytext = doc.getMap('nodes').get(nodeId)?.get?.('notes')
  if (!(ytext instanceof Y.Text)) return []
  const out = []
  for (const [clientId, state] of states) {
    const cursor = state?.cursor
    if (clientId === exclude || !cursor || typeof cursor !== 'object' || cursor.node !== nodeId) continue
    if (
      !cursor.anchor ||
      !cursor.head ||
      typeof cursor.anchor !== 'object' ||
      typeof cursor.head !== 'object'
    )
      continue
    const anchor = resolve(cursor.anchor, doc, ytext)
    const head = resolve(cursor.head, doc, ytext)
    if (anchor === null || head === null) continue
    out.push({ clientId, anchor, head })
  }
  return out
}

// What a mirror must share with the textarea for its text to wrap the same.
const MIRRORED = [
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'tabSize',
  'textIndent',
  'textTransform',
  'wordSpacing',
]

/**
 * Draws carets over `textarea` in `layer` (positioned over it, clicks pass
 * through). Where index N sits is found with a hidden mirror: a div styled
 * like the textarea holding the text up to N and then a marker span.
 * `render([{ anchor, head, colour, name }])` redraws all of them.
 */
export function createCursorOverlay({ textarea, layer }) {
  const mirror = document.createElement('div')
  mirror.className = 'notes-mirror'
  mirror.setAttribute('aria-hidden', 'true')
  layer.append(mirror)

  function copyStyle() {
    const style = getComputedStyle(textarea)
    for (const key of MIRRORED) mirror.style[key] = style[key]
    // Its padding box is the textarea's: what text wraps in, scrollbar excluded.
    mirror.style.boxSizing = 'border-box'
    mirror.style.width = `${textarea.clientWidth}px`
  }

  /** Pixel position of index `n`, in the textarea's box, before its scroll. */
  function caretAt(n) {
    const marker = document.createElement('span')
    marker.textContent = '​'
    mirror.replaceChildren(document.createTextNode(textarea.value.slice(0, n)), marker)
    return { left: marker.offsetLeft, top: marker.offsetTop, height: marker.offsetHeight }
  }

  let last = []
  function render(cursors = last) {
    last = cursors
    copyStyle()
    const drawn = []
    for (const cursor of cursors) {
      const at = caretAt(cursor.head)
      const top = at.top - textarea.scrollTop
      if (top + at.height < 0 || top > textarea.clientHeight) continue // scrolled out of view
      const caret = document.createElement('span')
      caret.className = 'notes-caret'
      caret.style.left = `${textarea.offsetLeft + textarea.clientLeft + at.left - textarea.scrollLeft}px`
      caret.style.top = `${textarea.offsetTop + textarea.clientTop + top}px`
      caret.style.height = `${at.height}px`
      caret.style.setProperty('--person', cursor.colour)
      if (top < 16) caret.classList.add('notes-caret--low')
      const flag = document.createElement('span')
      flag.className = 'notes-caret-name'
      flag.textContent = cursor.name
      caret.append(flag)
      drawn.push(caret)
    }
    mirror.replaceChildren()
    layer.replaceChildren(mirror, ...drawn)
  }

  const redraw = () => render()
  textarea.addEventListener('scroll', redraw)
  textarea.addEventListener('input', redraw)
  window.addEventListener('resize', redraw)

  return {
    render,
    destroy() {
      textarea.removeEventListener('scroll', redraw)
      textarea.removeEventListener('input', redraw)
      window.removeEventListener('resize', redraw)
      layer.replaceChildren()
    },
  }
}
