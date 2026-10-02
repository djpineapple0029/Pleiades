import './style.css'
import * as THREE from 'three'
import { createScene } from './scene.js'
import { createFlight } from './flight.js'
import { createSkybox } from './skybox.js'
import { createDust } from './dust.js'
import { createLooks, storedLook } from './looks.js'
import { createDustRivers } from './dustRivers.js'
import { createSupernova } from './supernova.js'
import { createBloom } from './bloom.js'
import { createGraph } from './graph.js'
import { createGraphView } from './graphView.js'
import { createPhysics } from './physics.js'
import { createFiles } from './files.js'
import { createMapDoc } from './mapDoc.js'
import { createDocBridge } from './docBridge.js'
import { createUndo } from './undo.js'
import { createRadialMenu } from './radialMenu.js'
import { createEditor } from './editor.js'
import { createOverview } from './overview.js'
import { createInteraction } from './interaction.js'
import { createPointerLock } from './pointerLock.js'
import { createTitleEdit } from './titleEdit.js'
import { createNotesSidebar } from './notesSidebar.js'
import { createSearchPanel } from './searchPanel.js'
import { createFlyTo } from './flyTo.js'
import { fetchSettings } from './settings.js'
import { createKeymap } from './keymap.js'
import { APP_ROWS, SERVER_MAP_ROWS, renderKeyList, renderPromptHint, renderResumePill } from './keysHelp.js'
import { setRevealScale, setLabelTarget } from './labels.js'
import { CONTEXT_LOST, NO_WEBGL, createCrashGuard, errorText } from './crashGuard.js'
import { watchContextLoss } from './contextLoss.js'
import { accountUrl, homeUrl, request, roomUrl } from './api.js'
import { askGuestName, guestKey, rememberLink } from './room/guestPrompt.js'
import { can } from './room/can.js'
import { createRoomClient } from './room/roomClient.js'
import { colourFor, hexToRgb, personName } from './room/authors.js'
import { createPosePublisher } from './room/presence.js'
import { createAvatars } from './room/avatars.js'
import { createRoster } from './room/roster.js'
import { docToPayload } from './format/ydoc.js'

const MAX_FRAME_DELTA = 0.1 // seconds — clamps the jump after a backgrounded tab
const STATUS_TICK_MS = 250 // the HUD's own clock once the frame loop has stopped

const canvas = document.getElementById('viewport')
const overlay = document.getElementById('overlay')
const keyList = overlay.querySelector('.keys')
const crosshair = document.getElementById('crosshair')
const notice = document.getElementById('notice')
const resumePill = document.getElementById('resume-pill')
const hud = document.getElementById('hud')
const speed = document.getElementById('speed')
const guard = createCrashGuard({
  overlay,
  prompt: overlay.querySelector('.prompt'),
  keys: keyList,
  notice,
  exitPointerLock: () => document.exitPointerLock?.(),
})

// Stops this module here for good: the page is navigating away, or a notice
// already says why nothing more can happen.
const halt = () => new Promise(() => {})

// `?map=<id>` opens a map from the account's list; `?local` (or no query at
// all, which only the e2e harness sends here) is the app without an account.
// Plain `/` is the homepage (home.html), sent by Flask or vite.config.js.
const params = new URLSearchParams(location.search)
const mapId = params.get('map')

// The map as a Yjs doc (context/MOONSHOT.md): commands write it, the bridge
// carries every change into the graph and the scene, undo walks back only
// this tab's edits. A server map's doc is the one its live room shares:
// it arrives by sync, everyone in the room edits it, and the room saves it.
const mapDoc = createMapDoc()
// The centred panel for prompts: the guest name below, then the file flows.
const editor = createEditor(document.getElementById('editor'))

// A share link (`/s/<token>` lands here as `?map=<id>#link=<token>`): signed
// in, it makes you a member (Shared with me); signed out, you join as a guest
// under a name you pick. A link that no longer works is the room's to refuse.
const linkToken = mapId ? rememberLink(mapId) : null
let guest = null
if (linkToken) {
  const me = await request('api/auth/me')
  const user = me.ok ? me.data?.user : null
  if (user && !user.must_change_password) {
    await request(`api/maps/${encodeURIComponent(mapId)}/join`, { method: 'POST', body: { link: linkToken } })
  } else if (!user) {
    guest = { link: linkToken, name: await askGuestName(editor), key: guestKey() }
  }
}

// Room events reach `interaction` once it exists; before that, only whether
// the map opened at all matters (openRoom below).
let onRoomState = () => {}
let onRoomControl = () => {}
const room = mapId
  ? createRoomClient({
      url: roomUrl(mapId, location, undefined, guest),
      doc: mapDoc.doc,
      onState: (state) => onRoomState(state),
      onControl: (message) => onRoomControl(message),
    })
  : null
const ROOM_ENDS = new Set(['closed', 'kicked', 'deleted', 'reload'])
const OPEN_TIMEOUT_MS = 15_000

/** 'synced', the message that ended the room before it opened, or 'timeout'. */
function openRoom() {
  return new Promise((resolve) => {
    onRoomControl = (message) => {
      if (ROOM_ENDS.has(message.type)) resolve(message)
    }
    room.whenSynced.then(() => resolve('synced'))
    setTimeout(() => resolve('timeout'), OPEN_TIMEOUT_MS)
  })
}

// Keybinds and settings from the server's config (/admin). Defaults if the
// server can't be reached, so a failure here never stops the app starting.
const [settings, opening] = await Promise.all([
  fetchSettings(`${import.meta.env.BASE_URL}api/config`),
  room ? openRoom() : null,
])
if (opening && opening !== 'synced') {
  if (opening === 'timeout') {
    room.destroy()
    guard.showFatal('This map could not be reached. Check your connection, then reload.')
    await halt()
  }
  if (opening.type === 'reload') {
    location.reload()
    await halt()
  }
  if (opening.type === 'closed' && opening.code === 4429) {
    guard.showFatal('This map is full right now. Try again in a little while.')
    await halt()
  }
  if (guest) {
    guard.showFatal(
      opening.type === 'closed' && opening.code === 4400
        ? "That name can't be used. Reload to pick another."
        : "This link doesn't work any more. Ask whoever shared it for a new one.",
    )
    await halt()
  }
  // Refused. Signed out: the shell signs in; a password the admin reset: the
  // shell asks for a new one first; otherwise the map is gone or not shared
  // with this account, which the shell says.
  const me = await request('api/auth/me')
  const user = me.ok ? me.data?.user : null
  location.replace(accountUrl(user && !user.must_change_password ? 'missing' : ''))
  await halt()
}
const keymap = createKeymap(settings.keybinds)
const { visuals } = settings
setRevealScale(visuals.label_range)
setLabelTarget(visuals.label_count)
renderKeyList(keyList, keymap, room ? SERVER_MAP_ROWS : APP_ROWS)
renderPromptHint(overlay.querySelector('.prompt-hint'), keymap, {
  helpHref: room ? accountUrl('help') : null,
})
renderResumePill(resumePill, keymap)

let sceneParts
try {
  sceneParts = createScene(canvas)
} catch (error) {
  // No WebGL 2 (turned off, blocklisted, a VM): say so instead of an inviting
  // "Click to fly" that does nothing, then stop — nothing below can run.
  guard.showFatal(NO_WEBGL)
  throw error
}
const { renderer, scene, camera, dispose: disposeScene } = sceneParts
const skybox = createSkybox(renderer)
scene.add(skybox.object)
const dust = createDust()
scene.add(dust.object)
const bloom = createBloom(renderer, scene, camera, { strength: visuals.bloom_strength })

const flight = createFlight(camera, canvas, { keymap, ...settings.flight })
// Before anything else listens for `unlock`: the listeners below read which
// kind of unlock it was.
const lock = createPointerLock(flight.controls)
camera.position.set(0, 0, 260)

const graph = createGraph()
const view = createGraphView(graph, scene, renderer)
view.setHeat(visuals.connection_heat, { instant: true })
view.setBrightness(visuals.node_brightness)
const rivers = createDustRivers(graph, scene, { radiusOf: view.radiusOf })
const supernova = createSupernova(scene)
// Balance prototype variants (context/BALANCE2.md): `?layout=shell,subgroups`
// picks an arrangement (free | shell | disc) and/or an inner layout
// (force | rings | subgroups). Temporary, while the variants are compared.
const layoutParam = new URLSearchParams(location.search).get('layout')?.split(',') ?? []
// Prototype switches (context/BALANCE2.md), temporary: `?lanes=1` bundles
// links between groups, `?nebula=1` adds group nebulae.
const layoutFlags = new URLSearchParams(location.search)
view.setLanes(layoutFlags.get('lanes') === '1')
view.setNebulae(layoutFlags.get('nebula') === '1')
const physics = createPhysics(graph, view, {
  layout: {
    // The Balance's starting shape: cone trees, unless `?tree=disc|off`. The
    // tree_shape key (hold T) picks among all three in the map.
    tree: ['disc', 'cone', 'off'].find((v) => v === layoutFlags.get('tree')) ?? 'cone',
    arrangement: layoutParam.find((v) => ['free', 'shell', 'disc'].includes(v)),
    inner: layoutParam.find((v) => ['force', 'rings', 'subgroups'].includes(v)),
  },
})
const undo = createUndo({ mapDoc, graph })
const files = createFiles({ graph, view, camera, physics, settings, mapDoc })

// A server map: the graph is read from the room's doc, which stays as it is.
if (room) {
  try {
    files.applyPayload(docToPayload(mapDoc.doc), { keepDoc: true })
  } catch (error) {
    room.destroy()
    guard.showFatal(`This map could not be opened: ${errorText(error)}.`)
    await halt()
  }
  files.setFilename(room.map.name)
}
// After the first content is in place (a synced room's, or the empty map a
// local one starts as), so the bridge only ever sees changes to it. What
// others did reaches `interaction` (below) once it exists.
let onRemoved = () => {}
createDocBridge({
  mapDoc,
  graph,
  view,
  physics,
  onRemoved: (removal) => onRemoved(removal),
  // Their edit glows in their colour for a moment (decision 11).
  onRemoteChange: ({ nodeIds, authors }) => {
    if (!room || !nodeIds.size) return
    for (const author of authors) {
      const colour = colourFor(author, room.roster)
      if (colour) view.flash(nodeIds, hexToRgb(colour))
    }
  },
})
// Set once the user has chosen to go back to the list, so leaving doesn't
// also ask "leave site?" about the save they already decided on.
let leaving = false

// Drives the same camera as flight does — the bloom pipeline captured that one.
const overview = createOverview({ camera, canvas, graph, view, controls: flight.controls })
// Search jumps and Backspace fly the same camera, with flight suspended.
const flyTo = createFlyTo(camera)

const clock = new THREE.Clock()

// The look (`looks.js`, hold V): which layers draw, how the stars look, and
// whether anything moves. A look without motion freezes the star-pulse clock
// read by the frame loop below; the others carry on from where it stopped.
let frozenElapsed = 0
const looks = createLooks({
  renderer,
  skybox,
  dust,
  bloom,
  view,
  rivers,
  supernova,
  fade: document.getElementById('look-fade'),
  bloomStrength: visuals.bloom_strength,
  onChange: (look) => {
    if (!look.motion) frozenElapsed = clock.elapsedTime
  },
  // Signed in, a V pick is kept in the account, not this browser, and the
  // account's look (the config's, for them) is where every map starts.
  ...(settings.account ? { store: keepLookInAccount } : {}),
})
looks.set(settings.account ? visuals.look : (storedLook() ?? visuals.look), {
  instant: true,
  remember: false,
})

// One save at a time; picks made meanwhile collapse into the latest.
let lookToKeep = null
let keepingLook = false
async function keepLookInAccount(id) {
  lookToKeep = id
  if (keepingLook) return
  keepingLook = true
  while (lookToKeep) {
    const look = lookToKeep
    lookToKeep = null
    const result = await request('api/account/settings', { method: 'PATCH', body: { visuals: { look } } })
    if (!result.ok) interaction.reportError(`look not saved to your account: ${result.error}`)
  }
  keepingLook = false
}

const renderSettings = {
  /** True in a look that doesn't move: jumps cut instead of flying. */
  get reducedMotion() {
    return !looks.current.motion
  },
  /** The config's "supernova on delete", in a look that has them. */
  get supernova() {
    return visuals.supernova && looks.current.supernova
  },
  looks,
}

const interaction = createInteraction({
  camera,
  controls: flight.controls,
  lock,
  flight,
  graph,
  view,
  physics,
  mapDoc,
  undo,
  files,
  overview,
  renderSettings,
  supernova,
  menu: createRadialMenu(document.getElementById('radial-menu')),
  editor,
  titleEdit: createTitleEdit(),
  sidebar: createNotesSidebar(document.getElementById('notes-sidebar'), {
    writeKey: keymap.label('edit_notes'),
  }),
  search: createSearchPanel(document.getElementById('search')),
  flyTo,
  hud,
  speedEl: speed,
  keymap,
  room,
  leaveToMaps,
})

function leaveToMaps() {
  leaving = true
  room?.destroy()
  // A guest has no list of maps: back to the homepage.
  location.assign(guest ? homeUrl() : accountUrl())
}

// How long a "this map was deleted" (or similar) stays up before the list.
const ENDED_MS = 2500

/** Everything the room says once the map is open. */
function onRoomMessage(message) {
  if (message.type === 'reload') {
    // Replaced outside the room (a restore, an upload): start again from it.
    leaving = true
    location.reload()
  } else if (message.type === 'deleted') {
    interaction.roomEnded('this map was deleted')
    setTimeout(leaveToMaps, ENDED_MS)
  } else if (message.type === 'kicked') {
    interaction.roomEnded('you were removed from this map')
    setTimeout(leaveToMaps, ENDED_MS)
  } else if (message.type === 'closed') {
    if (message.code === 4404) {
      interaction.roomEnded('this map is no longer shared with you')
      setTimeout(leaveToMaps, ENDED_MS)
    } else if (message.code === 4400 || message.code === 4413) {
      interaction.roomEnded('the server refused an edit from this tab · reload')
    } else if (message.code === 4429) {
      interaction.roomEnded('this map is full · reload to try again')
    }
  } else if (message.type === 'roster') {
    showPeople()
  } else if (message.type === 'access') {
    showShareLink()
  } else {
    interaction.roomMessage(message)
  }
}

// Presence (context/MOONSHOT.md): this camera out through awareness, everyone
// else in as avatars and roster bubbles.
const avatars = room ? createAvatars({ scene }) : null
const publisher = room ? createPosePublisher({ awareness: room.awareness }) : null
const BEHIND = 30 // how far back a roster click puts you, along their view
const roster = room
  ? createRoster(document.getElementById('roster'), {
      onFly: (entry) => {
        const now = performance.now()
        const pose = entry.clientIds.map((id) => avatars.sampleOf(id, now)).find(Boolean)
        if (!pose) return
        const quaternion = new THREE.Quaternion().fromArray(pose.q)
        const back = new THREE.Vector3(0, 0, BEHIND).applyQuaternion(quaternion)
        interaction.flyToPose(new THREE.Vector3().fromArray(pose.p).add(back), quaternion)
      },
    })
  : null

/** The room's roster into avatars (by Yjs client id) and bubbles. */
function showPeople() {
  const me = room.you?.conn
  const others = []
  for (const person of room.roster) {
    if (person.conn === me) continue
    for (const clientId of person.clientIds ?? [])
      others.push({ clientId, ...person, name: personName(person) })
  }
  avatars.sync(others)
  roster.render(room.roster, room.you)
}

// The Esc screen's "Share this map…", for anyone with the Invite permission
// (live: it follows `access` messages): My maps, with this map's sharing
// open. Not for guests: they have no My maps.
function showShareLink() {
  if (!room) return
  document.getElementById('share-link').href = accountUrl(`share=${mapId}`)
  document.getElementById('share-hint').hidden = !(can(room, 'invite') && !room.you?.guest)
}
showShareLink()

if (room) {
  room.awareness.on('change', ({ added, updated }) => {
    const states = room.awareness.getStates()
    const now = performance.now()
    for (const clientId of added.concat(updated)) {
      if (clientId === mapDoc.doc.clientID) continue
      avatars.push(clientId, states.get(clientId)?.pose, now)
    }
  })
  showPeople()
}
// Someone else deleted it: whatever is open about it here closes (decision 10).
onRemoved = (removal) => {
  if (!removal.local) interaction.closeAbout(removal)
}
if (room) {
  onRoomState = (state) => interaction.roomState(state)
  onRoomControl = onRoomMessage
  interaction.roomState(room.state)
}

// A room saves as it goes; only a local file can have unsaved changes.
const hasUnsaved = () => (room ? false : files.isDirty)

// The e2e suites' handle on the app (tests/e2e/multiplayer). Dev server only:
// `npm run build` drops this block, so it never ships.
if (import.meta.env.DEV) {
  window.__pleiades = { graph, mapDoc, undo, room, interaction, avatars, commands: interaction.commands }
}

flight.controls.addEventListener('lock', () => {
  overlay.hidden = true
  resumePill.hidden = true
  crosshair.hidden = false
  notice.hidden = true
})

// An unlock the user caused (Esc, or the browser taking the lock away) gets
// the overlay's bare "Click to fly" — the key list waits behind `?`. One the
// app caused itself either shows a panel of its own ('panel': nothing else)
// or a native dialog ('file': a small hint for whenever that's dismissed),
// and in both the lock comes back by itself.
flight.controls.addEventListener('unlock', () => {
  crosshair.hidden = true
  // Not in the overview: there the mouse is a real cursor and the map is the
  // whole point, so a click-to-fly panel over it would only be in the way.
  if (overview.isActive) return
  const reason = lock.lastUnlockReason
  if (reason === 'manual') {
    keyList.hidden = true
    overlay.hidden = false
  } else if (reason === 'file') resumePill.hidden = false
})

function requestLock() {
  // A click while the password or edit panel is up would pull focus out of the
  // field the user is typing into. In the overview a click is a drag of the
  // orbit, and taking the lock back would end the mode under the user; Tab is
  // the only way out of it.
  if (interaction.isModal || overview.isActive || guard.isBlocking) return
  if (!flight.controls.isLocked) flight.controls.lock()
}

canvas.addEventListener('click', requestLock)
window.addEventListener('keydown', (event) => {
  if (keymap.is(event, 'resume')) requestLock()
  // `?` shows or hides the full key list; from the small resume hint it
  // brings up the overlay with the list.
  if (
    keymap.is(event, 'help') &&
    !flight.controls.isLocked &&
    !interaction.isModal &&
    !overview.isActive &&
    !guard.isBlocking
  ) {
    if (overlay.hidden) {
      keyList.hidden = false
      overlay.hidden = false
      resumePill.hidden = true
    } else {
      keyList.hidden = !keyList.hidden
    }
  }
})

// Chrome refuses re-lock for ~1.25s after an Esc release; say so instead of
// leaving the click looking broken.
document.addEventListener('pointerlockerror', () => {
  if (guard.isBlocking) return // a crash or context-loss notice says more
  notice.textContent = 'Pointer lock refused. Wait a moment, then click again.'
  notice.hidden = false
  // The notice lives inside the overlay, and Tab out of the overview leaves it
  // hidden — a refusal there would otherwise land on an empty screen.
  overlay.hidden = false
  resumePill.hidden = true
})

// `files.js` is the one thing here the viewer bundle never has, so the tab
// title is owned here, not in interaction.js or viewerInteraction.js.
let lastTitle = null
function updateTitle() {
  const title = `${hasUnsaved() ? '• ' : ''}${room ? room.map.name : files.filename} — Pleiades`
  if (title === lastTitle) return
  lastTitle = title
  document.title = title
}

// Rendering has stopped for good, but the map is intact in memory and every
// key listener still works: tell the user to save it. The HUD's messages keep
// ticking on their own, so that save can still say how it went.
let statusTimer = null
function onRenderCrash(error) {
  guard.showFatal(
    `Rendering stopped: ${errorText(error)}. Your map is still in memory — ` +
      `press ${keymap.label('save')} to save it, then reload.`,
  )
  lock.disable()
  statusTimer = setInterval(interaction.tickStatus, STATUS_TICK_MS)
}

// Anything thrown outside the frame loop (a file flow nobody awaited, a
// listener) lands on the HUD rather than only in the console.
const removeGlobalHandlers = guard.installGlobalHandlers(interaction.reportError)

// three restores its own state; the two things that only ever lived on the GPU
// are rebuilt here, and the dust rivers' tables go back up whole (three would
// otherwise send only the grains that changed that frame). The notice covers the gap, which is usually a blink.
const stopWatchingContext = watchContextLoss(canvas, {
  onLost: () => guard.cover(CONTEXT_LOST),
  onRestored: () => {
    if (guard.isFatal) return
    try {
      skybox.rebake()
      rivers.restore()
      view.invalidateLabels()
      guard.uncover()
    } catch (error) {
      onRenderCrash(error)
    }
  },
})

renderer.setAnimationLoop(guard.guardFrame(renderer, frame, onRenderCrash))

function frame() {
  const delta = Math.min(clock.getDelta(), MAX_FRAME_DELTA)
  flight.update(delta)
  // After flight: the flight out to the overview owns the camera outright, and
  // pointer lock takes a moment to actually go.
  overview.update(delta)
  // Layout before interaction: the crosshair should raycast against where the
  // nodes are this frame, not where they were last frame.
  physics.update()
  // After physics, so a jump aims at where its star is this frame, and before
  // interaction, so the crosshair raycasts from where the camera now is.
  flyTo.update(delta)
  interaction.update()
  if (room) {
    publisher.publish({
      p: camera.position.toArray(),
      q: camera.quaternion.toArray(),
      mode: interaction.presenceMode,
      editing: interaction.editingId,
    })
    avatars.update(performance.now(), camera)
  }
  // getDelta above has just advanced elapsedTime. Reduced motion freezes only
  // the pulse's reading of it: the stars stop breathing, but sizes, tints and
  // label fades still step (a frozen clock for all of it left new labels
  // invisible and edits un-eased with motion off).
  const look = looks.current
  view.update(clock.elapsedTime, camera, look.motion ? clock.elapsedTime : frozenElapsed)
  dust.update(look.motion ? delta : 0)
  // After the view: the rivers read the stars' drawn radii. A look without
  // them draws neither (deletes don't start a burst then, either).
  if (!look.rivers || !visuals.dust_rivers) {
    rivers.hide()
    if (look.supernova) supernova.update(delta)
  } else {
    supernova.update(delta)
    rivers.setDim(view.mapDim) // a search dims the rivers with the edges
    rivers.update(delta, supernova.shocks())
  }
  bloom.render() // the whole frame, stars and bloom included
  updateTitle()
}

// Skipped under HMR: without this, every dev-time module reload would trip
// the same "you have unsaved changes" prompt the real close of a dirty tab
// gets. Browsers ignore any custom text here and show their own wording.
if (!import.meta.hot) {
  window.addEventListener('beforeunload', (event) => {
    if (leaving || !hasUnsaved()) return
    event.preventDefault()
    event.returnValue = ''
  })
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    renderer.setAnimationLoop(null)
    clearInterval(statusTimer)
    avatars?.dispose()
    room?.destroy()
    removeGlobalHandlers()
    stopWatchingContext()
    physics.stop()
    overview.dispose()
    interaction.dispose()
    lock.dispose()
    view.dispose()
    rivers.dispose()
    supernova.dispose()
    bloom.dispose()
    skybox.dispose()
    dust.dispose()
    flight.dispose()
    disposeScene()
  })
}
