import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import * as sync from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { createRoomClient } from '../../src/room/roomClient.js'

/** A server stand-in: one Y.Doc, relays to every socket, sends welcome first. */
function fakeServer({ role = 'editor' } = {}) {
  const doc = new Y.Doc()
  const sockets = new Set()
  const urls = []
  class FakeSocket {
    constructor(url) {
      urls.push(url)
      this.readyState = 0
      sockets.add(this)
      queueMicrotask(() => {
        this.readyState = 1
        this.onopen?.()
        this.deliver(
          JSON.stringify({
            type: 'welcome',
            you: { role, name: 'me', colour: '#fff' },
            map: { name: 'G' },
            epoch: 'E1',
          }),
        )
        const e = encoding.createEncoder()
        encoding.writeVarUint(e, 0)
        sync.writeSyncStep1(e, doc)
        this.deliver(encoding.toUint8Array(e).buffer)
      })
    }
    deliver(data) {
      this.onmessage?.({ data })
    }
    send(data) {
      if (typeof data === 'string') return
      const decoder = decoding.createDecoder(new Uint8Array(data))
      const type = decoding.readVarUint(decoder)
      if (type !== 0) return
      const reply = encoding.createEncoder()
      encoding.writeVarUint(reply, 0)
      const before = Y.encodeStateVector(doc)
      sync.readSyncMessage(decoder, reply, doc, 'server')
      if (encoding.length(reply) > 1) this.deliver(encoding.toUint8Array(reply).buffer)
      const update = Y.encodeStateAsUpdate(doc, before)
      if (update.length > 2) {
        for (const other of sockets) {
          if (other === this) continue
          const e = encoding.createEncoder()
          encoding.writeVarUint(e, 0)
          sync.writeUpdate(e, update)
          other.deliver(encoding.toUint8Array(e).buffer)
        }
      }
    }
    close(code = 1000) {
      this.readyState = 3
      sockets.delete(this)
      this.onclose?.({ code })
    }
    drop() {
      this.readyState = 3
      sockets.delete(this)
      this.onclose?.({ code: 1006 })
    }
  }
  return { doc, sockets, urls, FakeSocket }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('roomClient', () => {
  it('syncs, then an edit on one client reaches the other', async () => {
    const server = fakeServer()
    const a = new Y.Doc()
    const b = new Y.Doc()
    const ca = createRoomClient({ url: 'ws://x', doc: a, WebSocketImpl: server.FakeSocket })
    const cb = createRoomClient({ url: 'ws://x', doc: b, WebSocketImpl: server.FakeSocket })
    await Promise.all([ca.whenSynced, cb.whenSynced])
    expect(ca.state).toBe('live')
    expect(ca.you.name).toBe('me')
    expect(ca.map.name).toBe('G')
    a.getMap('nodes').set('n', 1)
    await tick()
    expect(b.getMap('nodes').get('n')).toBe(1)
  })

  it('the map the server holds arrives on sync', async () => {
    const server = fakeServer()
    server.doc.getMap('nodes').set('star', 'here')
    const a = new Y.Doc()
    const ca = createRoomClient({ url: 'ws://x', doc: a, WebSocketImpl: server.FakeSocket })
    await ca.whenSynced
    expect(a.getMap('nodes').get('star')).toBe('here')
  })

  it('a viewer is read-only and never sends its updates', async () => {
    const server = fakeServer({ role: 'viewer' })
    const a = new Y.Doc()
    const ca = createRoomClient({ url: 'ws://x', doc: a, WebSocketImpl: server.FakeSocket })
    await ca.whenSynced
    expect(ca.state).toBe('read_only')
    expect(ca.canEdit).toBe(false)
    a.getMap('nodes').set('n', 1)
    await tick()
    expect(server.doc.getMap('nodes').get('n')).toBeUndefined()
  })

  it('a dropped connection goes offline (no editing) and reconnects with its epoch', async () => {
    const server = fakeServer()
    const timers = []
    const a = new Y.Doc()
    const states = []
    const ca = createRoomClient({
      url: 'ws://x',
      doc: a,
      WebSocketImpl: server.FakeSocket,
      onState: (s) => states.push(s),
      setTimer: (fn) => timers.push(fn),
    })
    await ca.whenSynced
    ;[...server.sockets][0].drop()
    expect(ca.state).toBe('offline')
    expect(ca.canEdit).toBe(false)
    timers.shift()()
    await tick()
    await tick()
    expect(ca.state).toBe('live')
    expect(states).toEqual(['live', 'offline', 'live'])
    expect(server.urls.at(-1)).toBe('ws://x?epoch=E1')
  })

  it('kicked, deleted and reload stop reconnecting', async () => {
    const server = fakeServer()
    const timers = []
    const seen = []
    const ca = createRoomClient({
      url: 'ws://x',
      doc: new Y.Doc(),
      WebSocketImpl: server.FakeSocket,
      setTimer: (fn) => timers.push(fn),
      onControl: (m) => seen.push(m.type),
    })
    await ca.whenSynced
    const socket = [...server.sockets][0]
    socket.deliver(JSON.stringify({ type: 'kicked', reason: 'owner' }))
    socket.close()
    expect(ca.state).toBe('closed')
    expect(timers).toHaveLength(0)
    expect(seen).toContain('kicked')
  })

  it('read_only from the server turns editing off', async () => {
    const server = fakeServer()
    const ca = createRoomClient({ url: 'ws://x', doc: new Y.Doc(), WebSocketImpl: server.FakeSocket })
    await ca.whenSynced
    ;[...server.sockets][0].deliver(JSON.stringify({ type: 'read_only' }))
    expect(ca.state).toBe('read_only')
    expect(ca.canEdit).toBe(false)
  })

  it('a refusal from the server (4xxx) is final and says which', async () => {
    const server = fakeServer()
    const timers = []
    const seen = []
    const ca = createRoomClient({
      url: 'ws://x',
      doc: new Y.Doc(),
      WebSocketImpl: server.FakeSocket,
      setTimer: (fn) => timers.push(fn),
      onControl: (m) => seen.push(m),
    })
    await ca.whenSynced
    ;[...server.sockets][0].close(4404)
    expect(ca.state).toBe('closed')
    expect(timers).toHaveLength(0)
    expect(seen.at(-1)).toEqual({ type: 'closed', code: 4404 })
  })

  it('flush asks the room to save now and resolves with its answer', async () => {
    const server = fakeServer()
    const ca = createRoomClient({ url: 'ws://x', doc: new Y.Doc(), WebSocketImpl: server.FakeSocket })
    await ca.whenSynced
    const socket = [...server.sockets][0]
    const sent = []
    const send = socket.send.bind(socket)
    socket.send = (data) => {
      if (typeof data === 'string') sent.push(JSON.parse(data))
      send(data)
    }
    const flushed = ca.flush()
    expect(sent).toEqual([{ type: 'flush' }])
    socket.deliver(JSON.stringify({ type: 'flushed', ok: true }))
    expect(await flushed).toBe(true)
  })

  it('flush gives up (false) when the room never answers or is gone', async () => {
    const server = fakeServer()
    const timers = []
    const ca = createRoomClient({
      url: 'ws://x',
      doc: new Y.Doc(),
      WebSocketImpl: server.FakeSocket,
      setTimer: (fn) => timers.push(fn),
    })
    await ca.whenSynced
    const flushed = ca.flush()
    timers.shift()()
    expect(await flushed).toBe(false)
    ;[...server.sockets][0].drop()
    expect(await ca.flush()).toBe(false)
  })

  it('the browser going offline drops to read-only at once; online reconnects at once', async () => {
    const server = fakeServer()
    const timers = []
    const network = new EventTarget()
    const ca = createRoomClient({
      url: 'ws://x',
      doc: new Y.Doc(),
      WebSocketImpl: server.FakeSocket,
      setTimer: (fn) => timers.push(fn),
      network,
    })
    await ca.whenSynced
    network.dispatchEvent(new Event('offline'))
    expect(ca.state).toBe('offline')
    expect(ca.canEdit).toBe(false)
    network.dispatchEvent(new Event('online'))
    await tick()
    await tick()
    expect(ca.state).toBe('live')
    // The backoff timer set by the drop finds a live socket and does nothing.
    const before = server.urls.length
    for (const fn of timers.splice(0)) fn()
    expect(server.urls.length).toBe(before)
  })
})
