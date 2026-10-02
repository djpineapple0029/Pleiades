/**
 * The notes panel on the right. Two modes:
 *
 * - **View**, toggled with N: read-only, never takes the mouse, and shows the
 *   notes of whatever star is under the crosshair (the caller decides which).
 *   With no star targeted there is no panel at all, not an empty one.
 * - **Edit**, from Ctrl/Cmd+Enter: a real textarea with a real cursor — the
 *   caller releases pointer lock first. The caller binds the textarea to the
 *   star's shared text (room/notesBinding.js), so what's typed is in the map
 *   as it's typed (context/MOONSHOT.md decision 8). Enter is a newline here,
 *   since notes are prose; Done (or Ctrl/Cmd+Enter, for the keyboard-only)
 *   keeps it, Esc or Cancel takes this session's typing back out.
 */
export function createNotesSidebar(aside, { writeKey = 'Ctrl/⌘+Enter' } = {}) {
  const heading = document.createElement('p')
  heading.className = 'notes-title'
  const body = document.createElement('div')
  body.className = 'notes-body'
  aside.append(heading, body)

  let visible = false // off on every load; N turns it on for the session
  let hasTarget = false // a star was under the crosshair at the last `show`
  let resolve = null
  aside.hidden = true

  function setVisible(value) {
    visible = value
    if (!resolve) aside.hidden = !visible || !hasTarget
  }

  /** View mode: `name` and `notes` of the targeted star, or null for none. */
  function show(target) {
    if (resolve) return
    hasTarget = Boolean(target)
    aside.hidden = !visible || !hasTarget
    if (!target) return
    body.classList.remove('notes-body--empty')
    heading.textContent = target.name
    if (target.notes) {
      body.textContent = target.notes
    } else {
      body.textContent = writeKey ? `no notes · ${writeKey} to write` : 'no notes'
      body.classList.add('notes-body--empty')
    }
  }

  function finish(value) {
    if (!resolve) return
    const done = resolve
    resolve = null
    aside.classList.remove('notes-sidebar--editing')
    body.replaceChildren()
    aside.hidden = !visible || !hasTarget
    done(value)
  }

  // On the panel, not the textarea, so a Tab onto the buttons can't leak a
  // keydown to the window (where Tab means "overview").
  aside.addEventListener('keydown', (event) => {
    if (!resolve) return
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      finish(false)
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.repeat) {
      // Not on a repeat: the chord that opened this panel, held down, would
      // otherwise close it the moment the textarea takes focus.
      event.preventDefault()
      finish(true)
    }
  })

  const textarea = document.createElement('textarea')
  textarea.className = 'notes-textarea'
  textarea.spellcheck = true
  // Other people's carets in a shared map (room/notesCursors.js) draw in a
  // layer over the textarea; clicks go through it.
  const field = document.createElement('div')
  field.className = 'notes-field'
  const cursorLayer = document.createElement('div')
  cursorLayer.className = 'notes-cursors'
  field.append(textarea, cursorLayer)

  /**
   * Edit mode. `bind(textarea)` connects it to the notes (and fills it).
   * Resolves true on Done, false if cancelled (Esc, Cancel, or `cancel()`).
   */
  function edit(name, bind) {
    finish(false)
    heading.textContent = name
    textarea.value = ''
    bind(textarea)

    const hint = document.createElement('p')
    hint.className = 'notes-hint'
    hint.textContent = 'Saved as you type · Enter: new line · Ctrl/⌘+Enter: done · Esc: undo this edit'

    const actions = document.createElement('div')
    actions.className = 'editor-actions'
    const cancelButton = document.createElement('button')
    cancelButton.type = 'button'
    cancelButton.className = 'editor-button editor-button--secondary'
    cancelButton.textContent = 'Cancel'
    cancelButton.addEventListener('click', () => finish(false))
    const saveButton = document.createElement('button')
    saveButton.type = 'button'
    saveButton.className = 'editor-button editor-button--primary'
    saveButton.textContent = 'Done'
    saveButton.addEventListener('click', () => finish(true))
    actions.append(cancelButton, saveButton)

    body.classList.remove('notes-body--empty')
    body.replaceChildren(field, hint, actions)
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
    cancel: () => finish(false),
    /** Where other people's carets are drawn while editing. */
    cursorLayer,
    toggle: () => setVisible(!visible),
    get isVisible() {
      return visible
    },
    get isEditing() {
      return resolve !== null
    },
  }
}
