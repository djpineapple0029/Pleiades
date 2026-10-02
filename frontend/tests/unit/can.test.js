import { describe, it, expect } from 'vitest'
import { can, denyText } from '../../src/room/can.js'

describe('can', () => {
  it('local maps can do everything', () => expect(can(null, 'export')).toBe(true))

  it('reads the room’s perms, live', () => {
    const room = { canEdit: true, you: { perms: { export: false, balance: true } } }
    expect(can(room, 'export')).toBe(false)
    expect(can(room, 'balance')).toBe(true)
    room.you = { perms: { export: true } }
    expect(can(room, 'export')).toBe(true)
  })

  it('is false before the room has said who you are', () =>
    expect(can({ canEdit: true }, 'export')).toBe(false))

  it('edit follows canEdit', () => expect(can({ canEdit: false, you: { perms: {} } }, 'edit')).toBe(false))

  it('every perm has a message', () => {
    for (const p of ['balance', 'export', 'history', 'invite', 'chat'])
      expect(denyText(p)).toMatch(/off for you/)
    expect(denyText('export')).toBe('Saving and exporting are off for you on this map')
  })
})
