import { describe, it, expect } from 'vitest'
import { memberRows, inviteRoles } from '../../src/shell/shareDialog.js'

const sharing = {
  owner: { id: 1, username: 'owner' },
  members: [
    { user_id: 2, username: 'ed', role: 'editor' },
    { user_id: 3, username: 'vi', role: 'viewer' },
  ],
}

describe('share dialog rules', () => {
  it('owner can change roles and remove anyone', () => {
    const rows = memberRows(sharing, { user_id: 1, role: 'owner', perms: { invite: true } })
    expect(rows.every((r) => r.canChangeRole && r.canRemove)).toBe(true)
  })
  it('an editor can only leave themselves', () => {
    const rows = memberRows(sharing, { user_id: 2, role: 'editor', perms: { invite: true } })
    expect(rows.find((r) => r.user_id === 2).canRemove).toBe(true)
    expect(rows.find((r) => r.user_id === 3).canRemove).toBe(false)
    expect(rows.some((r) => r.canChangeRole)).toBe(false)
  })
  it('invite roles never exceed your own', () => {
    expect(inviteRoles({ role: 'owner', perms: { invite: true } })).toEqual(['editor', 'viewer'])
    expect(inviteRoles({ role: 'editor', perms: { invite: true } })).toEqual(['editor', 'viewer'])
    expect(inviteRoles({ role: 'viewer', perms: { invite: true } })).toEqual(['viewer'])
    expect(inviteRoles({ role: 'editor', perms: { invite: false } })).toEqual([])
  })
})
