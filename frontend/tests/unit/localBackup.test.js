// The browser's copy of unsaved server-map edits (src/localBackup.js): what
// opening a map does with one, and a store that fails quietly without
// IndexedDB. The IndexedDB round trip itself runs in the accounts e2e suite.
import { describe, it, expect } from 'vitest'
import { backupOffer, createBackupStore } from '../../src/localBackup.js'

const map = {
  id: 'm1',
  revision: 3,
  payload: { schema: 1, nodes: [{ id: 'a' }], edges: [], camera: { position: [0, 0, 0] } },
}
const record = (overrides) => ({
  mapId: 'm1',
  baseRevision: 3,
  savedAt: 0,
  payload: { schema: 1, nodes: [{ id: 'a' }, { id: 'b' }], edges: [], camera: { position: [9, 9, 9] } },
  ...overrides,
})

describe('backupOffer', () => {
  it('nothing stored, or stored for another map', () => {
    expect(backupOffer(null, map)).toBe(null)
    expect(backupOffer(record({ mapId: 'm2' }), map)).toBe(null)
    expect(backupOffer(record({ payload: null }), map)).toBe(null)
  })

  it('restore when the server has not moved since', () => {
    expect(backupOffer(record(), map)).toBe('restore')
  })

  it('copy when the server has a newer version', () => {
    expect(backupOffer(record({ baseRevision: 2 }), map)).toBe('copy')
  })

  it('same when the server already has the content, whatever the camera', () => {
    const payload = { ...map.payload, camera: { position: [5, 5, 5] } }
    expect(backupOffer(record({ payload }), map)).toBe('same')
    expect(backupOffer(record({ payload, baseRevision: 2 }), map)).toBe('same')
  })

  it('same whatever order the keys come in (the server sorts them)', () => {
    const payload = { edges: [], nodes: [{ id: 'a' }], schema: 1 }
    expect(backupOffer(record({ payload }), map)).toBe('same')
    const moved = { edges: [], nodes: [{ id: 'b' }], schema: 1 }
    expect(backupOffer(record({ payload: moved }), map)).toBe('restore')
  })
})

describe('createBackupStore without IndexedDB', () => {
  it('resolves to nothing and never throws', async () => {
    const store = createBackupStore({ indexedDB: undefined })
    expect(await store.put(record())).toBe(false)
    expect(await store.get('m1')).toBe(null)
    expect(await store.remove('m1')).toBe(false)
    expect(await store.clear()).toBe(false)
  })
})
