/**
 * Joining a map by share link (context/MOONSHOT.md, "Guest landing"). `/s/<token>`
 * sends the browser to `?map=<id>#link=<token>`: the token rides in the
 * fragment so it never reaches a server log or a Referer. Here it moves into
 * this tab's sessionStorage (a reload still finds it) and out of the address
 * bar. Signed out, the person picks a display name; the room shows it with
 * "(guest)" and the server cleans it (server/guests.py) — this only catches
 * the obvious before a round trip.
 */
const NAME_KEY = 'pleiades.guestName'
const KEY_KEY = 'pleiades.guestKey'
const linkKey = (mapId) => `pleiades.link.${mapId}`
export const MAX_GUEST_NAME = 24

/** `{ mapId, token }` from `?map=<id>#link=<token>`, else null. */
export function linkFromLocation(where) {
  const mapId = new URLSearchParams(where.search).get('map')
  const token = new URLSearchParams(String(where.hash ?? '').replace(/^#/, '')).get('link')
  return mapId && token ? { mapId, token } : null
}

function read(storage, key) {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function write(storage, key, value) {
  try {
    storage?.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/**
 * The share link this tab opened map `mapId` with, or null. A token in the
 * address is moved into `storage` and dropped from the address.
 */
export function rememberLink(
  mapId,
  { where = globalThis.location, storage = globalThis.sessionStorage, history = globalThis.history } = {},
) {
  const found = linkFromLocation(where)
  if (found && found.mapId === mapId) {
    history.replaceState(null, '', `${where.pathname}${where.search}`)
    return write(storage, linkKey(mapId), found.token) ? found.token : null
  }
  return read(storage, linkKey(mapId))
}

const cryptoFill = (bytes) => globalThis.crypto.getRandomValues(bytes)

/** 16 random bytes as 22 url-safe base64 characters. */
export function newGuestKey(fill = cryptoFill) {
  const bytes = fill(new Uint8Array(16))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** This tab's guest key: made once, kept for the tab's life (a kick or ban targets it). */
export function guestKey(storage = globalThis.sessionStorage) {
  const kept = read(storage, KEY_KEY)
  if (kept && /^[A-Za-z0-9_-]{22}$/.test(kept)) return kept
  const key = newGuestKey()
  write(storage, KEY_KEY, key)
  return key
}

/** Why a name won't do, or null. */
export function guestNameProblem(name) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return 'Type a name to join with.'
  if ([...trimmed].length > MAX_GUEST_NAME) return `A name is at most ${MAX_GUEST_NAME} characters.`
  return null
}

/**
 * Asks for a display name in the app's centred panel (editor.js) until one
 * will do; remembers it for next time. Pointer lock is never taken before
 * this resolves (main.js awaits it before the scene starts).
 */
export async function askGuestName(editor, { storage = globalThis.localStorage, note = null } = {}) {
  let value = read(storage, NAME_KEY) ?? ''
  let problem = note
  for (;;) {
    const answer = await editor.open(
      'Join this map as',
      [{ key: 'name', label: 'Your name', value, maxLength: MAX_GUEST_NAME }],
      problem,
      'Join',
    )
    if (answer === null) {
      problem = 'You need a name to join. Others in the map see it.'
      continue
    }
    value = answer.name
    problem = guestNameProblem(value)
    if (!problem) {
      write(storage, NAME_KEY, value.trim())
      return value.trim()
    }
  }
}
