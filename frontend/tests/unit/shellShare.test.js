import { describe, it, expect } from 'vitest'
import {
  memberRows,
  inviteRoles,
  permissionGrid,
  linkState,
  daysLeft,
  PERMS,
} from '../../src/shell/shareDialog.js'

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

const DEFAULTS = {
  editor: { balance: true, export: true, invite: true, history: false, chat: true },
  viewer: { balance: false, export: false, invite: false, history: false, chat: false },
}
const full = {
  ...sharing,
  members: [
    { user_id: 2, username: 'ed', role: 'editor', perms_override: { export: false }, effective: {} },
    { user_id: 3, username: 'vi', role: 'viewer', perms_override: null, effective: {} },
  ],
  role_defaults: DEFAULTS,
  link: null,
}
const ownerYou = { user_id: 1, role: 'owner', perms: { invite: true } }

describe('permissionGrid', () => {
  it('the owner can change every role default, except a viewer’s Balance', () => {
    const grid = permissionGrid(full, ownerYou)
    const viewer = grid.roles.find((r) => r.role === 'viewer')
    const editor = grid.roles.find((r) => r.role === 'editor')
    expect(editor.perms.history).toEqual({ value: false, editable: true })
    expect(viewer.perms.export).toEqual({ value: false, editable: true })
    expect(viewer.perms.balance).toEqual({ value: false, editable: false })
    expect(Object.keys(editor.perms)).toEqual(PERMS)
  })

  it('people carry their overrides: on, off, or the default (null)', () => {
    const grid = permissionGrid(full, ownerYou)
    const ed = grid.people.find((p) => p.user_id === 2)
    expect(ed.editable).toBe(true)
    expect(ed.override.export).toBe(false)
    expect(ed.override.chat).toBeNull()
    expect(grid.people.find((p) => p.user_id === 3).override.balance).toBeNull()
  })

  it('nobody but the owner can edit anything', () => {
    const grid = permissionGrid(full, { user_id: 2, role: 'editor', perms: { invite: true } })
    expect(grid.roles.every((r) => Object.values(r.perms).every((p) => !p.editable))).toBe(true)
    expect(grid.people.every((p) => !p.editable)).toBe(true)
  })
})

describe('linkState', () => {
  it('off when there is no link; the owner may offer both roles', () => {
    expect(linkState(full, ownerYou)).toEqual({
      mode: 'off',
      expires_at: null,
      canChange: true,
      roles: ['editor', 'viewer'],
    })
  })

  it('shows the live link and its expiry', () => {
    const state = linkState({ ...full, link: { role: 'editor', expires_at: 99 } }, ownerYou)
    expect(state.mode).toBe('editor')
    expect(state.expires_at).toBe(99)
  })

  it('a viewer with invite can only offer a view link; without invite, nothing', () => {
    expect(linkState(full, { user_id: 3, role: 'viewer', perms: { invite: true } }).roles).toEqual(['viewer'])
    const none = linkState(full, { user_id: 3, role: 'viewer', perms: { invite: false } })
    expect(none.canChange).toBe(false)
    expect(none.roles).toEqual([])
  })
})

describe('daysLeft', () => {
  it('a new link keeps at least the old one’s time left, in the lifetimes on offer', () => {
    expect(daysLeft(null, 0)).toBeNull()
    expect(daysLeft(0.5 * 86400, 0)).toBe(1)
    expect(daysLeft(3 * 86400, 0)).toBe(7)
    expect(daysLeft(20 * 86400, 0)).toBe(30)
  })
})
