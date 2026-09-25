import { describe, expect, it } from 'vitest'
import { chordText, createKeymap, parseChord } from '../../src/keymap.js'
import { defaultSettings, mergeSettings } from '../../src/settings.js'

// A keydown as the browser would report it. `code` defaults from a letter key.
function key(k, { code, ctrl = false, meta = false, alt = false, shift = false } = {}) {
  const guessed = /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k
  return { key: k, code: code ?? guessed, ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift }
}

describe('parseChord', () => {
  it('reads modifiers, letters, named keys and symbols', () => {
    expect(chordText(parseChord('mod+shift+s'))).toBe('Mod+Shift+S')
    expect(chordText(parseChord('Backspace'))).toBe('Backspace')
    expect(parseChord('pageup').key).toBe('PageUp')
    expect(parseChord('/').kind).toBe('char')
  })

  it('drops Shift from a symbol: the character already says it', () => {
    expect(chordText(parseChord('Shift+?'))).toBe('?')
  })

  it('returns null for anything it cannot read', () => {
    for (const bad of ['', 'Mod+', 'Hyper+S', 'Mod+Mod+S', 'NumpadEnter', 42, null]) {
      expect(parseChord(bad)).toBeNull()
    }
  })
})

describe('default keymap', () => {
  const keymap = createKeymap()

  it('matches file chords with Ctrl or Cmd, and keeps save and save-as apart', () => {
    expect(keymap.is(key('s', { ctrl: true }), 'save')).toBe(true)
    expect(keymap.is(key('s', { meta: true }), 'save')).toBe(true)
    expect(keymap.is(key('S', { meta: true, shift: true }), 'save')).toBe(false)
    expect(keymap.is(key('S', { meta: true, shift: true }), 'save_as')).toBe(true)
    expect(keymap.is(key('s', { ctrl: true, alt: true }), 'save')).toBe(false)
    expect(keymap.is(key('s'), 'save')).toBe(false)
  })

  it('matches undo by the printed letter, so AZERTY Z works', () => {
    // On AZERTY the Z key sits where QWERTY has W.
    expect(keymap.is(key('z', { code: 'KeyW', meta: true }), 'undo')).toBe(true)
    expect(keymap.is(key('Z', { code: 'KeyW', meta: true, shift: true }), 'redo')).toBe(true)
    expect(keymap.is(key('y', { ctrl: true }), 'redo')).toBe(true)
    // Cmd+Y is Chrome's History on macOS: the default is Ctrl+Y only.
    expect(keymap.is(key('y', { meta: true }), 'redo')).toBe(false)
  })

  it('matches plain letters by position and ignores Shift (fly down) on them', () => {
    expect(keymap.is(key('b'), 'balance')).toBe(true)
    expect(keymap.is(key('B', { shift: true }), 'balance')).toBe(true)
    expect(keymap.is(key('b', { ctrl: true }), 'balance')).toBe(false)
  })

  it('matches symbols by character, whatever key typed them', () => {
    expect(keymap.is(key('/', { code: 'Slash' }), 'search')).toBe(true)
    expect(keymap.is(key('/', { code: 'Digit7', shift: true }), 'search')).toBe(true) // German layout
    expect(keymap.is(key('?', { code: 'Slash', shift: true }), 'help')).toBe(true)
    expect(keymap.is(key('/', { code: 'Slash', ctrl: true }), 'search')).toBe(false)
  })

  it('keeps Enter (rename) and Mod+Enter (notes) apart', () => {
    expect(keymap.is(key('Enter'), 'rename')).toBe(true)
    expect(keymap.is(key('Enter', { meta: true }), 'rename')).toBe(false)
    expect(keymap.is(key('Enter', { meta: true }), 'edit_notes')).toBe(true)
  })

  it('maps movement to physical keys, Shift on both sides', () => {
    const axes = keymap.movementAxes()
    expect(axes.KeyW).toEqual(['forward', 1])
    expect(axes.Space).toEqual(['up', 1])
    expect(axes.ShiftLeft).toEqual(['up', -1])
    expect(axes.ShiftRight).toEqual(['up', -1])
  })

  it('labels chords as key caps', () => {
    expect(keymap.caps('save')).toEqual(['Ctrl/⌘', 'S'])
    expect(keymap.label('edit_notes')).toBe('Ctrl/⌘+Enter')
    expect(keymap.label('overview')).toBe('Tab')
  })
})

describe('custom keymap', () => {
  it('uses what it is given, keeps defaults for what it is not, and allows unbinding', () => {
    const keymap = createKeymap({ balance: ['G', 'F2'], move_forward: ['ArrowUp'], jump_back: [] })
    expect(keymap.is(key('g'), 'balance')).toBe(true)
    expect(keymap.is(key('F2'), 'balance')).toBe(true)
    expect(keymap.is(key('b'), 'balance')).toBe(false)
    expect(keymap.is(key('Backspace'), 'jump_back')).toBe(false)
    expect(keymap.label('jump_back')).toBe('')
    expect(keymap.movementAxes().ArrowUp).toEqual(['forward', 1])
    expect(keymap.movementAxes().KeyW).toBeUndefined()
    expect(keymap.is(key('s', { meta: true }), 'save')).toBe(true)
  })

  it('drops chords it cannot parse instead of throwing', () => {
    const keymap = createKeymap({ balance: ['Hyper+B', 'G'] })
    expect(keymap.chords('balance').map(chordText)).toEqual(['G'])
  })
})

describe('mergeSettings', () => {
  it('keeps valid values and replaces anything out of range or the wrong type', () => {
    const merged = mergeSettings({
      flight: { mouse_sensitivity: 2.5, invert_y: 'yes', move_speed: 99999 },
      visuals: { dust_rivers: false },
      keybinds: { balance: ['G'], save: 'Mod+S' },
    })
    const defaults = defaultSettings()
    expect(merged.flight.mouse_sensitivity).toBe(2.5)
    expect(merged.flight.invert_y).toBe(defaults.flight.invert_y)
    expect(merged.flight.move_speed).toBe(defaults.flight.move_speed)
    expect(merged.visuals.dust_rivers).toBe(false)
    expect(merged.keybinds.balance).toEqual(['G'])
    expect(merged.keybinds.save).toEqual(defaults.keybinds.save)
  })

  it('never passes server-only settings through', () => {
    expect(mergeSettings({ admin: { session_minutes: 5 } }).admin).toBeUndefined()
  })
})
