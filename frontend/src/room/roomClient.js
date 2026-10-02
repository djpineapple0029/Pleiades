/**
 * The browser side of a live map room (context/MOONSHOT.md; the wire
 * protocol is in MOONSHOT-BUILD.md). Yjs sync and awareness travel as binary
 * frames, the room's control messages as JSON text.
 *
 * Edits only go out while the room says we may edit *and* we're connected.
 * Offline is read-only (decision 21), so nothing piles up locally to diverge.
 * Anything we sent that the server never got is offered again by the sync
 * handshake on reconnect (the server's step1 asks for it).
 */
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const SYNC = 0
const AWARENESS = 1
/** Transaction origin of updates that came from the room. */
export const REMOTE = 'room'
// After these the server closes, and reconnecting would only repeat them.
const FINAL = new Set(['kicked', 'deleted', 'reload'])

export function createRoomClient({
  url,
  doc,
  WebSocketImpl = globalThis.WebSocket,
  onControl = () => {},
  onState = () => {},
  backoff = { min: 1000, max: 15000 },
  setTimer = (fn, ms) => setTimeout(fn, ms),
}) {
  const awareness = new awarenessProtocol.Awareness(doc)
  let socket = null
  let state = 'connecting'
  let synced = false // this connection has the server's step2 *and* its welcome
  let gotStep2 = false
  let finished = false
  let delay = backoff.min
  let you = null
  let map = null
  let epoch = ''
  let roster = []
  let resolveSynced
  const whenSynced = new Promise((resolve) => (resolveSynced = resolve))

  const roleCanEdit = () => you !== null && you.role !== 'viewer'
  function setState(next) {
    if (state === next) return
    state = next
    onState(next)
  }

  function sendBytes(bytes) {
    if (socket && socket.readyState === 1) socket.send(bytes)
  }

  function frame(type, write) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, type)
    write(encoder)
    return encoding.toUint8Array(encoder)
  }

  const awarenessFrame = (clients) =>
    frame(AWARENESS, (e) =>
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, clients)),
    )

  function connect() {
    if (finished) return
    const target = epoch ? `${url}${url.includes('?') ? '&' : '?'}epoch=${encodeURIComponent(epoch)}` : url
    const ws = new WebSocketImpl(target)
    socket = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      sendBytes(frame(SYNC, (e) => syncProtocol.writeSyncStep1(e, doc)))
      if (awareness.getLocalState() !== null) sendBytes(awarenessFrame([doc.clientID]))
    }
    ws.onmessage = (event) => {
      if (ws !== socket) return
      if (typeof event.data === 'string') {
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        control(message)
      } else binary(new Uint8Array(event.data))
    }
    ws.onclose = () => {
      if (ws !== socket) return
      synced = false
      gotStep2 = false
      const others = [...awareness.getStates().keys()].filter((id) => id !== doc.clientID)
      awarenessProtocol.removeAwarenessStates(awareness, others, REMOTE)
      if (finished) {
        setState('closed')
        return
      }
      setState('offline')
      setTimer(connect, delay)
      delay = Math.min(delay * 2, backoff.max)
    }
  }

  function binary(data) {
    const decoder = decoding.createDecoder(data)
    const type = decoding.readVarUint(decoder)
    if (type === SYNC) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, SYNC)
      const kind = syncProtocol.readSyncMessage(decoder, encoder, doc, REMOTE)
      if (encoding.length(encoder) > 1) sendBytes(encoding.toUint8Array(encoder))
      if (kind === syncProtocol.messageYjsSyncStep2) {
        gotStep2 = true
        markSynced()
      }
    } else if (type === AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), REMOTE)
    }
  }

  /** Live (or read-only) once we hold the map and know our role, whichever comes last. */
  function markSynced() {
    if (synced || !gotStep2 || you === null) return
    synced = true
    delay = backoff.min
    setState(roleCanEdit() ? 'live' : 'read_only')
    resolveSynced()
  }

  function control(message) {
    if (message.type === 'welcome') {
      you = message.you
      map = message.map
      epoch = message.epoch
    } else if (message.type === 'roster') roster = message.people
    else if (message.type === 'access') you = { ...you, role: message.role, perms: message.perms }
    else if (message.type === 'read_only') you = { ...you, role: 'viewer' }
    if (message.type === 'welcome') markSynced()
    // A role can change under a live connection (milestone 2), or between
    // two connections: the newest word on it decides.
    if (['welcome', 'access', 'read_only'].includes(message.type) && synced) {
      setState(roleCanEdit() ? 'live' : 'read_only')
    }
    if (FINAL.has(message.type)) finished = true
    onControl(message)
  }

  doc.on('update', (update, origin) => {
    if (origin === REMOTE || state !== 'live') return
    sendBytes(frame(SYNC, (e) => syncProtocol.writeUpdate(e, update)))
  })

  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin !== 'local') return
    sendBytes(awarenessFrame(added.concat(updated, removed)))
  })

  connect()

  return {
    awareness,
    whenSynced,
    REMOTE,
    get state() {
      return state
    },
    get canEdit() {
      return state === 'live' && roleCanEdit()
    },
    get you() {
      return you
    },
    get map() {
      return map
    },
    get epoch() {
      return epoch
    },
    get roster() {
      return roster
    },
    send(message) {
      if (socket && socket.readyState === 1) socket.send(JSON.stringify(message))
    },
    destroy() {
      finished = true
      awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], 'local')
      awareness.destroy()
      socket?.close()
    },
  }
}
