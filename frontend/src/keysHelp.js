/**
 * The key list on the click-to-fly overlay (in the app, only on `?`; the
 * Help page has the whole set), drawn from the keymap so it can't
 * drift from the keys that actually work (V2.md §2.4.4). Mouse rows and Esc
 * aren't rebindable, so they're written in here.
 */

/** A row is `{ ids: [...actions] }` or `{ caps: [...fixed key caps] }`, plus `text`. */
export const APP_ROWS = [
  { ids: ['move_forward', 'move_left', 'move_back', 'move_right'], text: 'move' },
  { ids: ['move_up'], text: 'up' },
  { ids: ['move_down'], text: 'down' },
  { caps: ['Mouse'], text: 'look' },
  { caps: ['Scroll'], text: 'flight speed' },
  { caps: ['Double-click'], text: 'new node in open space' },
  { caps: ['Click'], text: 'focus a star: only its links stay lit; click space to clear' },
  { caps: ['Hold right'], text: 'menu on the targeted node or edge, move to choose' },
  { ids: ['rename'], text: 'rename the targeted node or edge; Enter saves, Esc cancels' },
  { ids: ['edit_notes'], text: "edit the targeted node's notes" },
  { ids: ['notes_sidebar'], text: 'notes sidebar on/off' },
  { ids: ['heat'], text: 'connection heat colours on/off' },
  {
    ids: ['look'],
    text: 'hold, point at a look, let go: Deep Space, Deep Sea, Terminal, Minimal, Shallow Space',
  },
  { ids: ['search'], text: 'find a star by name; Enter flies there' },
  { ids: ['jump_back'], text: 'fly back to where you were before the last jump' },
  { ids: ['balance'], text: 'balance the layout, press again to stop' },
  { ids: ['tree_shape'], text: 'hold, point at a layout shape, let go: Cone, Flat, Off; balances with it' },
  { ids: ['overview'], text: 'overview: orbit the whole map, press again to fly' },
  { ids: ['undo'], text: 'undo' },
  { ids: ['redo'], text: 'redo' },
  { ids: ['save'], text: 'save to a file' },
  { ids: ['open'], text: 'open a file' },
  { ids: ['export'], text: 'export a view-only .html anyone can open' },
  { caps: ['Esc'], text: 'release pointer' },
  { ids: ['help'], text: 'show or hide this list while the pointer is free' },
]

// A map from the account's list saves itself, and opens no files.
export const SERVER_MAP_ROWS = APP_ROWS.filter((row) => !row.ids?.includes('open')).map((row) =>
  row.ids?.includes('save') ? { ...row, text: 'save now (it also saves by itself)' } : row,
)

export const VIEWER_ROWS = [
  { ids: ['move_forward', 'move_left', 'move_back', 'move_right'], text: 'move' },
  { ids: ['move_up'], text: 'up' },
  { ids: ['move_down'], text: 'down' },
  { caps: ['Mouse'], text: 'look' },
  { caps: ['Scroll'], text: 'flight speed' },
  { caps: ['Click'], text: 'focus a star: only its links stay lit; click space to clear' },
  { ids: ['heat'], text: 'connection heat colours on/off' },
  { ids: ['overview'], text: 'overview: orbit the whole map, press again to fly' },
  { caps: ['Esc'], text: 'release pointer' },
]

const kbd = (text) => Object.assign(document.createElement('kbd'), { textContent: text })

/** Key caps for a row; a multi-action row takes one key from each. */
function rowCaps(row, keymap) {
  if (row.caps) return row.caps
  if (row.ids.length === 1) return keymap.caps(row.ids[0])
  return row.ids.map((id) => keymap.caps(id).join('+')).filter(Boolean)
}

/** Fills `list` (the overlay's `<ul class="keys">`). Unbound actions are left out. */
export function renderKeyList(list, keymap, rows) {
  const items = []
  for (const row of rows) {
    const caps = rowCaps(row, keymap)
    if (!caps.length) continue
    const li = document.createElement('li')
    li.append(...caps.map(kbd), Object.assign(document.createElement('span'), { textContent: row.text }))
    items.push(li)
  }
  list.replaceChildren(...items)
}

/**
 * The line under the overlay's "Click to fly": "or Enter · ? keys · Help".
 * The full list stays behind `?`; `helpHref` (the account's Help page, which
 * only a signed-in map can reach) links every key, opened in a new tab so the
 * map stays open.
 */
export function renderPromptHint(hint, keymap, { helpHref = null } = {}) {
  const parts = []
  const resume = keymap.caps('resume')
  if (resume.length) parts.push([document.createTextNode('or '), ...resume.map(kbd)])
  const help = keymap.caps('help')
  if (help.length) parts.push([...help.map(kbd), document.createTextNode(' keys')])
  if (helpHref) {
    const link = Object.assign(document.createElement('a'), {
      href: helpHref,
      target: '_blank',
      rel: 'noopener',
      textContent: 'Help',
    })
    parts.push([link])
  }
  hint.replaceChildren(
    ...parts.flatMap((nodes, i) => (i ? [document.createTextNode(' · '), ...nodes] : nodes)),
  )
}

/** The small "Click or Enter to fly · ? keys" hint. */
export function renderResumePill(pill, keymap) {
  const resume = keymap.caps('resume')
  const help = keymap.caps('help')
  const nodes = [document.createTextNode('Click')]
  if (resume.length) nodes.push(document.createTextNode(' or '), ...resume.map(kbd))
  nodes.push(document.createTextNode(' to fly'))
  if (help.length)
    nodes.push(document.createTextNode(' · '), ...help.map(kbd), document.createTextNode(' keys'))
  pill.replaceChildren(...nodes)
}
