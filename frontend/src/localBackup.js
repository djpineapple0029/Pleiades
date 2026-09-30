/**
 * This browser's copy of a server map's unsaved edits (USERS.md, "Offline"):
 * written when a save fails or the tab goes away with edits still unsaved,
 * removed once the server has them. Opening the map again offers what's here.
 *
 * One record per map, keyed by map id: `{ mapId, name, baseRevision, savedAt,
 * payload }`, where `baseRevision` is the server revision the edits were made
 * on top of. Map ids are random and only their owner can open a map, so the
 * offer only ever reaches the account that made the edits. The payload is
 * plaintext here, as it is on the server (USERS.md decision 19). Sign-out
 * clears the lot.
 *
 * IndexedDB can be missing, blocked or full (private windows, cleared site
 * data): every call then resolves to false/null and nothing throws.
 */

const DB_NAME = 'pleiades'
const STORE = 'unsaved-maps'
// The database's name before the rename from AtlasMap. Whatever it still
// holds moves into DB_NAME (never over a newer record) and then it's deleted.
const LEGACY_DB_NAME = 'atlasmap'

// Resolves with `request.result` once `tx` commits, or `fallback` if it doesn't.
function settled(tx, request, fallback) {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(request ? request.result : true)
    tx.onerror = () => resolve(fallback)
    tx.onabort = () => resolve(fallback)
  })
}

// The legacy database if this browser has one, else null; never creates it.
function openLegacy(indexedDB) {
  return new Promise((resolve) => {
    const req = indexedDB.open(LEGACY_DB_NAME)
    req.onupgradeneeded = () => req.transaction.abort()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

async function migrateLegacy(indexedDB, db) {
  const legacy = await openLegacy(indexedDB)
  if (!legacy) return
  let records = []
  if (legacy.objectStoreNames.contains(STORE)) {
    const tx = legacy.transaction(STORE, 'readonly')
    records = await settled(tx, tx.objectStore(STORE).getAll(), null)
  }
  legacy.close()
  if (!records) return
  const tx = db.transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  for (const record of records) {
    // `add` fails on a map that already has a newer record here; keep that one.
    store.add(record).onerror = (event) => event.preventDefault()
  }
  if (await settled(tx, null, false)) indexedDB.deleteDatabase(LEGACY_DB_NAME)
}

export function createBackupStore({ indexedDB = globalThis.indexedDB } = {}) {
  let opening = null

  function open() {
    opening ??= new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'mapId' })
        req.onsuccess = () =>
          migrateLegacy(indexedDB, req.result)
            .catch(() => {}) // left in place; tried again next time
            .then(() => resolve(req.result))
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
    return opening
  }

  // One transaction per call. Calls made in order commit in order, since they
  // share a connection and a store (IndexedDB queues overlapping writes).
  async function run(mode, act) {
    const db = await open()
    if (!db) return { ok: false }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode)
        const req = act(tx.objectStore(STORE))
        tx.oncomplete = () => resolve({ ok: true, value: req.result })
        tx.onerror = () => resolve({ ok: false })
        tx.onabort = () => resolve({ ok: false })
      } catch {
        resolve({ ok: false }) // closed connection, or a payload that won't clone
      }
    })
  }

  return {
    /** Resolves true once the record is stored. */
    put: async (record) => (await run('readwrite', (store) => store.put(record))).ok,
    /** The record for a map, or null. */
    get: async (mapId) => {
      const result = await run('readonly', (store) => store.get(mapId))
      return result.ok ? (result.value ?? null) : null
    },
    remove: async (mapId) => (await run('readwrite', (store) => store.delete(mapId))).ok,
    clear: async () => (await run('readwrite', (store) => store.clear())).ok,
  }
}

// Key order ignored: the server hands payloads back with sorted keys.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// The camera is where the user was looking, not something they edited.
const content = ({ camera: _camera, ...rest }) => canonical(rest)

/**
 * What to do with a stored record on opening `map` (`{ id, revision, payload }`):
 * - null: nothing stored for this map
 * - 'same': the server already has these edits (a save that went out as the
 *   tab closed landed after all), so drop the record quietly
 * - 'restore': the server hasn't moved since, so the edits can go straight on
 * - 'copy': the server has a newer version, so the edits can only be kept
 *   beside it, never over it
 */
export function backupOffer(record, map) {
  if (!record || record.mapId !== map.id || !record.payload || typeof record.payload !== 'object') return null
  if (content(record.payload) === content(map.payload)) return 'same'
  return record.baseRevision === map.revision ? 'restore' : 'copy'
}
