// Autosave for server maps (src/serverMap.js): debounce, one request at a
// time, Balance deferral, revisions, and what each kind of failure does.
// A fake clock and a scripted `request` stand in for time and the server.
import { describe, it, expect } from 'vitest'
import { createGraph } from '../../src/graph.js'
import {
  DEBOUNCE_MS,
  KEEPALIVE_LIMIT,
  RETRY_MIN_MS,
  createServerMap,
  loadServerMap,
} from '../../src/serverMap.js'

// Stands in for localBackup.js's store: one record per map, and a log of what was asked.
function fakeBackup({ works = true } = {}) {
  const records = new Map()
  const ops = []
  return {
    records,
    ops,
    put: async (record) => {
      ops.push('put')
      if (works) records.set(record.mapId, structuredClone(record))
      return works
    },
    remove: async (mapId) => {
      ops.push('remove')
      records.delete(mapId)
      return true
    },
  }
}

function setup({ revision = 1, backup = null } = {}) {
  const graph = createGraph()
  const physics = { isRunning: false }
  const clock = { t: 0 }
  const calls = []
  // Each PUT waits here until the test answers it.
  const pending = []
  const request = (path, init) => {
    calls.push({ path, ...init })
    return new Promise((resolve) => pending.push(resolve))
  }
  const map = createServerMap({
    map: { id: 'abcdefghijklmnop', name: 'Galaxy', revision },
    graph,
    physics,
    toPayload: () => graph.toPayload(),
    request,
    now: () => clock.t,
    backup,
    wallClock: () => 1_700_000_000_000,
  })
  const answer = async (result) => {
    pending.shift()(result)
    // Let save()'s continuations run.
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  const ok = (rev) => answer({ ok: true, status: 200, data: { revision: rev } })
  const advance = (ms) => {
    clock.t += ms
    map.tick()
  }
  const edit = () => {
    graph.addNode({ x: 0, y: 0, z: 0 })
    map.tick()
  }
  return { graph, physics, clock, calls, map, answer, ok, advance, edit, backup }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('serverMap autosave', () => {
  it('starts saved and sends nothing while clean', () => {
    const { map, calls, advance } = setup()
    advance(DEBOUNCE_MS * 5)
    expect(map.isDirty).toBe(false)
    expect(map.statusText).toBe('saved')
    expect(calls).toEqual([])
  })

  it('saves DEBOUNCE_MS after the last edit, with the revision it was based on', async () => {
    const { map, calls, advance, edit, ok } = setup({ revision: 7 })
    edit()
    expect(map.statusText).toBe('unsaved')
    advance(DEBOUNCE_MS - 1)
    edit() // a new edit restarts the wait
    advance(DEBOUNCE_MS - 1)
    expect(calls).toHaveLength(0)
    advance(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].path).toBe('api/maps/abcdefghijklmnop')
    expect(calls[0].headers['If-Match']).toBe('7')
    expect(JSON.parse(calls[0].body).payload.nodes).toHaveLength(2)
    expect(map.statusText).toBe('saving…')
    expect(map.hasUnsaved).toBe(true)

    await ok(8)
    expect(map.statusText).toBe('saved')
    expect(map.revision).toBe(8)
    expect(map.hasUnsaved).toBe(false)
  })

  it('one request at a time; edits made during a save schedule another', async () => {
    const { map, calls, advance, edit, ok } = setup()
    edit()
    advance(DEBOUNCE_MS)
    edit()
    advance(DEBOUNCE_MS * 2)
    expect(calls).toHaveLength(1)
    await ok(2)
    expect(map.isDirty).toBe(true)
    advance(0)
    expect(calls).toHaveLength(2)
    expect(calls[1].headers['If-Match']).toBe('2')
    await ok(3)
    expect(map.isDirty).toBe(false)
  })

  it('undo back to the saved state is clean again', async () => {
    const { graph, map, advance, edit, ok } = setup()
    edit()
    advance(DEBOUNCE_MS)
    await ok(2)
    const saved = graph.contentRevision
    edit()
    graph.setContentRevision(saved)
    expect(map.isDirty).toBe(false)
  })

  it('waits for a Balance run to finish, then saves', async () => {
    const { physics, graph, map, calls, advance } = setup()
    physics.isRunning = true
    advance(DEBOUNCE_MS * 3)
    expect(map.isDirty).toBe(true)
    expect(calls).toHaveLength(0)
    physics.isRunning = false
    graph.touchContent() // what physics.stop() does at the end of a run
    advance(0)
    advance(DEBOUNCE_MS)
    expect(calls).toHaveLength(1)
  })

  it('a save taken mid-Balance leaves the map unsaved', async () => {
    const { physics, map, ok } = setup()
    physics.isRunning = true
    const result = map.saveNow()
    await ok(2)
    expect((await result).ok).toBe(true)
    physics.isRunning = false
    expect(map.isDirty).toBe(true)
  })

  it('Ctrl+S skips the debounce, and says so when there is nothing to save', async () => {
    const { map, calls, edit, ok } = setup()
    expect(await map.saveNow()).toEqual({ ok: true, unchanged: true })
    edit()
    const result = map.saveNow()
    expect(calls).toHaveLength(1)
    await ok(2)
    expect(await result).toEqual({ ok: true })
  })

  it('Ctrl+S during a save waits for it, then saves what came after', async () => {
    const { map, calls, advance, edit, ok } = setup()
    edit()
    advance(DEBOUNCE_MS)
    edit()
    const result = map.saveNow()
    await ok(2)
    expect(calls).toHaveLength(2)
    await ok(3)
    expect(await result).toEqual({ ok: true })
    expect(map.isDirty).toBe(false)
  })

  it('a conflict stops autosave for good and never overwrites', async () => {
    const { map, calls, advance, edit, answer } = setup()
    edit()
    advance(DEBOUNCE_MS)
    await answer({ ok: false, status: 409, data: { revision: 5 }, error: 'changed' })
    expect(map.isStopped).toBe(true)
    expect(map.statusText).toContain('another tab or device')
    edit()
    advance(DEBOUNCE_MS * 10)
    expect(calls).toHaveLength(1)
    expect((await map.saveNow()).ok).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('a deleted map stops autosave too', async () => {
    const { map, advance, edit, answer } = setup()
    edit()
    advance(DEBOUNCE_MS)
    await answer({ ok: false, status: 404, error: 'Not Found' })
    expect(map.isStopped).toBe(true)
    expect(map.statusText).toContain('deleted')
  })

  it('offline retries with backoff, and a success resets it', async () => {
    const { map, calls, advance, edit, answer, ok } = setup()
    edit()
    advance(DEBOUNCE_MS)
    await answer({ ok: false, status: 0, error: 'could not reach the server' })
    expect(map.statusText).toBe('offline, not saved (retrying)')
    advance(RETRY_MIN_MS - 1)
    expect(calls).toHaveLength(1)
    advance(1)
    expect(calls).toHaveLength(2)
    await answer({ ok: false, status: 502, error: 'bad gateway' })
    advance(RETRY_MIN_MS)
    expect(calls, 'the second wait is longer').toHaveLength(2)
    advance(RETRY_MIN_MS)
    expect(calls).toHaveLength(3)
    await ok(2)
    expect(map.statusText).toBe('saved')
  })

  it('backoff is capped', async () => {
    const { calls, advance, edit, answer } = setup()
    edit()
    advance(DEBOUNCE_MS)
    for (let i = 0; i < 10; i++) {
      await answer({ ok: false, status: 0, error: 'down' })
      advance(60_000)
    }
    expect(calls).toHaveLength(11)
  })

  it('signed out keeps retrying, so signing in elsewhere recovers it', async () => {
    const { map, calls, advance, edit, answer } = setup()
    edit()
    advance(DEBOUNCE_MS)
    await answer({ ok: false, status: 401, error: 'Signed out' })
    expect(map.statusText).toContain('signed out')
    advance(RETRY_MIN_MS)
    expect(calls).toHaveLength(2)
  })

  it('a refusal waits for the next edit rather than retrying the same thing', async () => {
    const { map, calls, advance, edit, answer } = setup()
    edit()
    advance(DEBOUNCE_MS)
    await answer({ ok: false, status: 413, error: 'Map is larger than this server will accept.' })
    expect(map.statusText).toBe('not saved: Map is larger than this server will accept.')
    advance(DEBOUNCE_MS * 20)
    expect(calls).toHaveLength(1)
    edit()
    advance(DEBOUNCE_MS)
    expect(calls).toHaveLength(2)
  })

  it('flush uses keepalive when the body fits, and a plain request when it does not', async () => {
    const { graph, map, calls, edit, ok } = setup()
    edit()
    map.flush()
    expect(calls[0].keepalive).toBe(true)
    await ok(2)
    graph.setNodeText([...graph.nodes.keys()][0], 'x'.repeat(KEEPALIVE_LIMIT), '')
    map.flush()
    expect(calls[1].keepalive).toBe(false)
  })

  it('flush does nothing when clean or stopped', () => {
    const { map, calls } = setup()
    map.flush()
    expect(calls).toEqual([])
  })
})

describe('serverMap backup in this browser', () => {
  const ID = 'abcdefghijklmnop'

  it('the happy path never touches it', async () => {
    const { advance, edit, ok, backup } = setup({ backup: fakeBackup() })
    edit()
    advance(DEBOUNCE_MS)
    await ok(2)
    expect(backup.ops).toEqual([])
  })

  it('a failed save keeps what it tried to send, based on the old revision', async () => {
    const { advance, edit, answer, backup } = setup({ revision: 4, backup: fakeBackup() })
    edit()
    advance(DEBOUNCE_MS)
    await answer({ ok: false, status: 0, error: 'could not reach the server' })
    const record = backup.records.get(ID)
    expect(record).toMatchObject({ mapId: ID, name: 'Galaxy', baseRevision: 4, savedAt: 1_700_000_000_000 })
    expect(record.payload.nodes).toHaveLength(1)
  })

  it('edits made while offline reach it after the debounce, and a clean save removes it', async () => {
    const { map, advance, edit, answer, ok, backup } = setup({ backup: fakeBackup() })
    edit()
    advance(DEBOUNCE_MS)
    await answer({ ok: false, status: 0, error: 'down' })
    edit()
    advance(DEBOUNCE_MS - 1)
    expect(backup.records.get(ID).payload.nodes).toHaveLength(1)
    advance(1)
    expect(backup.records.get(ID).payload.nodes).toHaveLength(2)
    // Nothing new: not written again every tick.
    const puts = backup.ops.length
    advance(RETRY_MIN_MS * 4)
    expect(backup.ops.slice(puts)).toEqual([])
    // The retry already went out (and is still waiting); it lands.
    await ok(2)
    await settle()
    expect(map.isDirty).toBe(false)
    expect(backup.records.has(ID)).toBe(false)
  })

  it('after a conflict, edits keep reaching it though nothing is sent', async () => {
    const { map, calls, advance, edit, answer, backup } = setup({ backup: fakeBackup() })
    edit()
    advance(DEBOUNCE_MS)
    await answer({
      ok: false,
      status: 409,
      data: { revision: 5, updated_at: 1_700_000_100 },
      error: 'changed',
    })
    expect(map.problemKind).toBe('conflict')
    expect(map.conflictAt).toBe(1_700_000_100)
    expect(backup.records.get(ID).baseRevision).toBe(1)
    edit()
    advance(DEBOUNCE_MS)
    expect(backup.records.get(ID).payload.nodes).toHaveLength(2)
    expect(calls).toHaveLength(1)
  })

  it('flush keeps it even when it cannot send, and even mid-save', async () => {
    const { map, calls, advance, edit, answer, backup } = setup({ backup: fakeBackup() })
    edit()
    map.flush()
    expect(backup.records.get(ID).payload.nodes).toHaveLength(1)
    expect(calls).toHaveLength(1)
    // Mid-save, a second flush keeps it again but doesn't send twice.
    edit()
    map.flush()
    expect(backup.records.get(ID).payload.nodes).toHaveLength(2)
    expect(calls).toHaveLength(1)
    await answer({ ok: false, status: 409, data: {}, error: 'changed' })
    edit()
    map.flush()
    expect(backup.records.get(ID).payload.nodes).toHaveLength(3)
    advance(DEBOUNCE_MS)
    expect(calls).toHaveLength(1)
  })

  it('after leave(), nothing is kept or sent', async () => {
    const { map, calls, advance, edit, answer, backup } = setup({ backup: fakeBackup() })
    edit()
    advance(DEBOUNCE_MS)
    await answer({ ok: false, status: 409, data: {}, error: 'changed' })
    map.leave()
    await map.forgetBackup()
    expect(backup.records.has(ID)).toBe(false)
    edit()
    map.flush()
    advance(DEBOUNCE_MS)
    expect(backup.records.has(ID)).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('an adopted backup is removed by the next clean save', async () => {
    const { map, advance, edit, ok, backup } = setup({ backup: fakeBackup() })
    backup.records.set(ID, { mapId: ID })
    map.adoptBackup()
    edit()
    advance(DEBOUNCE_MS)
    await ok(2)
    expect(backup.records.has(ID)).toBe(false)
  })

  it('a browser that refuses to store gives up asking', async () => {
    const backup = fakeBackup({ works: false })
    const { map, advance, edit, answer } = setup({ backup })
    expect(map.keepsLocally).toBe(true)
    edit()
    advance(DEBOUNCE_MS)
    await answer({ ok: false, status: 0, error: 'down' })
    await settle()
    expect(map.keepsLocally).toBe(false)
    edit()
    advance(DEBOUNCE_MS)
    map.flush()
    expect(backup.ops).toEqual(['put'])
  })

  it('saveCopy makes a new map from the current state or a given payload', async () => {
    const { map, calls, edit, answer } = setup()
    edit()
    const made = map.saveCopy('Galaxy (conflict copy)')
    expect(calls[0]).toMatchObject({ path: 'api/maps', method: 'POST' })
    expect(calls[0].body.name).toBe('Galaxy (conflict copy)')
    expect(calls[0].body.payload.nodes).toHaveLength(1)
    await answer({ ok: true, status: 201, data: { id: 'qrstuvwxyzabcdef', name: 'Galaxy (conflict copy)' } })
    expect(await made).toEqual({ ok: true, id: 'qrstuvwxyzabcdef', name: 'Galaxy (conflict copy)' })

    const full = map.saveCopy('x', { nodes: [], edges: [] })
    expect(calls[1].body.payload).toEqual({ nodes: [], edges: [] })
    await answer({ ok: false, status: 409, error: 'You have the most maps this server allows (1).' })
    expect(await full).toMatchObject({ ok: false, status: 409 })
  })

  it('keepInHistory sends the edits here, based on the revision they started from', async () => {
    const { map, calls, edit, advance, answer } = setup({ revision: 3 })
    expect(await map.keepInHistory()).toEqual({ ok: true, unchanged: true })
    expect(calls).toHaveLength(0)

    edit()
    advance(DEBOUNCE_MS)
    await answer({ ok: false, status: 409, data: { revision: 4 }, error: 'changed' })
    const kept = map.keepInHistory()
    expect(calls[1]).toMatchObject({ path: 'api/maps/abcdefghijklmnop/snapshots', method: 'POST' })
    expect(calls[1].body.revision).toBe(3)
    expect(calls[1].body.payload.nodes).toHaveLength(1)
    await answer({ ok: true, status: 201, data: { id: 7 } })
    expect(await kept).toEqual({ ok: true })

    const failed = map.keepInHistory()
    await answer({ ok: false, status: 0, error: 'could not reach the server' })
    expect(await failed).toMatchObject({ ok: false, status: 0 })
  })
})

describe('loadServerMap', () => {
  it('passes a failure through and checks the shape of a success', async () => {
    const failed = await loadServerMap('x', {
      request: async () => ({ ok: false, status: 401, error: 'Signed out' }),
    })
    expect(failed).toMatchObject({ ok: false, status: 401 })
    const bad = await loadServerMap('x', {
      request: async () => ({ ok: true, status: 200, data: { name: 'a' } }),
    })
    expect(bad.ok).toBe(false)
    const good = await loadServerMap('x', {
      request: async () => ({
        ok: true,
        status: 200,
        data: { name: 'a', revision: 3, payload: { nodes: [] } },
      }),
    })
    expect(good).toEqual({ ok: true, map: { id: 'x', name: 'a', revision: 3, payload: { nodes: [] } } })
  })
})
