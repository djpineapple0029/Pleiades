/**
 * Every rebindable key, in one table (V2.md §2.4.4).
 *
 * The actions, their default chords and the chord syntax come from
 * `server/settings_schema.json`, which the server validates the config file
 * against, so a chord that reaches here has already passed the same rules:
 * no browser-reserved chords, no two live actions on one chord, and flight
 * keys positional with no modifiers. Parsing here is still defensive: a chord
 * it can't read is dropped rather than thrown on.
 *
 * How a chord matches a keydown:
 * - Letters and digits by position (`event.code`), so WASD stays WASD on
 *   AZERTY. Actions marked `printed` (undo/redo) match the printed letter
 *   instead: Z is where the keyboard says it is.
 * - Named keys (Enter, Tab, arrows…) by `event.key`; Space and Shift by code.
 * - Symbols (`/`, `?`) by the character typed, which already says whether
 *   Shift was down, so Shift isn't checked for them.
 * - Mod is Ctrl or Cmd. Ctrl, Cmd and Alt must match exactly. Shift must too
 *   on a chord that has Ctrl/Cmd/Alt; on a plain key it's ignored, because
 *   Shift is also "fly down" and is often held when the key is pressed.
 *
 * Pure: no DOM, testable in Node.
 */

import schema from '../../server/settings_schema.json'

export const ACTIONS = new Map(schema.keybinds.map((action) => [action.id, action]))

const MODIFIERS = { mod: 'Mod', ctrl: 'Ctrl', cmd: 'Cmd', alt: 'Alt', shift: 'Shift' }
const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Cmd', 'Alt', 'Shift']
const NAMED = [
  'Space',
  'Shift',
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]
const NAMED_BY_LOWER = new Map(NAMED.map((name) => [name.toLowerCase(), name]))
const CHARS = new Set('/?[]{};:\'",.<>-_=`~!@#$%^&*()|\\')

/** `"Mod+Shift+S"` → `{ mods: Set, kind, key }`, or null if it can't be read. */
export function parseChord(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  const parts = text
    .trim()
    .split('+')
    .map((part) => part.trim())
  if (parts.some((part) => !part)) return null
  const keyPart = parts.pop()
  const mods = new Set()
  for (const part of parts) {
    const name = MODIFIERS[part.toLowerCase()]
    if (!name || mods.has(name)) return null
    mods.add(name)
  }
  let kind
  let key
  if (/^[a-z]$/i.test(keyPart)) {
    kind = 'letter'
    key = keyPart.toUpperCase()
  } else if (/^\d$/.test(keyPart)) {
    kind = 'digit'
    key = keyPart
  } else if (NAMED_BY_LOWER.has(keyPart.toLowerCase())) {
    kind = 'named'
    key = NAMED_BY_LOWER.get(keyPart.toLowerCase())
  } else if (CHARS.has(keyPart)) {
    kind = 'char'
    key = keyPart
    mods.delete('Shift')
  } else {
    return null
  }
  return { mods, kind, key }
}

export function chordText(chord) {
  return [...MODIFIER_ORDER.filter((m) => chord.mods.has(m)), chord.key].join('+')
}

function keyMatches(chord, event, printed) {
  const { kind, key } = chord
  if (kind === 'letter') {
    return printed ? (event.key || '').toLowerCase() === key.toLowerCase() : event.code === `Key${key}`
  }
  if (kind === 'digit') return event.code === `Digit${key}`
  if (kind === 'named') {
    if (key === 'Space') return event.code === 'Space'
    if (key === 'Shift') return event.code === 'ShiftLeft' || event.code === 'ShiftRight'
    return event.key === key
  }
  return event.key === key
}

export function chordMatches(chord, event, { printed = false } = {}) {
  if (!keyMatches(chord, event, printed)) return false
  const { mods } = chord
  const ctrl = !!event.ctrlKey
  const meta = !!event.metaKey
  if (mods.has('Mod')) {
    if (!ctrl && !meta) return false
  } else if (ctrl !== mods.has('Ctrl') || meta !== mods.has('Cmd')) {
    return false
  }
  if (!!event.altKey !== mods.has('Alt')) return false
  if (chord.kind === 'char' || chord.key === 'Shift') return true
  const plain = !mods.has('Mod') && !mods.has('Ctrl') && !mods.has('Cmd') && !mods.has('Alt')
  return plain || !!event.shiftKey === mods.has('Shift')
}

/** The physical keys (`event.code`s) a movement chord holds down. */
export function codesOf(chord) {
  if (chord.kind === 'letter') return [`Key${chord.key}`]
  if (chord.kind === 'digit') return [`Digit${chord.key}`]
  if (chord.key === 'Shift') return ['ShiftLeft', 'ShiftRight']
  if (chord.kind === 'named') return [chord.key] // Space, arrows, Enter… name their own code
  return []
}

/** How a chord reads on a key cap, one string per key: `Mod+S` → `['Ctrl/⌘', 'S']`. */
export function chordCaps(chord) {
  const caps = MODIFIER_ORDER.filter((m) => chord.mods.has(m)).map((m) =>
    m === 'Mod' ? 'Ctrl/⌘' : m === 'Cmd' ? '⌘' : m,
  )
  return [...caps, chord.key]
}

export function defaultKeybinds() {
  return Object.fromEntries(schema.keybinds.map((action) => [action.id, [...action.default]]))
}

/**
 * `bindings` is `{ actionId: ['Mod+S', …] }`, as served by `/api/config`. An
 * action it leaves out keeps its default; an empty list leaves it unbound.
 */
export function createKeymap(bindings = {}) {
  const table = new Map()
  for (const action of schema.keybinds) {
    const given = bindings?.[action.id]
    const list = Array.isArray(given) ? given : action.default
    table.set(action.id, list.map(parseChord).filter(Boolean))
  }

  return {
    /** Does this keydown fire this action? */
    is(event, id) {
      const action = ACTIONS.get(id)
      const chords = table.get(id)
      if (!action || !chords) return false
      return chords.some((chord) => chordMatches(chord, event, action))
    },
    chords: (id) => table.get(id) ?? [],
    /** Key caps for the first chord bound to `id`, or [] when unbound. */
    caps(id) {
      const first = table.get(id)?.[0]
      return first ? chordCaps(first) : []
    },
    /** The first chord as one string, e.g. "Ctrl/⌘+Enter", or '' when unbound. */
    label(id) {
      return this.caps(id).join('+')
    },
    /** `event.code` → [axis, sign] for flight, from the six move_* actions. */
    movementAxes() {
      const axes = {
        move_forward: ['forward', 1],
        move_back: ['forward', -1],
        move_right: ['right', 1],
        move_left: ['right', -1],
        move_up: ['up', 1],
        move_down: ['up', -1],
      }
      const out = {}
      for (const [id, axis] of Object.entries(axes)) {
        for (const chord of table.get(id) ?? []) {
          for (const code of codesOf(chord)) out[code] ??= axis
        }
      }
      return out
    },
  }
}
