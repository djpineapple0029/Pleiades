import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { payloadToDoc } from '../../src/format/ydoc.js'
import { cursorField, cursorsFor } from '../../src/room/notesCursors.js'

const PAYLOAD = {
  nodes: [
    { id: 'a', label: 'A', notes: 'hello world' },
    { id: 'b', label: 'B', notes: 'other' },
  ],
  edges: [],
}
const notesOf = (doc, id) => doc.getMap('nodes').get(id).get('notes')

/** Two docs in sync, as two people in a room are. */
function pair() {
  const mine = payloadToDoc(PAYLOAD)
  const theirs = new Y.Doc()
  Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine))
  const sync = (from, to) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)))
  return { mine, theirs, sync }
}

describe('cursorField', () => {
  it('a selection as relative positions in the star’s notes', () => {
    const doc = payloadToDoc(PAYLOAD)
    const field = cursorField('a', notesOf(doc, 'a'), 2, 5)
    expect(field.node).toBe('a')
    expect(
      Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(field.anchor), doc).index,
    ).toBe(2)
    expect(
      Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(field.head), doc).index,
    ).toBe(5)
  })

  it('selected backwards, the anchor is the end', () => {
    const doc = payloadToDoc(PAYLOAD)
    const field = cursorField('a', notesOf(doc, 'a'), 2, 5, 'backward')
    expect(
      Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(field.anchor), doc).index,
    ).toBe(5)
  })

  it('JSON all the way down, as awareness sends it', () => {
    const doc = payloadToDoc(PAYLOAD)
    const field = cursorField('a', notesOf(doc, 'a'), 0, 0)
    expect(JSON.parse(JSON.stringify(field))).toEqual(field)
  })
})

describe('cursorsFor', () => {
  it("someone's caret in this star, resolved after another person's insert before it", () => {
    const { mine, theirs, sync } = pair()
    // They put their caret after "hello" (5)...
    const states = new Map([[theirs.clientID, { cursor: cursorField('a', notesOf(theirs, 'a'), 5, 5) }]])
    // ...then I type "¡" at the start, which moves their caret along.
    notesOf(mine, 'a').insert(0, '¡')
    sync(mine, theirs)
    expect(cursorsFor('a', states, mine, { exclude: mine.clientID })).toEqual([
      { clientId: theirs.clientID, anchor: 6, head: 6 },
    ])
  })

  it('only the star asked about, and never my own', () => {
    const { mine, theirs } = pair()
    const states = new Map([
      [theirs.clientID, { cursor: cursorField('b', notesOf(theirs, 'b'), 1, 1) }],
      [mine.clientID, { cursor: cursorField('a', notesOf(mine, 'a'), 1, 1) }],
      [99, { pose: {} }],
    ])
    expect(cursorsFor('a', states, mine, { exclude: mine.clientID })).toEqual([])
    expect(cursorsFor('b', states, mine, { exclude: mine.clientID })).toHaveLength(1)
  })

  it('a caret in a star that has since been deleted is dropped', () => {
    const { mine, theirs, sync } = pair()
    const states = new Map([[theirs.clientID, { cursor: cursorField('a', notesOf(theirs, 'a'), 3, 3) }]])
    mine.getMap('nodes').delete('a')
    sync(mine, theirs)
    expect(cursorsFor('a', states, mine, { exclude: mine.clientID })).toEqual([])
  })

  it('garbage in awareness is ignored, not thrown', () => {
    const { mine } = pair()
    const states = new Map([
      [5, { cursor: { node: 'a', anchor: 'nope', head: null } }],
      [6, { cursor: { node: 'a' } }],
      [7, { cursor: 'a' }],
    ])
    expect(cursorsFor('a', states, mine, { exclude: mine.clientID })).toEqual([])
  })
})
