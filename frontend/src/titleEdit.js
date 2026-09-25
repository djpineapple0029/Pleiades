/** The draft a label shows while it's being typed: the text with a caret in it. */
export function draftText(value, caret) {
  const at = Math.max(0, Math.min(caret ?? value.length, value.length))
  return `${value.slice(0, at)}|${value.slice(at)}`
}

/**
 * Renaming a star or connection in place, without leaving pointer lock.
 *
 * The text lives in an invisible `<input>` rather than a panel: focusing it
 * gives native key repeat, arrows, paste, IME and word-delete for free, and
 * pointer lock only captures the mouse, so the field still takes keystrokes.
 * What the user sees is the label itself, fed each change through `onDraft`.
 * The caller suspends flight and mouse-look while this is active.
 *
 * Enter commits; Esc cancels (the browser also drops pointer lock on Esc, and
 * the caller's unlock handling calls `cancel` for that path too).
 */
export function createTitleEdit(container = document.body) {
  const input = document.createElement('input')
  input.className = 'title-edit-input'
  input.type = 'text'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.tabIndex = -1
  input.setAttribute('aria-label', 'Label')
  container.append(input)

  let resolve = null
  let onDraft = null

  function push() {
    if (resolve) onDraft(draftText(input.value, input.selectionStart))
  }

  function finish(value) {
    if (!resolve) return
    const done = resolve
    resolve = null
    onDraft = null
    document.removeEventListener('selectionchange', push)
    input.blur()
    input.value = ''
    done(value)
  }

  input.addEventListener('keydown', (event) => {
    // Nothing typed here should also reach flight, the lock or the map keys.
    event.stopPropagation()
    if (event.key === 'Enter') {
      event.preventDefault()
      finish(input.value.trim())
    } else if (event.key === 'Escape') {
      finish(null)
    } else if (event.key === 'Tab') {
      event.preventDefault()
    } else if ((event.metaKey || event.ctrlKey) && ['KeyS', 'KeyO', 'KeyE'].includes(event.code)) {
      // The browser's own save-page / open-file dialogs would steal the lock.
      event.preventDefault()
    }
  })
  input.addEventListener('input', push)
  // Nothing else should ever hold focus while an edit is up — a stray click
  // would otherwise leave the user typing into nothing.
  input.addEventListener('blur', () => {
    if (resolve) queueMicrotask(() => resolve && input.focus())
  })

  /** Resolves with the trimmed text on Enter, or null if cancelled. */
  function start(initial, draftCallback) {
    finish(null)
    onDraft = draftCallback
    input.value = initial ?? ''
    const promise = new Promise((settle) => {
      resolve = settle
    })
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    document.addEventListener('selectionchange', push)
    push()
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
