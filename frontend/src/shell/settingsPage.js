/**
 * Settings (USERS.md decision 7b / 17): a signed-in user's own settings and
 * keys, over the server's (server/account.py). Only what they change is kept;
 * everything else follows /admin, including later changes there.
 *
 * Modelled on the /admin panel's settings and keybind rows, which can't be
 * shared: that page has no build step. Saved values reach a map the next time
 * one opens (`/api/config` is read at startup).
 */
import schema from '../../../server/settings_schema.json'
import { chordCaps, chordFromEvent, parseChord } from '../keymap.js'
import { LOOKS } from '../looks.js'

const SECTION_TITLES = { flight: 'Flight & feel', visuals: 'Visual effects' }
const MAX_BINDINGS = 3
const IS_MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '')
const CHOICE_NAMES = { look: new Map(LOOKS.map((look) => [look.id, look.name])) }

const SETTINGS = schema.settings.filter((spec) => spec.user)
const ACTIONS = schema.keybinds.filter((action) => action.user)

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

function button(label, onClick, className = 'quiet small') {
  const node = el('button', { type: 'button', className, textContent: label })
  node.addEventListener('click', onClick)
  return node
}

/** `Mod+S` as its key caps read: `Ctrl/⌘+S`. */
export function prettyChord(text) {
  const chord = parseChord(text)
  return chord ? chordCaps(chord).join('+') : text
}

/** A setting's value as a person reads it. */
export function prettyValue(spec, value) {
  if (spec.type === 'boolean') return value ? 'on' : 'off'
  if (spec.type === 'choice') return CHOICE_NAMES[spec.key]?.get(value) ?? value
  return String(value)
}

/** Overrides as a stable string, so two with the same content compare equal. */
export function overridesKey(overrides) {
  const sorted = (value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : value
  return JSON.stringify(sorted(overrides ?? {}))
}

/** `"keybinds.heat: B clashes with…"` → `['keybinds.heat', 'B clashes with…']`. */
export function errorPath(text) {
  const match = /^([a-z_]+\.[a-z_]+): (.*)$/s.exec(text)
  return match ? [match[1], match[2]] : [null, text]
}

/**
 * `request` is api.js's; `onSignedOut(result)` is the shell's 401 handler and
 * returns true when it took over.
 */
export function createSettingsPage({ root, request, onSignedOut }) {
  let server = null // the admin's client values
  let saved = null // the user's overrides as last stored
  let draft = null // what the page shows
  let problems = []
  let errors = {} // path -> message
  let formError = ''
  let status = ''
  let listening = null // action id waiting for a key
  let saving = false

  const isDirty = () => draft !== null && overridesKey(draft) !== overridesKey(saved)

  function mine(section, key) {
    return draft[section]?.[key]
  }

  function setMine(section, key, value) {
    if (value === undefined) {
      if (draft[section]) {
        delete draft[section][key]
        if (!Object.keys(draft[section]).length) delete draft[section]
      }
    } else {
      ;(draft[section] ??= {})[key] = value
    }
    status = ''
    delete errors[`${section}.${key}`]
  }

  function changed({ rerender = true } = {}) {
    if (rerender) render()
    else renderBar()
  }

  async function open() {
    // Coming back to the page keeps a draft in progress.
    if (isDirty()) return render()
    root.replaceChildren(el('p', { className: 'note', textContent: 'Loading your settings…' }))
    const result = await request('api/account/settings')
    if (!result.ok) {
      if (onSignedOut(result)) return
      root.replaceChildren(
        el('p', { className: 'error', textContent: `Could not load your settings: ${result.error}` }),
      )
      return
    }
    take(result.data)
    status = ''
    render()
  }

  function take(data) {
    server = data.server
    saved = data.overrides ?? {}
    draft = structuredClone(saved)
    problems = data.problems ?? []
    errors = {}
    formError = ''
  }

  async function save() {
    if (saving) return
    saving = true
    status = 'Saving…'
    renderBar()
    const result = await request('api/account/settings', { method: 'PUT', body: draft })
    saving = false
    if (!result.ok) {
      if (onSignedOut(result)) return
      errors = {}
      formError = ''
      const listed = Array.isArray(result.data?.errors) ? result.data.errors : [result.error]
      for (const text of listed) {
        const [path, message] = errorPath(text)
        if (path) errors[path] = errors[path] ? `${errors[path]} ${message}` : message
        else formError = formError ? `${formError} ${message}` : message
      }
      status = ''
      render()
      return
    }
    take(result.data)
    status = 'Saved. Maps open with these from now on.'
    render()
  }

  function discard() {
    draft = structuredClone(saved)
    errors = {}
    formError = ''
    status = ''
    render()
  }

  // --- Rendering --------------------------------------------------------------

  let bar = null

  function render() {
    if (!draft) return
    const intro = el('p', {
      className: 'note intro',
      textContent:
        "Your own settings, on top of this server's. They apply the next time you open a map, on any device you sign in on. Anything you leave alone follows the server.",
    })
    const nodes = [intro]
    if (problems.length) {
      nodes.push(
        el(
          'div',
          { className: 'banner problems', role: 'status' },
          el('p', {
            textContent: 'Some of your settings no longer work on this server, so its own are used:',
          }),
          el('ul', {}, ...problems.map((text) => el('li', { textContent: text }))),
        ),
      )
    }
    for (const section of [...new Set(SETTINGS.map((spec) => spec.section))]) {
      const card = el(
        'div',
        { className: 'card' },
        el('h2', { textContent: SECTION_TITLES[section] ?? section }),
      )
      for (const spec of SETTINGS.filter((s) => s.section === section)) card.append(settingRow(spec))
      nodes.push(card)
    }
    const groups = new Map()
    for (const action of ACTIONS) {
      if (!groups.has(action.group)) groups.set(action.group, [])
      groups.get(action.group).push(action)
    }
    for (const [group, actions] of groups) {
      const card = el('div', { className: 'card keys-card' }, el('h2', { textContent: `Keys: ${group}` }))
      for (const action of actions) card.append(keyRow(action))
      nodes.push(card)
    }
    bar = el('div', { className: 'savebar' })
    nodes.push(bar)
    root.replaceChildren(...nodes)
    renderBar()
  }

  function renderBar() {
    if (!bar) return
    const dirty = isDirty()
    bar.classList.toggle('dirty', dirty)
    const text = el('span', {
      className: 'state',
      role: 'status',
      textContent: status || (dirty ? 'Unsaved changes' : 'No unsaved changes'),
    })
    const discardButton = button('Discard', discard, 'quiet')
    const saveButton = button('Save', save, '')
    discardButton.disabled = !dirty || saving
    saveButton.disabled = !dirty || saving
    saveButton.id = 'settings-save'
    const nodes = [text, discardButton, saveButton]
    if (formError) nodes.unshift(el('p', { className: 'error', role: 'alert', textContent: formError }))
    bar.replaceChildren(...nodes)
  }

  /** "yours" + "Use server's (X)", or a quiet "server's" when not overridden. */
  function origin(overridden, serverText, reset) {
    if (!overridden) return el('span', { className: 'origin', textContent: "server's" })
    const back = button(`Use server's (${serverText})`, reset)
    back.classList.add('reset')
    return el(
      'span',
      { className: 'origin mine' },
      el('span', { className: 'tag', textContent: 'yours' }),
      back,
    )
  }

  function settingRow(spec) {
    const { section, key } = spec
    const path = `${section}.${key}`
    const id = `mine-${section}-${key}`
    const overridden = mine(section, key) !== undefined
    const value = overridden ? mine(section, key) : server[section][key]
    const row = el('div', { className: 'setting' })
    row.dataset.path = path
    row.classList.toggle('overridden', overridden)

    const control = el('div', { className: 'control' })
    const reset = () => {
      setMine(section, key, undefined)
      changed()
    }
    const set = (v, opts) => {
      setMine(section, key, v)
      changed(opts)
    }
    // A number being typed or slid updates its own row in place: re-rendering
    // the page on blur would move whatever button the click was headed for.
    const setInPlace = (v) => {
      set(v, { rerender: false })
      row.querySelector('.error')?.remove()
      if (row.classList.contains('overridden')) return
      row.classList.add('overridden')
      row.querySelector('.origin').replaceWith(origin(true, prettyValue(spec, server[section][key]), reset))
    }
    if (spec.type === 'boolean') {
      const box = el('input', { type: 'checkbox', id, checked: value })
      box.addEventListener('change', () => set(box.checked))
      control.append(box)
    } else if (spec.type === 'choice') {
      const select = el('select', { id })
      for (const option of spec.options) {
        select.append(new Option(prettyValue(spec, option), option, false, option === value))
      }
      select.addEventListener('change', () => set(select.value))
      control.append(select)
    } else {
      const step = spec.step ?? 1
      const number = el('input', { type: 'number', id, min: spec.min, max: spec.max, step, value })
      const parse = (text) => (spec.type === 'integer' ? parseInt(text, 10) : parseFloat(text))
      const inRange = (v) => Number.isFinite(v) && v >= spec.min && v <= spec.max
      if (spec.type === 'number') {
        const range = el('input', { type: 'range', min: spec.min, max: spec.max, step, value })
        range.setAttribute('aria-label', spec.label)
        range.addEventListener('input', () => {
          number.value = range.value
          setInPlace(parse(range.value))
        })
        control.append(range)
        number.addEventListener('input', () => {
          if (number.value !== '') range.value = number.value
        })
      }
      number.addEventListener('input', () => {
        const v = parse(number.value)
        if (inRange(v)) setInPlace(v)
      })
      control.append(number)
    }

    const head = el(
      'div',
      { className: 'head' },
      el('label', { htmlFor: id, textContent: spec.label }),
      control,
    )
    const foot = el(
      'div',
      { className: 'foot' },
      el('p', { className: 'help', textContent: spec.help }),
      origin(overridden, prettyValue(spec, server[section][key]), reset),
    )
    row.append(head, foot)
    if (errors[path]) row.append(el('p', { className: 'error', role: 'alert', textContent: errors[path] }))
    return row
  }

  function keyRow(action) {
    const path = `keybinds.${action.id}`
    const overridden = mine('keybinds', action.id) !== undefined
    const current = overridden ? mine('keybinds', action.id) : server.keybinds[action.id]
    const row = el('div', { className: 'bind-row' })
    row.dataset.path = path
    row.classList.toggle('overridden', overridden)

    const name = el('div', { className: 'name', textContent: action.label })
    const chips = el('div', { className: 'chips' })
    current.forEach((chord, i) => {
      const remove = button('×', () => {
        setMine(
          'keybinds',
          action.id,
          current.filter((_, j) => j !== i),
        )
        changed()
      })
      remove.className = 'remove'
      remove.setAttribute('aria-label', `Remove ${prettyChord(chord)} from ${action.label}`)
      chips.append(el('span', { className: 'chip' }, el('kbd', { textContent: prettyChord(chord) }), remove))
    })
    if (!current.length) chips.append(el('span', { className: 'note', textContent: 'no key' }))

    const isListening = listening === action.id
    const add = button(isListening ? 'press a key… (Esc cancels)' : '+ key', () => {
      listening = isListening ? null : action.id
      render()
      if (listening) root.querySelector(`[data-path="${path}"] .add`)?.focus()
    })
    add.classList.add('add')
    add.classList.toggle('listening', isListening)
    add.disabled = !isListening && current.length >= MAX_BINDINGS
    chips.append(add)

    const serverKeys = server.keybinds[action.id].map(prettyChord).join(', ') || 'no key'
    row.append(
      el('div', { className: 'head' }, name, chips),
      el(
        'div',
        { className: 'foot' },
        el('span'),
        origin(overridden, serverKeys, () => {
          setMine('keybinds', action.id, undefined)
          changed()
        }),
      ),
    )
    if (errors[path]) row.append(el('p', { className: 'error', role: 'alert', textContent: errors[path] }))
    return row
  }

  // A key pressed while a "+ key" is waiting becomes that action's next key.
  document.addEventListener(
    'keydown',
    (event) => {
      if (!listening) return
      event.preventDefault()
      event.stopPropagation()
      const action = ACTIONS.find((a) => a.id === listening)
      if (event.key === 'Escape') {
        listening = null
        render()
        return
      }
      const chord = chordFromEvent(event, { movement: Boolean(action.movement), mac: IS_MAC })
      if (chord === null) return
      listening = null
      if (chord === undefined) {
        errors[`keybinds.${action.id}`] = `${event.key} can't be a key here.`
        render()
        return
      }
      const list = mine('keybinds', action.id) ?? server.keybinds[action.id]
      if (!list.includes(chord)) setMine('keybinds', action.id, [...list, chord])
      changed()
    },
    true,
  )

  return {
    open,
    get isDirty() {
      return isDirty()
    },
    /** Signed out: drop everything, unsaved changes included. */
    forget() {
      server = saved = draft = bar = null
      problems = []
      errors = {}
      formError = status = ''
      listening = null
      root.replaceChildren()
    },
    /** The page is being left: stop waiting for a key. */
    close() {
      if (listening) {
        listening = null
        render()
      }
    },
  }
}
