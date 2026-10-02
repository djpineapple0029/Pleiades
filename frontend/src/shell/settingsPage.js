/**
 * Settings (USERS.md decision 7b / 17): a signed-in user's own settings and
 * keys (server/account.py). The defaults are this server's, from /admin. Only
 * what they change is kept; everything else follows the default, including
 * later changes to it.
 *
 * Modelled on the /admin panel's settings and keybind rows, which can't be
 * shared: that page has no build step. Saved values reach a map the next time
 * one opens (`/api/config` is read at startup).
 */
import schema from '../../../server/settings_schema.json'
import { chordCaps, chordFromEvent, parseChord } from '../keymap.js'
import { LOOKS } from '../looks.js'

const SECTION_TITLES = { flight: 'Flight', visuals: 'Visuals', multiplayer: 'Shared maps' }
const GROUP_TITLES = {
  Flight: 'Moving',
  View: 'Viewing',
  Edit: 'Editing',
  File: 'Files',
  Multiplayer: 'Shared maps',
}
// This page's own wording: shorter and plainer than the schema's help, which
// is written for the admin panel.
// Short names for the keys, like a game's controls screen; the schema's
// labels are full sentences for the admin panel.
const KEY_NAMES = {
  resume: 'Fly again after releasing the pointer',
  overview: 'Overview',
  help: 'Show the key list',
  search: 'Find a star',
  jump_back: 'Fly back after a jump',
  notes_sidebar: 'Notes sidebar',
  look: 'Pick a look (hold)',
  heat: 'Connection heat',
  orbit: 'Lay out round a star',
  path: 'Path between two stars',
  rename: 'Rename a star or link',
  edit_notes: 'Edit notes',
  balance: 'Balance the layout',
  tree_shape: 'Pick a layout shape (hold)',
  save: 'Save',
  save_as: 'Save as',
  open: 'Open a file',
  export: 'Export a view-only page',
  chat: 'Chat',
  emote: 'Emote (hold)',
  follow: 'Follow someone',
}
const DESCRIPTIONS = {
  'flight.mouse_sensitivity': 'How far the view turns when you move the mouse. 1 is the original feel.',
  'flight.invert_y': 'Push the mouse forward to look down, like a flight stick.',
  'flight.move_speed': 'How fast you fly before the scroll wheel speeds you up.',
  'flight.max_speed_multiplier':
    'The fastest the scroll wheel can take you, as a multiple of your flight speed.',
  'visuals.look':
    'The look your maps open in. In a map, hold V to pick another; that choice is saved here too.',
  'visuals.dust_rivers': 'Dust that circles stars and drifts along links.',
  'visuals.supernova': 'A flash and a shockwave when you delete a star.',
  'visuals.node_brightness': 'How bright stars are. 1 is the original.',
  'visuals.bloom_strength': 'How much light spreads out from stars as glow.',
  'visuals.label_range': 'How far away star names start to appear.',
  'visuals.label_count': 'Roughly how many star names show at once.',
  'visuals.connection_heat':
    'Colour links from cool blue to hot red by how connected their stars are. H switches it in a map.',
  'multiplayer.show_editor_avatars':
    "In a shared map, draw the people who can edit it. They're still there when hidden. The Esc screen switches it too.",
  'multiplayer.show_viewer_avatars':
    "In a shared map, draw the people who can only look. They're still there when hidden. The Esc screen switches it too.",
}
const MAX_BINDINGS = 3
const SAVED_NOTE_MS = 4000
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
  let listening = null // { id, slot } waiting for a key
  let saving = false

  const isDirty = () => draft !== null && overridesKey(draft) !== overridesKey(saved)

  function mine(section, key) {
    return draft[section]?.[key]
  }

  /** What this key is when not overridden: the admin's value. */
  function defaultOf(section, key) {
    return server[section][key]
  }

  function setMine(section, key, value) {
    // Edited back to how it was saved (or to the default, if it had no value
    // of its own): exactly the saved state again, so nothing is left to save.
    const was = saved[section]?.[key]
    const baseline = was !== undefined ? was : defaultOf(section, key)
    if (value !== undefined && JSON.stringify(value) === JSON.stringify(baseline)) value = was
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
    // The bar goes once it has said so, unless something new needs saving.
    const said = status
    setTimeout(() => {
      if (status !== said) return
      status = ''
      renderBar()
    }, SAVED_NOTE_MS)
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
    const resetAll = button('Reset all to default', resetEverything, 'reset')
    resetAll.id = 'settings-reset-all'
    resetAll.disabled = !Object.keys(draft).length
    const nodes = [
      el(
        'header',
        { className: 'page-head' },
        el(
          'div',
          {},
          el('h1', { textContent: 'Settings' }),
          el('p', {
            textContent: 'Changes apply the next time you open a map, on any device you sign in on.',
          }),
        ),
        resetAll,
      ),
    ]
    if (problems.length) {
      nodes.push(
        el(
          'div',
          { className: 'banner problems', role: 'status' },
          el('p', { textContent: 'Some of your settings no longer work here, so the default is used:' }),
          el('ul', {}, ...problems.map((text) => el('li', { textContent: text }))),
        ),
      )
    }
    for (const section of [...new Set(SETTINGS.map((spec) => spec.section))]) {
      nodes.push(
        el(
          'section',
          { className: 'group' },
          el('h2', { textContent: SECTION_TITLES[section] ?? section }),
          el('div', { className: 'rows' }, ...SETTINGS.filter((s) => s.section === section).map(settingRow)),
        ),
      )
    }

    const groups = new Map()
    for (const action of ACTIONS) {
      if (!groups.has(action.group)) groups.set(action.group, [])
      groups.get(action.group).push(action)
    }
    nodes.push(
      el(
        'section',
        { className: 'group keys' },
        el('h2', { textContent: 'Keys' }),
        el(
          'p',
          { className: 'lede' },
          'Click a key to change it, then press the new one. ',
          el('kbd', { textContent: 'Esc' }),
          ' cancels. Each action can have up to three.',
        ),
        ...[...groups].map(([group, actions]) =>
          el(
            'div',
            { className: 'rows' },
            el('h3', { textContent: GROUP_TITLES[group] ?? group }),
            ...actions.map(keyRow),
          ),
        ),
      ),
    )
    bar = el('div', { className: 'savebar' })
    nodes.push(bar)
    root.replaceChildren(...nodes)
    renderBar()
    if (listening) root.querySelector('.cap.listening')?.focus()
  }

  function resetEverything() {
    draft = {}
    errors = {}
    formError = ''
    status = ''
    listening = null
    render()
  }

  function renderBar() {
    if (!bar) return
    const dirty = isDirty()
    bar.hidden = !dirty && !status && !formError
    bar.classList.toggle('dirty', dirty)
    const text = el('span', {
      className: 'state',
      role: 'status',
      textContent: status || (dirty ? 'You have unsaved changes.' : ''),
    })
    const discardButton = button('Discard', discard, 'quiet')
    const saveButton = button('Save changes', save, '')
    discardButton.disabled = !dirty || saving
    saveButton.disabled = !dirty || saving
    saveButton.id = 'settings-save'
    const nodes = [text, discardButton, saveButton]
    if (formError) nodes.unshift(el('p', { className: 'error', role: 'alert', textContent: formError }))
    bar.replaceChildren(...nodes)
  }

  /** A red "Reset to default" on a changed row; an empty slot on the others. */
  function origin(overridden, defaultText, reset) {
    const slot = el('div', { className: 'origin' })
    if (overridden) {
      const back = button('Reset to default', reset, 'reset')
      back.title = `Default: ${defaultText}`
      slot.append(back)
    }
    return slot
  }

  function settingRow(spec) {
    const { section, key } = spec
    const path = `${section}.${key}`
    const id = `mine-${section}-${key}`
    const overridden = mine(section, key) !== undefined
    const value = overridden ? mine(section, key) : server[section][key]
    const row = el('div', { className: 'row setting' })
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
      const now = mine(section, key) !== undefined
      if (now === row.classList.contains('overridden')) return
      row.classList.toggle('overridden', now)
      row.querySelector('.origin').replaceWith(origin(now, prettyValue(spec, server[section][key]), reset))
    }
    if (spec.type === 'boolean') {
      const box = el('input', { type: 'checkbox', id, checked: value, className: 'switch' })
      box.setAttribute('role', 'switch')
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

    const text = el(
      'div',
      { className: 'text' },
      el('label', { htmlFor: id, textContent: spec.label }),
      el('p', { className: 'description', textContent: DESCRIPTIONS[path] ?? spec.help }),
    )
    const side = el(
      'div',
      { className: 'side' },
      control,
      origin(overridden, prettyValue(spec, server[section][key]), reset),
    )
    row.append(text, side)
    if (errors[path]) row.append(el('p', { className: 'error', role: 'alert', textContent: errors[path] }))
    return row
  }

  function keyRow(action) {
    const label = KEY_NAMES[action.id] ?? action.label
    const path = `keybinds.${action.id}`
    const overridden = mine('keybinds', action.id) !== undefined
    const current = overridden ? mine('keybinds', action.id) : server.keybinds[action.id]
    const row = el('div', { className: 'row bind-row' })
    row.dataset.path = path
    row.classList.toggle('overridden', overridden)

    // Three slots, like a game's controls screen: a bound key, or an empty
    // slot to add one. Clicking a bound one replaces it.
    const slots = el('div', { className: 'slots' })
    for (let i = 0; i < MAX_BINDINGS; i++) {
      const chord = current[i]
      const waiting = listening?.id === action.id && listening.slot === i
      const slot = el('div', { className: 'slot' })
      // Past the first empty slot, the rest are only placeholders: a new key
      // always goes on the end.
      if (chord === undefined && i !== current.length) {
        slot.append(el('span', { className: 'cap empty spare', ariaHidden: 'true' }))
        slots.append(slot)
        continue
      }
      const cap = button(
        waiting ? 'Press a key' : chord !== undefined ? prettyChord(chord) : 'Add',
        () => {
          listening = waiting ? null : { id: action.id, slot: i }
          render()
        },
        `cap${chord === undefined ? ' empty' : ''}${waiting ? ' listening' : ''}`,
      )
      cap.setAttribute(
        'aria-label',
        chord !== undefined ? `${label}: ${prettyChord(chord)}. Change it` : `Add a key for ${label}`,
      )
      slot.append(cap)
      if (chord !== undefined && !waiting) {
        const remove = button(
          '×',
          () => {
            setMine(
              'keybinds',
              action.id,
              current.filter((_, j) => j !== i),
            )
            changed()
          },
          'unbind',
        )
        remove.setAttribute('aria-label', `Remove ${prettyChord(chord)} from ${label}`)
        slot.append(remove)
      }
      slots.append(slot)
    }

    const defaultKeys = server.keybinds[action.id].map(prettyChord).join(', ') || 'no key'
    row.append(
      el('div', { className: 'text' }, el('span', { className: 'label', textContent: label })),
      el(
        'div',
        { className: 'side' },
        slots,
        origin(overridden, defaultKeys, () => {
          setMine('keybinds', action.id, undefined)
          changed()
        }),
      ),
    )
    if (errors[path]) row.append(el('p', { className: 'error', role: 'alert', textContent: errors[path] }))
    return row
  }

  // A key pressed while a slot is waiting goes into that slot.
  document.addEventListener(
    'keydown',
    (event) => {
      if (!listening) return
      event.preventDefault()
      event.stopPropagation()
      const { id, slot } = listening
      const action = ACTIONS.find((a) => a.id === id)
      if (event.key === 'Escape') {
        listening = null
        render()
        return
      }
      const chord = chordFromEvent(event, { movement: Boolean(action.movement), mac: IS_MAC })
      if (chord === null) return
      listening = null
      if (chord === undefined) {
        errors[`keybinds.${id}`] = `${event.key} can't be used as a key here.`
        render()
        return
      }
      const list = [...(mine('keybinds', id) ?? server.keybinds[id])]
      const already = list.indexOf(chord)
      if (already === -1) list[slot] = chord
      else if (already !== slot) list.splice(slot, 1)
      setMine(
        'keybinds',
        id,
        list.filter((c) => c !== undefined),
      )
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
