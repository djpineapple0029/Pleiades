import { describe, it, expect } from 'vitest'
import { rosterEntries } from '../../src/room/roster.js'

const people = [
  { conn: 'me', name: 'alice', colour: '#ff6b6b', role: 'owner', clientIds: [1] },
  { conn: 'b', name: 'bob', colour: '#ffd166', role: 'editor', clientIds: [2] },
  { conn: 'c', name: '<img src=x>', colour: '#06d6a0', role: 'viewer', clientIds: [] },
]

describe('roster bubbles', () => {
  it('one per other person: initial, colour, and who they are', () => {
    expect(rosterEntries(people, { conn: 'me' })).toEqual([
      { conn: 'b', initial: 'B', colour: '#ffd166', title: 'bob · editor', clientIds: [2] },
      { conn: 'c', initial: '<', colour: '#06d6a0', title: '<img src=x> · viewer', clientIds: [] },
    ])
  })

  it('alone, nobody', () => {
    expect(rosterEntries([people[0]], { conn: 'me' })).toEqual([])
  })

  it('an initial is one whole character, emoji included', () => {
    const [entry] = rosterEntries([{ conn: 'x', name: '🌍 earth', colour: '#fff', role: 'editor' }], null)
    expect(entry.initial).toBe('🌍')
  })
})
