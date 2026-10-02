import { describe, it, expect } from 'vitest'
import { panelPeople } from '../../src/room/roomPanel.js'

const roster = [
  { conn: 'b', name: 'bob', colour: '#ffd166', role: 'editor', guest: false, clientIds: [2] },
  { conn: 'me', name: 'alice', colour: '#ff6b6b', role: 'owner', guest: false, clientIds: [1] },
  { conn: 'g', name: '<b>sam</b>', colour: '#06d6a0', role: 'viewer', guest: true, clientIds: [] },
]

describe("the Esc screen's people list", () => {
  it('you first, then everyone in the room order, named as the roster names them', () => {
    expect(panelPeople(roster, { conn: 'me' })).toEqual([
      { conn: 'me', name: 'alice', colour: '#ff6b6b', role: 'owner', you: true, clientIds: [1] },
      { conn: 'b', name: 'bob', colour: '#ffd166', role: 'editor', you: false, clientIds: [2] },
      { conn: 'g', name: '<b>sam</b> (guest)', colour: '#06d6a0', role: 'viewer', you: false, clientIds: [] },
    ])
  })

  it('before the welcome, nobody is you', () => {
    expect(panelPeople(roster, null).every((p) => !p.you)).toBe(true)
  })
})
