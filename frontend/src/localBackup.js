/**
 * What's left of this browser's copy of a server map's unsaved edits
 * (USERS.md, "Offline"). Server maps now open through live rooms
 * (context/MOONSHOT.md), which save as you go and are read-only while the
 * connection is down, so nothing is kept here any more.
 *
 * Older builds kept those edits as plaintext in IndexedDB (`pleiades`, and
 * `atlasmap` before the rename). Sign-out and account deletion still wipe
 * whatever a browser has left over, since it belongs to whoever signed in.
 */
const DATABASES = ['pleiades', 'atlasmap']

function remove(indexedDB, name) {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name)
      req.onsuccess = () => resolve(true)
      req.onerror = () => resolve(false)
      req.onblocked = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

/** Resolves true once both are gone; false (never a throw) without IndexedDB. */
export async function forgetKeptEdits({ indexedDB = globalThis.indexedDB } = {}) {
  if (!indexedDB) return false
  const results = await Promise.all(DATABASES.map((name) => remove(indexedDB, name)))
  return results.every(Boolean)
}
