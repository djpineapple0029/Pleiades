const MAX_QUERY = 60

/**
 * The / search field and its results, top centre.
 *
 * Unlike renaming in place, the field is visible: there is no label to show
 * the text on yet. Pointer lock only captures the mouse, so the focused field
 * still takes keystrokes while flying. Nothing here knows about the map — the
 * caller's `lookup(query)` does the ranking and returns the rows.
 *
 * Up/Down choose, Enter picks, Esc closes. In the overview the mouse is free,
 * so a row can also be clicked.
 */
export function createSearchPanel(root) {
  const input = document.createElement('input')
  input.className = 'search-input'
  input.type = 'text'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.maxLength = MAX_QUERY
  input.placeholder = 'find a star'
  input.setAttribute('aria-label', 'Find a star')
  const list = document.createElement('ol')
  list.className = 'search-results'
  const foot = document.createElement('p')
  foot.className = 'search-foot'
  root.append(input, list, foot)
  root.hidden = true

  let resolve = null
  let lookup = null
  let onSelect = null
  let rows = []
  let selected = 0

  function render() {
    list.replaceChildren(
      ...rows.map((row, index) => {
        const item = document.createElement('li')
        item.className = index === selected ? 'search-row search-row--selected' : 'search-row'
        const swatch = document.createElement('span')
        swatch.className = 'search-swatch'
        swatch.style.color = row.swatch
        const name = document.createElement('span')
        name.className = 'search-name'
        if (row.mark) {
          const [start, end] = row.mark
          const hit = document.createElement('mark')
          hit.textContent = row.label.slice(start, end)
          name.append(row.label.slice(0, start), hit, row.label.slice(end))
        } else {
          name.textContent = row.label
        }
        const meta = document.createElement('span')
        meta.className = 'search-meta'
        meta.textContent = row.meta
        item.append(swatch, name, meta)
        // Only reachable in the overview, where the cursor is free. mousedown,
        // not click: the field would lose focus on the way.
        item.addEventListener('mousedown', (event) => {
          event.preventDefault()
          finish(row.id)
        })
        item.addEventListener('mousemove', () => select(index))
        return item
      }),
    )
  }

  function select(index) {
    if (!rows.length || index === selected) return
    selected = index
    render()
    onSelect(rows[selected].id)
  }

  function refresh() {
    const result = lookup(input.value)
    rows = result.rows
    selected = 0
    render()
    foot.textContent = result.note ?? ''
    foot.hidden = !result.note
    onSelect(rows[0]?.id ?? null)
  }

  function finish(value) {
    if (!resolve) return
    const done = resolve
    resolve = null
    lookup = null
    onSelect = null
    rows = []
    input.blur()
    input.value = ''
    list.replaceChildren()
    root.hidden = true
    done(value)
  }

  input.addEventListener('keydown', (event) => {
    // Nothing typed here should also reach flight, the lock or the map keys.
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      // No composing IME text commits a pick, and with nothing matched there
      // is nothing to pick: the field just stays open.
      if (!event.isComposing && rows.length) finish(rows[selected].id)
    } else if (event.key === 'Escape') {
      finish(null)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length) select((selected + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
    } else if (event.key === 'Tab') {
      event.preventDefault()
    } else if ((event.metaKey || event.ctrlKey) && ['KeyS', 'KeyO', 'KeyE', 'KeyF'].includes(event.code)) {
      // The browser's own dialogs and find bar would steal focus or the lock.
      event.preventDefault()
    }
  })
  input.addEventListener('input', refresh)
  // Nothing else should hold focus while the search is up — a click on the
  // canvas in the overview would otherwise leave the user typing into nothing.
  input.addEventListener('blur', () => {
    if (resolve) queueMicrotask(() => resolve && input.focus())
  })

  /**
   * Opens the field. `lookup(query)` returns `{ rows, note }`: rows are
   * `{ id, label, mark, swatch, meta }`, note a line under them (or null).
   * `select(id)` hears the highlighted row's id, or null for none. Resolves
   * with the picked id, or null if closed.
   */
  function start(lookupFn, selectFn) {
    finish(null)
    lookup = lookupFn
    onSelect = selectFn
    root.hidden = false
    const promise = new Promise((settle) => {
      resolve = settle
    })
    input.focus()
    refresh()
    return promise
  }

  return {
    start,
    cancel: () => finish(null),
    get isActive() {
      return resolve !== null
    },
  }
}
