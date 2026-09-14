/**
 * Centred text panel for editing a node or edge without leaving pointer lock.
 * Pointer lock only captures the mouse, so a focused field still takes
 * keystrokes; the caller is responsible for suspending flight input while this
 * is open, since W/A/S/D have to reach the field instead of the camera.
 */
export function createEditor(container) {
  const panel = document.createElement('div')
  panel.className = 'editor-panel'
  container.append(panel)

  // Field descriptors alongside their elements: committing has to know which
  // ones are passwords, since trimming one would silently alter it.
  let entries = []
  let resolve = null

  const inputs = () => entries.map((entry) => entry.input)

  function finish(value) {
    if (!resolve) return
    const done = resolve
    resolve = null
    entries = []
    panel.replaceChildren()
    container.hidden = true
    done(value)
  }

  function collect() {
    const values = {}
    for (const { field, input } of entries) {
      // A trailing space is part of a password; everywhere else it is a typo.
      values[field.key] = field.type === 'password' ? input.value : input.value.trim()
    }
    return values
  }

  function onKeyDown(event) {
    // Nothing typed in here should also reach the flight or lock handlers.
    event.stopPropagation()

    if (event.key === 'Escape') {
      finish(null)
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || event.target.tagName === 'INPUT')) {
      event.preventDefault()
      finish(collect())
      return
    }
    if (event.key === 'Tab' && entries.length > 1) {
      event.preventDefault()
      const fields = inputs()
      const step = event.shiftKey ? -1 : 1
      const next = (fields.indexOf(event.target) + step + fields.length) % fields.length
      fields[next].focus()
      fields[next].select()
    }
  }

  panel.addEventListener('keydown', onKeyDown)

  /**
   * `fields` are `{ key, label, value, multiline, type }`; `type: 'password'`
   * masks the field and keeps its value untrimmed. `note` is shown above the
   * fields — a rejected password or a mismatch, on a re-prompt. Resolves with a
   * `{ key: value }` map on commit, or null if cancelled.
   */
  function open(title, fields, note = null) {
    finish(null)

    const heading = document.createElement('p')
    heading.className = 'editor-title'
    heading.textContent = title
    panel.append(heading)

    if (note) {
      const warning = document.createElement('p')
      warning.className = 'editor-note'
      warning.textContent = note
      panel.append(warning)
    }

    entries = fields.map((field) => {
      const row = document.createElement('label')
      row.className = 'editor-row'

      const name = document.createElement('span')
      name.textContent = field.label
      row.append(name)

      const input = document.createElement(field.multiline ? 'textarea' : 'input')
      if (field.multiline) input.rows = 4
      if (field.type === 'password') {
        input.type = 'password'
        // Nothing here should reach a password manager or an autofill store.
        input.autocomplete = 'off'
      }
      input.value = field.value ?? ''
      input.spellcheck = false
      row.append(input)

      panel.append(row)
      return { field, input }
    })

    const hint = document.createElement('p')
    hint.className = 'editor-hint'
    // Enter commits from a single-line field, so only say Ctrl+Enter when
    // there is a textarea that swallows it.
    const commit = fields.some((field) => field.multiline) ? 'Ctrl+Enter: save' : 'Enter: save'
    const parts = fields.length > 1 ? ['Tab: field', commit] : [commit]
    hint.textContent = [...parts, 'Esc: cancel'].join(' · ')
    panel.append(hint)

    container.hidden = false
    const [first] = inputs()
    first.focus()
    first.select()

    return new Promise((settle) => {
      resolve = settle
    })
  }

  return {
    open,
    cancel: () => finish(null),
    get isOpen() {
      return resolve !== null
    },
  }
}
