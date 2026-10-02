import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { diffText, transformIndex, bindTextarea } from '../../src/room/notesBinding.js'

describe('diffText', () => {
  it('finds the one splice', () => {
    expect(diffText('hello world', 'hello brave world')).toEqual({ index: 6, remove: 0, insert: 'brave ' })
    expect(diffText('abc', 'ac')).toEqual({ index: 1, remove: 1, insert: '' })
    expect(diffText('same', 'same')).toEqual({ index: 4, remove: 0, insert: '' })
  })

  it('a replaced selection is one remove and one insert', () => {
    expect(diffText('the cat sat', 'the dog sat')).toEqual({ index: 4, remove: 3, insert: 'dog' })
  })
})

describe('transformIndex', () => {
  it('an insert before the caret pushes it right', () => {
    expect(transformIndex(5, [{ retain: 2 }, { insert: 'xyz' }])).toBe(8)
  })
  it('an insert after the caret leaves it', () => {
    expect(transformIndex(1, [{ retain: 2 }, { insert: 'xyz' }])).toBe(1)
  })
  it('an insert exactly at the caret leaves it before the insert', () => {
    expect(transformIndex(2, [{ retain: 2 }, { insert: 'xyz' }])).toBe(2)
  })
  it('a delete before the caret pulls it left, a delete across it lands at the start', () => {
    expect(transformIndex(5, [{ delete: 2 }])).toBe(3)
    expect(transformIndex(3, [{ retain: 2 }, { delete: 4 }])).toBe(2)
  })
})

/** Enough of a <textarea> for the binding. */
function fakeTextarea(value = '') {
  const listeners = {}
  return {
    value,
    selectionStart: 0,
    selectionEnd: 0,
    addEventListener: (type, fn) => (listeners[type] = fn),
    removeEventListener: (type) => delete listeners[type],
    setSelectionRange(a, b) {
      this.selectionStart = a
      this.selectionEnd = b
    },
    type(newValue, caret) {
      this.value = newValue
      this.selectionStart = this.selectionEnd = caret
      listeners.input?.()
    },
    get listening() {
      return Object.keys(listeners)
    },
  }
}

describe('bindTextarea', () => {
  it('typing reaches the Y.Text; a remote insert reaches the textarea without moving my caret off my word', () => {
    const doc = new Y.Doc()
    const text = doc.getText('notes')
    text.insert(0, 'hello')
    const area = fakeTextarea('')
    bindTextarea(area, text, { origin: 'local' })
    expect(area.value).toBe('hello')
    area.type('hello!', 6)
    expect(text.toString()).toBe('hello!')
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
    other.getText('notes').insert(0, '>> ')
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)), 'room')
    expect(area.value).toBe('>> hello!')
    expect(area.selectionStart).toBe(9)
  })

  it('my typing goes in under the origin I gave it', () => {
    const doc = new Y.Doc()
    const text = doc.getText('notes')
    const area = fakeTextarea('')
    const origins = []
    doc.on('afterTransaction', (txn) => origins.push(txn.origin))
    bindTextarea(area, text, { origin: 'local' })
    area.type('a', 1)
    expect(origins).toEqual(['local'])
  })

  it('two people typing at once both survive', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    a.getText('notes').insert(0, 'ab')
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const areaA = fakeTextarea('ab')
    const areaB = fakeTextarea('ab')
    bindTextarea(areaA, a.getText('notes'), { origin: 'local' })
    bindTextarea(areaB, b.getText('notes'), { origin: 'local' })
    areaA.type('aXb', 2)
    areaB.type('abY', 3)
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'room')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'room')
    expect(areaA.value).toBe('aXbY')
    expect(areaB.value).toBe('aXbY')
  })

  it('destroy stops both directions', () => {
    const doc = new Y.Doc()
    const text = doc.getText('notes')
    const area = fakeTextarea('')
    const binding = bindTextarea(area, text, { origin: 'local' })
    binding.destroy()
    expect(area.listening).toEqual([])
    text.insert(0, 'later')
    expect(area.value).toBe('')
  })
})
