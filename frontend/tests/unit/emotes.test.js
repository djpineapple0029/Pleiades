import { describe, it, expect } from 'vitest'
import { EMOTES, EMOTE_MENU, createCooldown, glyphOf } from '../../src/room/emotes.js'

describe('emotes', () => {
  it('eight, each with a glyph', () => {
    expect(EMOTES).toEqual(['wave', 'yes', 'no', 'look', 'idea', 'laugh', 'heart', 'question'])
    expect(EMOTES.map(glyphOf)).toEqual(['👋', '👍', '👎', '👀', '💡', '😂', '❤️', '❓'])
  })

  it('an unknown id has no glyph', () => {
    expect(glyphOf('dance')).toBeNull()
    expect(glyphOf('__proto__')).toBeNull()
  })

  it('the ring offers every emote once, glyph first', () => {
    expect(EMOTE_MENU.map((item) => item.key)).toEqual(EMOTES)
    expect(EMOTE_MENU[0].label.startsWith('👋')).toBe(true)
  })

  it('the cooldown allows, then blocks for a second, then allows', () => {
    const ready = createCooldown(1000)
    expect(ready(10_000)).toBe(true)
    expect(ready(10_500)).toBe(false)
    expect(ready(10_999)).toBe(false)
    expect(ready(11_001)).toBe(true)
    expect(ready(11_500)).toBe(false)
  })
})
