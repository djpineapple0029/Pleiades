// history.js: the undo/redo stacks on their own (V2.md F1 / §2.4.10).
import { describe, it, expect } from 'vitest'
import { createHistory } from '../../src/history.js'

const entry = (label) => ({ label, before: 0, after: 0, undo() {}, redo() {} })

describe('history.js', () => {
  it('starts empty', () => {
    const h = createHistory()
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.undo()).toBe(null)
    expect(h.redo()).toBe(null)
  })

  it('undoes newest first and redoes in the original order', () => {
    const h = createHistory()
    h.record(entry('a'))
    h.record(entry('b'))
    expect(h.undo().label).toBe('b')
    expect(h.undo().label).toBe('a')
    expect(h.undo()).toBe(null)
    expect(h.redo().label).toBe('a')
    expect(h.redo().label).toBe('b')
    expect(h.redo()).toBe(null)
  })

  it('a new record drops everything undone', () => {
    const h = createHistory()
    h.record(entry('a'))
    h.record(entry('b'))
    h.undo()
    h.record(entry('c'))
    expect(h.canRedo).toBe(false)
    expect(h.undo().label).toBe('c')
    expect(h.undo().label).toBe('a')
  })

  it('caps the undo stack, dropping the oldest', () => {
    const h = createHistory({ limit: 3 })
    for (const label of ['a', 'b', 'c', 'd']) h.record(entry(label))
    expect(h.size).toBe(3)
    expect([h.undo(), h.undo(), h.undo(), h.undo()].map((e) => e?.label ?? null)).toEqual([
      'd',
      'c',
      'b',
      null,
    ])
  })

  it('clear empties both stacks', () => {
    const h = createHistory()
    h.record(entry('a'))
    h.record(entry('b'))
    h.undo()
    h.clear()
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
  })
})
