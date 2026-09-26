/**
 * The accounts API (`server/accounts.py`, `server/maps.py`) from the browser.
 *
 * Every call carries `X-Atlas: 1`, the header the server demands on anything
 * that changes state (a cross-site form can't send it), and the session
 * cookie, which is HttpOnly and never visible here. Failures come back as
 * values, never throws: `{ ok: false, status, error }`, with `status` 0 when
 * the server couldn't be reached at all (or didn't answer in time).
 *
 * DOM-free apart from `fetch`, so the account shell, the scene and Node tests
 * all share it.
 */

export const BASE = import.meta.env?.BASE_URL ?? '/'
const TIMEOUT_MS = 30_000
// Asked before the app starts: a slow answer must not hold up the classic app.
const LANDING_TIMEOUT_MS = 3000

/** Where the account shell lives, with an optional `#reason` for a notice there. */
export function accountUrl(reason = '') {
  return `${BASE}account.html${reason ? `#${reason}` : ''}`
}

/** The app on a server map, or the classic app with no account (`?local`). */
export function appUrl(mapId = null) {
  return mapId ? `${BASE}?map=${encodeURIComponent(mapId)}` : `${BASE}?local`
}

/**
 * `path` is relative to the app's base (`api/maps`). `body` is sent as is when
 * it's a string (a caller that needs its size has already stringified it),
 * otherwise as JSON. `keepalive` lets the request outlive the page.
 */
export async function request(
  path,
  { method = 'GET', body, headers = {}, keepalive = false, timeoutMs = TIMEOUT_MS, fetchImpl } = {},
) {
  const doFetch = fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  // A keepalive request is fire-and-forget as the page goes; no timer for it.
  const timer = keepalive ? null : setTimeout(() => controller.abort(), timeoutMs)
  const init = {
    method,
    keepalive,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: keepalive ? undefined : controller.signal,
    headers: { 'X-Atlas': '1', ...headers },
  }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    init.headers['Content-Type'] = 'application/json'
  }

  let response
  try {
    response = await doFetch(`${BASE}${path}`, init)
  } catch {
    return { ok: false, status: 0, data: null, error: 'could not reach the server' }
  } finally {
    if (timer) clearTimeout(timer)
  }

  let data = null
  try {
    data = await response.json()
  } catch {
    // Not JSON: a proxy, the dev server or a plain 404 page answered.
  }
  if (!response.ok) {
    const error =
      typeof data?.error === 'string' && data.error ? data.error : `server returned ${response.status}`
    return { ok: false, status: response.status, data, error }
  }
  return { ok: true, status: response.status, data }
}

/**
 * Whether `/` should hand over to the account shell: only when this server has
 * accounts switched on. Anything else, an old server, no server, a slow one,
 * means the classic app, exactly as before accounts existed.
 */
export async function accountsEnabled({ fetchImpl } = {}) {
  const result = await request('api/auth/me', { timeoutMs: LANDING_TIMEOUT_MS, fetchImpl })
  return result.ok && result.data?.enabled === true
}
