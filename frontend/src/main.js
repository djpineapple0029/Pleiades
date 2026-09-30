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
import { APP_ROWS, SERVER_MAP_ROWS, renderKeyList, renderResumePill } from './keysHelp.js'
import { setRevealScale, setLabelTarget } from './labels.js'
import { CONTEXT_LOST, NO_WEBGL, createCrashGuard, errorText } from './crashGuard.js'
import { watchContextLoss } from './contextLoss.js'
import { accountUrl, accountsEnabled, appUrl } from './api.js'
import { TICK_MS, createServerMap, loadServerMap } from './serverMap.js'
import { backupOffer, createBackupStore } from './localBackup.js'

const MAX_FRAME_DELTA = 0.1 // seconds — clamps the jump after a backgrounded tab
const STATUS_TICK_MS = 250 // the HUD's own clock once the frame loop has stopped

const canvas = document.getElementById('viewport')
const overlay = document.getElementById('overlay')
const crosshair = document.getElementById('crosshair')
const notice = document.getElementById('notice')
const resumePill = document.getElementById('resume-pill')
const hud = document.getElementById('hud')
const speed = document.getElementById('speed')
const guard = createCrashGuard({
  overlay,
  prompt: overlay.querySelector('.prompt'),
  keys: overlay.querySelector('.keys'),
  notice,
  exitPointerLock: () => document.exitPointerLock?.(),
})

// Stops this module here for good: the page is navigating away, or a notice
// already says why nothing more can happen.
const halt = () => new Promise(() => {})

// `?map=<id>` opens a map from the account's list; `?local` is the classic app
// on a server with accounts. Plain `/` on such a server belongs to the account
// shell. The e2e harness pins defaults and never has accounts.
const params = new URLSearchParams(location.search)
const mapId = params.get('map')
const askAboutAccounts =
  !mapId && !params.has('local') && import.meta.env.VITE_ATLASMAP_SETTINGS !== 'defaults'

// Keybinds and settings from the server's config (/admin). Defaults if the
// server can't be reached, so a failure here never stops the app starting.
// A server map's unsaved edits this browser kept (localBackup.js), if any.
const backups = mapId ? createBackupStore() : null
const [settings, toAccountShell, opened, keptLocally] = await Promise.all([
  fetchSettings(`${import.meta.env.BASE_URL}api/config`),
  askAboutAccounts ? accountsEnabled() : false,
  mapId ? loadServerMap(mapId) : null,
  backups ? backups.get(mapId) : null,
])
if (toAccountShell) {
  location.replace(accountUrl())
  await halt()
}
if (opened && !opened.ok) {
  // Signed out: the shell signs in. Gone (or accounts off): the shell says so.
  if (opened.status === 401 || opened.status === 404) {
    location.replace(accountUrl(opened.status === 404 ? 'missing' : ''))
    await halt()
  }
  guard.showFatal(`This map could not be opened: ${opened.error}. Reload to try again.`)
  await halt()
}
const keymap = createKeymap(settings.keybinds)
const { visuals } = settings
setRevealScale(visuals.label_range)
setLabelTarget(visuals.label_count)
renderKeyList(overlay.querySelector('.keys'), keymap, opened ? SERVER_MAP_ROWS : APP_ROWS)
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
const files = createFiles({ graph, view, camera, physics, settings })

// A map from the account's list: swapped in before anything can edit, then
// saved back by `serverMap` from here on.
let serverMap = null
if (opened) {
  try {
    files.applyPayload(opened.map.payload)
  } catch (error) {
    guard.showFatal(`This map could not be opened: ${errorText(error)}.`)
    await halt()
  }
  files.setFilename(opened.map.name)
  serverMap = createServerMap({
    map: opened.map,
    graph,
    physics,
    toPayload: files.toPayload,
    backup: backups,
  })
}
// Offered once the scene is up (below); already on the server → just dropped.
const backupKind = opened ? backupOffer(keptLocally, opened.map) : null
if (backupKind === 'same') serverMap?.forgetBackup()
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
})
looks.set(storedLook() ?? visuals.look, { instant: true, remember: false })

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
  files,
  overview,
  renderSettings,
  supernova,
  menu: createRadialMenu(document.getElementById('radial-menu')),
  editor: createEditor(document.getElementById('editor')),
  titleEdit: createTitleEdit(),
  sidebar: createNotesSidebar(document.getElementById('notes-sidebar'), {
    writeKey: keymap.label('edit_notes'),
  }),
  search: createSearchPanel(document.getElementById('search')),
  flyTo,
  hud,
  speedEl: speed,
  keymap,
  serverMap,
  leaveToMaps: () => {
    leaving = true
    location.assign(accountUrl())
  },
  // Another server map, or this one afresh, after a conflict was settled.
  goToMap: (id) => {
    leaving = true
    location.assign(appUrl(id))
  },
})
if (backupKind === 'restore' || backupKind === 'copy') interaction.offerBackup(keptLocally, backupKind)

// Autosave runs on its own timer, not the frame loop, so it outlives a
// rendering crash. Going out of sight or away flushes what's pending.
const autosaveTimer = serverMap ? setInterval(serverMap.tick, TICK_MS) : null
const flushServerMap = () => serverMap?.flush()
const onVisibility = () => {
  if (document.visibilityState === 'hidden') flushServerMap()
}
document.addEventListener('visibilitychange', onVisibility)
window.addEventListener('pagehide', flushServerMap)
const hasUnsaved = () => (serverMap ? serverMap.hasUnsaved : files.isDirty)

flight.controls.addEventListener('lock', () => {
  overlay.hidden = true
  resumePill.hidden = true
  crosshair.hidden = false
  notice.hidden = true
})

// The full key list is for an unlock the user caused (Esc, or the browser
// taking the lock away). One the app caused itself either shows a panel of
// its own ('panel': nothing else) or a native dialog ('file': a small hint
// for whenever that's dismissed), and in both the lock comes back by itself.
flight.controls.addEventListener('unlock', () => {
  crosshair.hidden = true
  // Not in the overview: there the mouse is a real cursor and the map is the
  // whole point, so a click-to-fly panel over it would only be in the way.
  if (overview.isActive) return
  const reason = lock.lastUnlockReason
  if (reason === 'manual') overlay.hidden = false
  else if (reason === 'file') resumePill.hidden = false
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
  // `?` swaps the small resume hint for the full key list and back.
  if (
    keymap.is(event, 'help') &&
    !flight.controls.isLocked &&
    !interaction.isModal &&
    !overview.isActive &&
    !guard.isBlocking
  ) {
    const showKeys = overlay.hidden
    overlay.hidden = !showKeys
    resumePill.hidden = showKeys
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
  const title = `${hasUnsaved() ? '• ' : ''}${serverMap ? serverMap.name : files.filename} — AtlasMap`
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
    clearInterval(autosaveTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', flushServerMap)
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
