/**
 * Centred panel for the file flows: save/open prompts and the unsaved-changes
 * confirm. (Renaming is done in place — `titleEdit.js` — and notes in the
 * sidebar — `notesSidebar.js`.) The caller releases pointer lock first, so
 * there's a real cursor for the buttons, and suspends flight input, since
 * W/A/S/D have to reach the fields instead of the camera.
 */
export function createEditor(container) {
  const panel = document.createElement('div')
  panel.className = 'editor-panel'
  container.append(panel)

  // Field descriptors alongside their elements: committing has to know which
  // ones are passwords, since trimming one would silently alter it. `input`
  // is always a direct reference to the real element, even for a password
  // field — see `createPasswordInput` below for why that matters.
  let entries = []
  let resolve = null
  let choices = null // [{ key, label }] while a confirm panel is open, else null

  const inputs = () => entries.map((entry) => entry.input)

  function finish(value) {
    if (!resolve) return
    const done = resolve
    resolve = null
    entries = []
    choices = null
    panel.replaceChildren()
    panel.removeAttribute('tabindex')
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

  /**
   * Shared by every field. Bound both on the panel (for ordinary fields) and
   * directly on each password `<input>` (for fields hidden in a shadow root
   * — see below): a keydown that starts inside a shadow tree is retargeted
   * to the shadow *host* by the time it would reach a panel-level listener,
   * so `fields.indexOf(event.target)` would never match the real input.
   * Listening from inside the tree sidesteps that entirely.
   */
  function onKeyDown(event) {
    // Nothing typed in here should also reach the flight or lock handlers.
    event.stopPropagation()

    if (event.key === 'Escape') {
      finish(null)
      return
    }

    if (choices) {
      // Keyed-choice mode: no input fields, so none of the Tab-cycling or
      // per-field Enter logic below applies — just match the pressed key
      // against each choice's letter.
      const hit = choices.find((choice) => choice.key.toLowerCase() === event.key.toLowerCase())
      if (hit) finish(hit.key)
      return
    }

    const fields = inputs()
    const at = fields.indexOf(event.target)

    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      finish(collect())
      return
    }
    // A dropdown's trigger is a button: Enter on it commits like a field
    // would, and preventDefault keeps it from also clicking the list open.
    if (event.key === 'Enter' && (event.target.tagName === 'INPUT' || at !== -1)) {
      event.preventDefault()
      // Enter behaves like "next field, or commit from the last one" — this
      // is the mouse-and-Enter workflow most ordinary web forms use, rather
      // than committing from wherever the cursor happens to be. Ctrl/Cmd+Enter
      // above is the unconditional "commit now" escape hatch.
      if (at === -1 || at === fields.length - 1) {
        finish(collect())
      } else {
        fields[at + 1].focus()
        fields[at + 1].select?.()
      }
      return
    }
    if (event.key === 'Tab') {
      // Always handled, even with one field: an unhandled Tab would escape
      // the panel to whatever the browser focuses next — the address bar, a
      // dev tool, nothing at all — leaving a modal surface up with no way
      // back to it but a mouse click.
      event.preventDefault()
      const step = event.shiftKey ? -1 : 1
      const from = at === -1 ? 0 : at
      const next = (from + step + fields.length) % fields.length
      fields[next].focus()
      fields[next].select?.()
    }
  }

  panel.addEventListener('keydown', onKeyDown)

  /**
   * A password field lives inside its own closed shadow root, not the light
   * DOM. `autocomplete="off"` alone no longer keeps most password managers
   * from injecting a fill icon or an save-this-password popover on top of
   * the field — they find it by walking the document looking for
   * `input[type=password]`, and a closed shadow root is exactly the thing
   * that walk can't see into. `editor.js` still holds a direct reference to
   * the real `<input>` (returned alongside `host`), so everything here —
   * focus, `.value`, keydown — works exactly as if it were a normal field;
   * only code outside this module (an extension's content script,
   * `document.querySelector`) is shut out.
   */
  function createPasswordInput() {
    const host = document.createElement('span')
    host.className = 'editor-password-host'
    const root = host.attachShadow({ mode: 'closed' })

    const style = document.createElement('style')
    style.textContent = `
      input {
        display: block;
        box-sizing: border-box;
        width: 100%;
        padding: 6px 8px;
        border: 1px solid #2a3140;
        border-radius: 3px;
        background: #11141c;
        color: var(--ink);
        font: inherit;
      }
      input:focus { outline: none; border-color: #6fc7ff; }
    `
    const input = document.createElement('input')
    input.type = 'password'
    input.autocomplete = 'off'
    input.spellcheck = false
    // Heuristics that don't rely on `type=password` often key off `name`/`id`
    // instead (matching against a nearby username field, etc.) — give them
    // nothing to pattern-match against, on top of the shadow boundary.
    input.name = ''
    root.append(style, input)

    return { host, input }
  }

  /**
   * A dropdown of `field.options` (`{ value, label, detail, swatch }`), drawn
   * here rather than as a native `<select>`, whose popup is the OS's and
   * looks nothing like the panel. The trigger is a `<button>` whose `value`
   * is the chosen option's, so `collect` and Tab treat it like any input.
   * Focus stays on the trigger while the list is open (the list follows via
   * `aria-activedescendant`), so a click anywhere else blurs it and closes.
   */
  function createSelect(field) {
    const host = document.createElement('div')
    host.className = 'editor-select'

    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'editor-select-trigger'
    trigger.setAttribute('aria-label', field.label)
    trigger.setAttribute('aria-haspopup', 'listbox')
    trigger.setAttribute('aria-expanded', 'false')

    const list = document.createElement('ul')
    list.className = 'editor-select-list'
    list.setAttribute('role', 'listbox')
    list.id = `editor-select-${field.key}`
    list.hidden = true
    trigger.setAttribute('aria-controls', list.id)

    const options = field.options
    let active = 0 // index of the highlighted row while the list is open

    const swatchOf = (option) => {
      const swatch = document.createElement('span')
      swatch.className = 'editor-select-swatch'
      if (option.swatch) {
        swatch.style.background = option.swatch.ground
        for (const dot of option.swatch.dots) {
          const star = document.createElement('i')
          star.style.background = dot
          swatch.append(star)
        }
      }
      return swatch
    }

    const rows = options.map((option, index) => {
      const row = document.createElement('li')
      row.className = 'editor-select-option'
      row.id = `${list.id}-${index}`
      row.setAttribute('role', 'option')
      const text = document.createElement('span')
      text.className = 'editor-select-text'
      const name = document.createElement('span')
      name.className = 'editor-select-name'
      name.textContent = option.label
      text.append(name)
      if (option.detail) {
        const detail = document.createElement('span')
        detail.className = 'editor-select-detail'
        detail.textContent = option.detail
        text.append(detail)
      }
      row.append(swatchOf(option), text)
      // mousedown, not click: the trigger must keep focus, or its blur would
      // close the list before the click lands.
      row.addEventListener('mousedown', (event) => event.preventDefault())
      row.addEventListener('mousemove', () => highlight(index))
      row.addEventListener('click', () => pick(index))
      list.append(row)
      return row
    })

    function show(index) {
      const option = options[index]
      trigger.value = option.value
      trigger.replaceChildren(swatchOf(option))
      const name = document.createElement('span')
      name.className = 'editor-select-name'
      name.textContent = option.label
      const caret = document.createElement('span')
      caret.className = 'editor-select-caret'
      trigger.append(name, caret)
      rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === index)))
    }

    function highlight(index) {
      active = (index + options.length) % options.length
      rows.forEach((row, i) => row.classList.toggle('active', i === active))
      trigger.setAttribute('aria-activedescendant', rows[active].id)
    }

    const isOpen = () => !list.hidden

    function openList() {
      list.hidden = false
      trigger.setAttribute('aria-expanded', 'true')
      highlight(
        Math.max(
          0,
          options.findIndex((option) => option.value === trigger.value),
        ),
      )
    }

    function closeList() {
      list.hidden = true
      trigger.setAttribute('aria-expanded', 'false')
      trigger.removeAttribute('aria-activedescendant')
    }

    function pick(index) {
      show(index)
      closeList()
    }

    trigger.addEventListener('click', () => (isOpen() ? closeList() : openList()))
    trigger.addEventListener('blur', closeList)
    // Runs before the panel's own handler (it bubbles there next), so the
    // keys the list owns while open never reach it: Esc closes the list, not
    // the panel, and Enter picks a row rather than committing.
    trigger.addEventListener('keydown', (event) => {
      if (!isOpen()) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === ' ') {
          event.preventDefault()
          openList()
        }
        return
      }
      if (event.key === 'Tab') {
        closeList()
        return
      }
      event.stopPropagation()
      if (event.key === 'Escape') closeList()
      else if (event.key === 'ArrowDown') highlight(active + 1)
      else if (event.key === 'ArrowUp') highlight(active - 1)
      else if (event.key === 'Home') highlight(0)
      else if (event.key === 'End') highlight(options.length - 1)
      else if (event.key === 'Enter' || event.key === ' ') pick(active)
      else return
      event.preventDefault()
    })

    show(
      Math.max(
        0,
        options.findIndex((option) => option.value === field.value),
      ),
    )
    host.append(trigger, list)
    return { host, input: trigger }
  }

  /**
   * `fields` are `{ key, label, value, type, maxLength }`; `type: 'password'`
   * masks the field and keeps its value untrimmed. `type: 'select'` is a
   * dropdown of the field's `options` (see `createSelect`). `note` is shown above the
   * fields — a rejected password or a mismatch, on a re-prompt. `commitLabel`
   * names the primary button (default "Save"). Resolves with a `{ key: value
   * }` map on commit, or null if cancelled.
   */
  function open(title, fields, note = null, commitLabel = 'Save') {
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
      // A div for a dropdown: inside a <label>, a click on a list row would
      // also be forwarded to the trigger and open the list straight back up.
      const row = document.createElement(field.type === 'select' ? 'div' : 'label')
      row.className = 'editor-row'

      const name = document.createElement('span')
      name.textContent = field.label
      row.append(name)

      if (field.type === 'select') {
        const { host, input } = createSelect(field)
        row.append(host)
        panel.append(row)
        return { field, input }
      }

      if (field.type === 'password') {
        const { host, input } = createPasswordInput()
        input.value = field.value ?? ''
        input.addEventListener('keydown', onKeyDown)
        row.append(host)
        panel.append(row)
        return { field, input }
      }

      const input = document.createElement('input')
      input.value = field.value ?? ''
      input.spellcheck = false
      if (field.maxLength) input.maxLength = field.maxLength
      row.append(input)

      panel.append(row)
      return { field, input }
    })

    const hint = document.createElement('p')
    hint.className = 'editor-hint'
    const verb = commitLabel.toLowerCase()
    // Enter alone commits directly from a single field, or walks to the next
    // one and commits from the last.
    const commit = fields.length > 1 ? `Enter: next field, ${verb} from the last` : `Enter: ${verb}`
    const parts = fields.length > 1 ? [commit, 'Tab: field'] : [commit]
    hint.textContent = [...parts, 'Esc: cancel'].join(' · ')
    panel.append(hint)

    const actions = document.createElement('div')
    actions.className = 'editor-actions'
    const cancelButton = document.createElement('button')
    cancelButton.type = 'button'
    cancelButton.className = 'editor-button editor-button--secondary'
    cancelButton.textContent = 'Cancel'
    cancelButton.addEventListener('click', () => finish(null))
    const commitButton = document.createElement('button')
    commitButton.type = 'button'
    commitButton.className = 'editor-button editor-button--primary'
    commitButton.textContent = commitLabel
    commitButton.addEventListener('click', () => finish(collect()))
    actions.append(cancelButton, commitButton)
    panel.append(actions)

    container.hidden = false
    const [first] = inputs()
    first.focus()
    first.select?.()

    return new Promise((settle) => {
      resolve = settle
    })
  }

  /**
   * A modal panel with no input fields: a title, an optional one-line note,
   * and a row of keyed choices (`{ key, label }`) shown as buttons. Resolves
   * with the chosen key, or null on Escape/cancel. There is no field to
   * focus, so the panel itself takes focus — it needs `tabIndex` for that,
   * since it holds no naturally focusable element.
   */
  function confirm(title, note, choiceList) {
    finish(null)
    choices = choiceList

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

    const actions = document.createElement('div')
    actions.className = 'editor-actions'
    for (const choice of choiceList) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'editor-button editor-button--secondary'
      button.textContent = choice.label
      button.addEventListener('click', () => finish(choice.key))
      actions.append(button)
    }
    panel.append(actions)

    const hint = document.createElement('p')
    hint.className = 'editor-hint'
    hint.textContent = [...choiceList.map((choice) => choice.label), 'Esc: cancel'].join(' · ')
    panel.append(hint)

    container.hidden = false
    panel.tabIndex = -1
    panel.focus()

    return new Promise((settle) => {
      resolve = settle
    })
  }

  return {
    open,
    confirm,
    cancel: () => finish(null),
    get isOpen() {
      return resolve !== null
    },
  }
}
