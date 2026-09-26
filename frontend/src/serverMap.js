/**
 * A map kept on the server (USERS.md, "Autosave"): loads it, then saves it a
 * few seconds after the last edit, one request at a time, never over someone
 * else's newer copy.
 *
 * Dirtiness works like `files.js`'s: the graph's content token as of the last
 * successful save, compared with the current one, and a Balance run in
 * progress always counts as unsaved (it moves nodes without taking tokens).
 * A save waits for the run to finish; the run's end takes a token of its own.
 *
 * Every save sends the revision it was based on (`If-Match`). A 409 means
 * another tab or device saved in between: autosave stops for good rather than
 * overwrite it. A network failure or 5xx retries with backoff; a refusal that
 * retrying won't fix (too large, malformed) waits for the next edit instead.
 *
 * Driven by `tick()` on a timer of the caller's, not by the frame loop, so it
 * keeps saving if rendering stops.
 */
import { request as defaultRequest } from './api.js'

export const DEBOUNCE_MS = 3000
export const TICK_MS = 250
export const RETRY_MIN_MS = 2000
export const RETRY_MAX_MS = 60_000
// Browsers cap the bodies of all in-flight keepalive requests at 64 KiB; stay
// under it with room for the rest. A larger map saves on the way out with a
// plain request, which a closing tab may or may not let finish.
export const KEEPALIVE_LIMIT = 60 * 1024

/** GET a map. `{ ok: true, map: { id, name, revision, payload } }`, or the failure. */
export async function loadServerMap(id, { request = defaultRequest } = {}) {
  const result = await request(`api/maps/${encodeURIComponent(id)}`)
  if (!result.ok) return result
  const { name, revision, payload } = result.data ?? {}
  if (typeof name !== 'string' || !Number.isInteger(revision) || !payload || typeof payload !== 'object') {
    return { ok: false, status: result.status, error: 'the server sent something that is not a map' }
  }
  return { ok: true, map: { id, name, revision, payload } }
}

export function createServerMap({
  map,
  graph,
  physics,
  toPayload,
  request = defaultRequest,
  now = () => performance.now(),
}) {
  const { id, name } = map
  let revision = map.revision
  // Taken after the payload was applied: what's in the graph now is saved.
  let savedToken = graph.contentRevision
  let seenToken = savedToken
  let changedAt = now()
  let inFlight = null
  // { kind: 'offline' | 'signed-out' | 'refused' | 'conflict' | 'gone', text }
  let problem = null
  // Conflict or gone: nothing more is sent from this tab.
  let stopped = false
  let failures = 0
  let retryAt = 0
  // A refusal retrying won't fix: wait until the content changes again.
  let refusedToken

  const isDirty = () => Boolean(physics.isRunning) || graph.contentRevision !== savedToken

  function backoff() {
    failures += 1
    retryAt = now() + Math.min(RETRY_MIN_MS * 2 ** (failures - 1), RETRY_MAX_MS)
  }

  function recordFailure(result, sentToken) {
    const { status, error } = result
    if (status === 409) {
      stopped = true
      problem = { kind: 'conflict', text: 'changed in another tab or device, not saved' }
      if (Number.isInteger(result.data?.revision)) revision = result.data.revision
    } else if (status === 404) {
      stopped = true
      problem = { kind: 'gone', text: 'this map was deleted, not saved' }
    } else if (status === 401) {
      problem = { kind: 'signed-out', text: 'signed out, not saved (sign in again in another tab)' }
      backoff()
    } else if (status === 0 || status >= 500) {
      problem = { kind: 'offline', text: 'offline, not saved (retrying)' }
      backoff()
    } else {
      problem = { kind: 'refused', text: `not saved: ${error}` }
      refusedToken = sentToken
    }
  }

  async function send(keepalive) {
    // As in files.save(): a save taken mid-Balance can't be the saved state,
    // since the run keeps moving nodes past what went out.
    const sentToken = graph.contentRevision
    const tokenAtSave = physics.isRunning ? null : sentToken
    let body
    try {
      body = JSON.stringify({ payload: toPayload() })
    } catch (error) {
      problem = { kind: 'refused', text: `not saved: ${error.message}` }
      refusedToken = sentToken
      return { ok: false, error: problem.text }
    }
    const result = await request(`api/maps/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body,
      headers: { 'If-Match': String(revision) },
      keepalive: keepalive && body.length <= KEEPALIVE_LIMIT,
    })
    if (result.ok && Number.isInteger(result.data?.revision)) {
      revision = result.data.revision
      savedToken = tokenAtSave
      problem = null
      failures = 0
      retryAt = 0
      refusedToken = undefined
      return { ok: true }
    }
    recordFailure(result.ok ? { status: 0, error: 'unexpected answer' } : result, sentToken)
    return { ok: false, error: problem.text }
  }

  /** Saves now, unless one is already on its way: then waits for it and saves again if still needed. */
  async function save({ keepalive = false } = {}) {
    if (stopped) return { ok: false, error: problem.text }
    if (inFlight) {
      await inFlight
      if (stopped) return { ok: false, error: problem.text }
      if (!isDirty()) return { ok: true }
      if (inFlight) return inFlight // another caller got there first
    }
    const mine = send(keepalive)
    inFlight = mine
    try {
      return await mine
    } finally {
      if (inFlight === mine) inFlight = null
    }
  }

  /** Once per TICK_MS: notices edits and saves DEBOUNCE_MS after the last one. */
  function tick() {
    const token = graph.contentRevision
    if (token !== seenToken) {
      seenToken = token
      changedAt = now()
    }
    if (stopped || inFlight || !isDirty() || physics.isRunning) return
    if (refusedToken !== undefined && refusedToken === token) return
    const at = now()
    if (at - changedAt < DEBOUNCE_MS || at < retryAt) return
    save()
  }

  return {
    tick,
    /** Ctrl/Cmd+S: skips the debounce and any backoff wait. */
    saveNow() {
      retryAt = 0
      refusedToken = undefined
      if (!stopped && !inFlight && !isDirty()) return Promise.resolve({ ok: true, unchanged: true })
      return save()
    },
    /** The tab is going away or out of sight: send what there is, keepalive if it fits. */
    flush() {
      if (stopped || inFlight || !isDirty()) return
      save({ keepalive: true })
    },
    get id() {
      return id
    },
    get name() {
      return name
    },
    get revision() {
      return revision
    },
    get isDirty() {
      return isDirty()
    },
    /** Anything a closing tab would lose: unsaved edits or a save still on its way. */
    get hasUnsaved() {
      return isDirty() || inFlight !== null
    },
    get isStopped() {
      return stopped
    },
    /** The HUD's word for where the map stands. */
    get statusText() {
      if (stopped) return problem.text
      if (inFlight) return 'saving…'
      if (problem && isDirty()) return problem.text
      return isDirty() ? 'unsaved' : 'saved'
    },
  }
}
