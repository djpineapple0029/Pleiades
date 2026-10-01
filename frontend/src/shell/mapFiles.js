/**
 * Map files in the account shell (USERS.md decision 16): an uploaded `.plm`
 * (or `.atlasmap`) read into a payload for My maps, and a server map written
 * out as a file. The same container as the app's Open and Save
 * (format/container.js), with the same rule: the page reads and writes files
 * itself wherever it can, and only an encrypted file on a page without
 * WebCrypto (plain HTTP on the LAN) goes through the server.
 *
 * DOM-free: `fetch` and `request` are passed in or default to the browser's.
 */
import {
  ContainerPasswordError,
  cryptoAvailable,
  peekHeader,
  readContainer,
  writeContainer,
} from '../format/container.js'
import { migrate } from '../format/schema.js'

const SUFFIX = '.plm'
const LEGACY_SUFFIX = '.atlasmap'
export const ACCEPT = `${SUFFIX},${LEGACY_SUFFIX}`
const MAX_NAME_LENGTH = 120

/** `Trip.plm` / `Trip.atlasmap` → `Trip`. Empty when nothing's left. */
export function nameFromFile(filename) {
  let name = String(filename ?? '')
  for (const suffix of [SUFFIX, LEGACY_SUFFIX]) {
    if (name.toLowerCase().endsWith(suffix)) {
      name = name.slice(0, -suffix.length)
      break
    }
  }
  return name.trim().slice(0, MAX_NAME_LENGTH).trim()
}

/** A map's name as a file to save: `a/b: c` → `a-b c.plm`, never empty. */
export function fileName(mapName) {
  const safe = String(mapName ?? '')
    .replace(/[\\/]/g, '-')
    .replace(/[:*?"<>|]/g, '')
    .replace(/\p{Cc}/gu, '')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[\s.]+$/g, '')
  return `${safe || 'map'}${SUFFIX}`
}

/** `{ needsPassword }` from a file's first bytes, or null when it isn't a map file. */
export function probe(bytes) {
  try {
    const { version, mode } = peekHeader(bytes.subarray(0, 64))
    return { needsPassword: !(version === 2 && mode === 0) }
  } catch {
    return null
  }
}

/**
 * Whether this page can read the file without the server: anything with no
 * password, and anything at all where WebCrypto exists.
 */
export function readsHere(probed, crypto = cryptoAvailable()) {
  return !probed.needsPassword || crypto
}

/**
 * Reads a map file here. → `{ ok: true, payload }` (checked and brought up to
 * the current schema, so a file the app couldn't open never reaches the
 * list), or `{ ok: false, wrongPassword?, error }`.
 */
export async function readMapFile(bytes, password) {
  let payload
  try {
    payload = await readContainer(bytes, password)
  } catch (error) {
    if (error instanceof ContainerPasswordError)
      return { ok: false, wrongPassword: true, error: error.message }
    return { ok: false, error: error.message || "That file couldn't be read." }
  }
  try {
    return { ok: true, payload: migrate(payload) }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

/**
 * A payload as file bytes, here when possible: with no password always (that
 * needs no WebCrypto), with one where WebCrypto exists. Otherwise the
 * classic app's `/api/save` encrypts it, as Save does on plain HTTP.
 * → `{ ok: true, blob }` or `{ ok: false, error }`.
 */
export async function mapFileBlob(
  payload,
  password,
  { base = '/', crypto = cryptoAvailable(), fetchImpl = globalThis.fetch } = {},
) {
  if (!password || crypto) {
    try {
      const bytes = await writeContainer(payload, password)
      return { ok: true, blob: new Blob([bytes], { type: 'application/octet-stream' }) }
    } catch (error) {
      return { ok: false, error: error.message || "Couldn't write the file." }
    }
  }
  let response
  try {
    response = await fetchImpl(`${base}api/save`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, payload }),
    })
  } catch {
    return { ok: false, error: 'Could not reach the server.' }
  }
  if (!response.ok) {
    let error = `The server returned ${response.status}.`
    try {
      error = (await response.json()).error || error
    } catch {
      // Not JSON: a proxy answered.
    }
    return { ok: false, error }
  }
  return { ok: true, blob: await response.blob() }
}
