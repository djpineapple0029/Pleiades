const STORAGE_KEY = 'atlasmap.notesSidebar'

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'open'
  } catch {
    return false
  }
}

function writeStored(open) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? 'open' : 'closed')
  } catch {
    // Private window or blocked storage: the toggle just won't be remembered.
  }
}

/**
 * The notes panel on the right. Two modes:
 *
 * - **View**, toggled with N: read-only, never takes the mouse, and shows the
 *   notes of whatever star is under the crosshair (the caller decides which).
 * - **Edit**, from Ctrl/Cmd+Enter: a real textarea with a real cursor — the
 *   caller releases pointer lock first. Enter is a newline here, since notes
 *   are prose; the Save button commits (Ctrl/Cmd+Enter does too, for the
 *   keyboard-only), Esc cancels.
 */
export function createNotesSidebar(aside) {
  const heading = document.createElement('p')
  heading.className = 'notes-title'
  const body = document.createElement('div')
  body.className = 'notes-body'
  aside.append(heading, body)

  let visible = readStored()
  let resolve = null
  aside.hidden = !visible

  function setVisible(value) {
    visible = value
    writeStored(value)
    if (!resolve) aside.hidden = !value
  }

  /** View mode: `name` and `notes` of the targeted star, or null for none. */
  function show(target) {
    if (resolve) return
    body.classList.remove('notes-body--empty')
    if (!target) {
      heading.textContent = 'notes'
      body.textContent = 'aim at a star to read its notes'
      body.classList.add('notes-body--empty')
      return
    }
    heading.textContent = target.name
    if (target.notes) {
      body.textContent = target.notes
    } else {
      body.textContent = 'no notes · Ctrl/⌘+Enter to write'
      body.classList.add('notes-body--empty')
    }
  }

  function finish(value) {
    if (!resolve) return
    const done = resolve
    resolve = null
    aside.classList.remove('notes-sidebar--editing')
    body.replaceChildren()
    aside.hidden = !visible
    done(value)
  }

  // On the panel, not the textarea, so a Tab onto the buttons can't leak a
  // keydown to the window (where Tab means "overview").
  aside.addEventListener('keydown', (event) => {
    if (!resolve) return
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      finish(null)
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.repeat) {
      // Not on a repeat: the chord that opened this panel, held down, would
      // otherwise save it the moment the textarea takes focus.
      event.preventDefault()
      finish(textarea.value.trim())
    }
  })

  const textarea = document.createElement('textarea')
  textarea.className = 'notes-textarea'
  textarea.spellcheck = true

  /** Edit mode. Resolves with the trimmed notes on Save, or null if cancelled. */
  function edit(name, notes) {
    finish(null)
    heading.textContent = name
    textarea.value = notes ?? ''

    const hint = document.createElement('p')
    hint.className = 'notes-hint'
    hint.textContent = 'Enter: new line · Ctrl/⌘+Enter: save · Esc: cancel'

    const actions = document.createElement('div')
    actions.className = 'editor-actions'
    const cancelButton = document.createElement('button')
    cancelButton.type = 'button'
    cancelButton.className = 'editor-button editor-button--secondary'
    cancelButton.textContent = 'Cancel'
    cancelButton.addEventListener('click', () => finish(null))
    const saveButton = document.createElement('button')
    saveButton.type = 'button'
    saveButton.className = 'editor-button editor-button--primary'
    saveButton.textContent = 'Save'
    saveButton.addEventListener('click', () => finish(textarea.value.trim()))
    actions.append(cancelButton, saveButton)

    body.classList.remove('notes-body--empty')
    body.replaceChildren(textarea, hint, actions)
    aside.classList.add('notes-sidebar--editing')
    aside.hidden = false

    const promise = new Promise((settle) => {
      resolve = settle
    })
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    return promise
  }

  return {
    show,
    edit,
    cancel: () => finish(null),
    toggle: () => setVisible(!visible),
    get isVisible() {
      return visible
    },
    get isEditing() {
      return resolve !== null
    },
  }
}
