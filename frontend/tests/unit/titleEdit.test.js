// titleEdit.js: the caret-in-label draft shown while renaming in place.
import { describe, it, expect } from 'vitest'
import { draftText } from '../../src/titleEdit.js'

describe('draftText', () => {
  it('puts the caret where the selection is', () => {
    expect(draftText('Orion', 0)).toBe('|Orion')
    expect(draftText('Orion', 2)).toBe('Or|ion')
    expect(draftText('Orion', 5)).toBe('Orion|')
  })

  it('shows just a caret for an empty label', () => {
    expect(draftText('', 0)).toBe('|')
  })

  it('clamps an out-of-range or missing caret to the end', () => {
    expect(draftText('abc', 99)).toBe('abc|')
    expect(draftText('abc', -1)).toBe('|abc')
    expect(draftText('abc', null)).toBe('abc|')
  })
})
