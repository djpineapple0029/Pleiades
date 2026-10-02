import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { authorsOf, colourFor, hexToRgb } from '../../src/room/authors.js'

describe('authors', () => {
  it('is the client whose edit the transaction applied', () => {
    const mine = new Y.Doc()
    const theirs = new Y.Doc()
    let seen = null
    mine.on('afterTransaction', (txn) => (seen = authorsOf(txn)))
    theirs.getMap('nodes').set('a', 1)
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs), 'room')
    expect([...seen]).toEqual([theirs.clientID])
  })

  it('a pure delete has no author', () => {
    const mine = new Y.Doc()
    const theirs = new Y.Doc()
    theirs.getMap('nodes').set('a', 1)
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs))
    const before = Y.encodeStateVector(theirs)
    theirs.getMap('nodes').delete('a')
    let seen = null
    mine.on('afterTransaction', (txn) => (seen = authorsOf(txn)))
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs, before), 'room')
    expect(seen.size).toBe(0)
  })

  it('maps a client id to the roster colour', () => {
    const roster = [{ name: 'Sam', colour: '#ff6b6b', clientIds: [42] }]
    expect(colourFor(42, roster)).toBe('#ff6b6b')
    expect(colourFor(7, roster)).toBeNull()
    expect(colourFor(7, undefined)).toBeNull()
  })

  it('hex to 0..1 channels', () => {
    expect(hexToRgb('#ff0080')).toEqual([1, 0, 128 / 255])
  })
})
