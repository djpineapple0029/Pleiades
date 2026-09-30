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
 * overwrite it, and the user picks what happens (`interaction.js`'s conflict
 * panel, `saveCopy`). A network failure or 5xx retries with backoff; a refusal
 * that retrying won't fix (too large, malformed) waits for the next edit instead.
 *
 * Edits the server doesn't have yet also go to this browser (`backup`,
 * `localBackup.js`): when a save fails, while a problem lasts, and when the tab
 * goes away. A save that leaves the map clean removes them again. The happy
 * path never touches the backup.
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
  backup = null,
  wallClock = () => Date.now(),
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
  // The content token this browser's backup holds; undefined when there is
  // none, null when there is one of unknown content (`adoptBackup`).
  let backupToken
  // IndexedDB refused a write (private window, full disk): stop asking.
  let backupBroken = false
  // When the other tab or device saved, from a 409 (epoch seconds).
  let conflictAt = null
  // The user has decided and the page is going: nothing more is kept or sent.
  let left = false

  const isDirty = () => Boolean(physics.isRunning) || graph.contentRevision !== savedToken

  function backoff() {
    failures += 1
    retryAt = now() + Math.min(RETRY_MIN_MS * 2 ** (failures - 1), RETRY_MAX_MS)
  }

  /** Puts `payload` (content `token`) in this browser, one record per map. */
  function keepLocally(payload, token) {
    if (!backup || backupBroken || left) return
    backupToken = token
    const record = { mapId: id, name, baseRevision: revision, savedAt: wallClock(), payload }
    backup.put(record).then((stored) => {
      if (stored) return
      backupBroken = true
      if (backupToken === token) backupToken = undefined
    })
  }

  function dropBackup() {
    if (!backup || backupToken === undefined) return
    backupToken = undefined
    backup.remove(id)
  }

  function recordFailure(result, sentToken, payload) {
    const { status, error } = result
    // Kept before `revision` can move: the record says what the edits were based on.
    if (payload) keepLocally(payload, sentToken)
    if (status === 409) {
      stopped = true
      problem = { kind: 'conflict', text: 'changed in another tab or device, not saved' }
      if (Number.isInteger(result.data?.updated_at)) conflictAt = result.data.updated_at
    } else if (status === 404) {
      stopped = true
      problem = { kind: 'gone', text: 'this map was deleted, not saved' }
    } else if (status === 401) {
      problem = { kind: 'signed-out', text: 'signed out, not saved (sign in again in another tab)' }
      backoff()
    } else if (status === 403 && result.data?.must_change_password) {
      // Reset by the admin, then signed in again elsewhere with the temporary password.
      problem = { kind: 'signed-out', text: 'not saved (choose a new password in another tab)' }
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
    let payload
    let body
    try {
      payload = toPayload()
      body = JSON.stringify({ payload })
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
      if (!isDirty()) dropBackup()
      return { ok: true }
    }
    recordFailure(result.ok ? { status: 0, error: 'unexpected answer' } : result, sentToken, payload)
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
    if (left) return
    const token = graph.contentRevision
    if (token !== seenToken) {
      seenToken = token
      changedAt = now()
    }
    if (inFlight || !isDirty() || physics.isRunning) return
    const at = now()
    const settled = at - changedAt >= DEBOUNCE_MS
    // While saving can't work, edits made since still reach this browser.
    if (problem && settled && token !== backupToken) keepLocally(toPayload(), token)
    if (stopped) return
    if (refusedToken !== undefined && refusedToken === token) return
    if (!settled || at < retryAt) return
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
    /**
     * The tab is going away or out of sight: keep what there is in this
     * browser, then send it, keepalive if it fits. A save still on its way
     * may not outlive the tab, so that's kept too.
     */
    flush() {
      if (left || (!isDirty() && !inFlight)) return
      if (isDirty()) keepLocally(toPayload(), graph.contentRevision)
      if (stopped || inFlight) return
      save({ keepalive: true })
    },
    /**
     * A new map in the account holding `payload` (by default, this one as it
     * stands). `{ ok: true, id, name }`, or the failure. A copy made of this
     * map's unsaved edits should `forgetBackup()` afterwards.
     */
    async saveCopy(copyName, payload = toPayload()) {
      const result = await request('api/maps', { method: 'POST', body: { name: copyName, payload } })
      if (!result.ok) return result
      if (typeof result.data?.id !== 'string') return { ok: false, status: 0, error: 'unexpected answer' }
      return { ok: true, id: result.data.id, name: result.data.name ?? copyName }
    },
    /**
     * Keeps this map as it stands here in its history on the server, without
     * making it the current version (the conflict panel's "load theirs", before
     * it drops these edits). `{ ok: true }` at once when there's nothing
     * unsaved to keep, else `{ ok: true }` or the failure.
     */
    async keepInHistory() {
      if (!isDirty()) return { ok: true, unchanged: true }
      const result = await request(`api/maps/${encodeURIComponent(id)}/snapshots`, {
        method: 'POST',
        body: { payload: toPayload(), revision },
      })
      return result.ok ? { ok: true } : result
    },
    /** The graph now holds the edits from this browser's backup: remove it once they're saved. */
    adoptBackup() {
      backupToken = null
    },
    /** The user has decided about this browser's copy (kept elsewhere, or
     *  dropped). Resolves once it's gone, so a page can navigate after. */
    forgetBackup() {
      backupToken = undefined
      return backup ? backup.remove(id) : Promise.resolve(true)
    },
    /** The page is leaving this map on the user's word: no more saves, and the
     *  way out (pagehide) doesn't put back a backup they just dropped. */
    leave() {
      left = true
      stopped = true
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
    /** 'conflict' | 'gone' | 'offline' | 'signed-out' | 'refused', or null. */
    get problemKind() {
      return problem?.kind ?? null
    },
    /** When another tab or device saved over this one's base (epoch seconds), after a conflict. */
    get conflictAt() {
      return conflictAt
    },
    /** Whether unsaved edits can be kept in this browser at all. */
    get keepsLocally() {
      return Boolean(backup) && !backupBroken
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
