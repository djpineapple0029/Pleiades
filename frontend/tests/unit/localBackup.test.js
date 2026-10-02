// What's left of localBackup.js once server maps moved into live rooms
// (context/MOONSHOT.md): nothing is kept any more, but browsers that used an
// older build may still hold plaintext edits, and sign-out must wipe them.
import { describe, it, expect } from 'vitest'
import { forgetKeptEdits } from '../../src/localBackup.js'

function fakeIndexedDB({ fail = false } = {}) {
  const deleted = []
  return {
    deleted,
    deleteDatabase(name) {
      deleted.push(name)
      const req = {}
      queueMicrotask(() => (fail ? req.onerror?.() : req.onsuccess?.()))
      return req
    },
  }
}

describe('forgetKeptEdits', () => {
  it('deletes both databases older builds kept edits in', async () => {
    const indexedDB = fakeIndexedDB()
    expect(await forgetKeptEdits({ indexedDB })).toBe(true)
    expect(indexedDB.deleted.sort()).toEqual(['atlasmap', 'pleiades'])
  })

  it('without IndexedDB, or when it fails, resolves false and never throws', async () => {
    expect(await forgetKeptEdits({ indexedDB: undefined })).toBe(false)
    expect(await forgetKeptEdits({ indexedDB: fakeIndexedDB({ fail: true }) })).toBe(false)
  })
})
