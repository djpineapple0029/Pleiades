import './style.css'
import * as THREE from 'three'
import { createScene } from './scene.js'
import { createFlight } from './flight.js'
import { createSkybox } from './skybox.js'
import { createDust } from './dust.js'
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

const MAX_FRAME_DELTA = 0.1 // seconds — clamps the jump after a backgrounded tab

const canvas = document.getElementById('viewport')
const overlay = document.getElementById('overlay')
const crosshair = document.getElementById('crosshair')
const notice = document.getElementById('notice')
const resumePill = document.getElementById('resume-pill')
const hud = document.getElementById('hud')
const speed = document.getElementById('speed')

const { renderer, scene, camera, dispose: disposeScene } = createScene(canvas)
const skybox = createSkybox(renderer)
scene.add(skybox.object)
const dust = createDust()
scene.add(dust)
const bloom = createBloom(renderer, scene, camera)

const flight = createFlight(camera, canvas)
// Before anything else listens for `unlock`: the listeners below read which
// kind of unlock it was.
const lock = createPointerLock(flight.controls)
camera.position.set(0, 0, 260)

const graph = createGraph()
const view = createGraphView(graph, scene, renderer)
const physics = createPhysics(graph, view)
const files = createFiles({ graph, view, camera, physics })

// Drives the same camera as flight does — the bloom pipeline captured that one.
const overview = createOverview({ camera, canvas, graph, view, controls: flight.controls })

// Minimal, in-memory only: freezes the star-pulse clock read by the frame
// loop below. No other visible motion in the scene is clock-driven.
let reducedMotion = false
let frozenElapsed = 0
const renderSettings = {
  get reducedMotion() {
    return reducedMotion
  },
  toggleReducedMotion() {
    reducedMotion = !reducedMotion
    if (reducedMotion) frozenElapsed = clock.elapsedTime
  },
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
  menu: createRadialMenu(document.getElementById('radial-menu')),
  editor: createEditor(document.getElementById('editor')),
  titleEdit: createTitleEdit(),
  sidebar: createNotesSidebar(document.getElementById('notes-sidebar')),
  hud,
  speedEl: speed,
})

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
  if (interaction.isModal || overview.isActive) return
  if (!flight.controls.isLocked) flight.controls.lock()
}

canvas.addEventListener('click', requestLock)
window.addEventListener('keydown', (event) => {
  if (event.code === 'Enter') requestLock()
  // `?` swaps the small resume hint for the full key list and back.
  if (event.key === '?' && !flight.controls.isLocked && !interaction.isModal && !overview.isActive) {
    const showKeys = overlay.hidden
    overlay.hidden = !showKeys
    resumePill.hidden = showKeys
  }
})

// Chrome refuses re-lock for ~1.25s after an Esc release; say so instead of
// leaving the click looking broken.
document.addEventListener('pointerlockerror', () => {
  notice.textContent = 'Pointer lock refused. Wait a moment, then click again.'
  notice.hidden = false
  // The notice lives inside the overlay, and Tab out of the overview leaves it
  // hidden — a refusal there would otherwise land on an empty screen.
  overlay.hidden = false
  resumePill.hidden = true
})

const clock = new THREE.Clock()

// `files.js` is the one thing here the viewer bundle never has, so the tab
// title is owned here, not in interaction.js or viewerInteraction.js.
let lastTitle = null
function updateTitle() {
  const title = `${files.isDirty ? '• ' : ''}${files.filename} — AtlasMap`
  if (title === lastTitle) return
  lastTitle = title
  document.title = title
}

renderer.setAnimationLoop(() => {
  const delta = Math.min(clock.getDelta(), MAX_FRAME_DELTA)
  flight.update(delta)
  // After flight: the flight out to the overview owns the camera outright, and
  // pointer lock takes a moment to actually go.
  overview.update(delta)
  // Layout before interaction: the crosshair should raycast against where the
  // nodes are this frame, not where they were last frame.
  physics.update()
  interaction.update()
  // getDelta above has just advanced elapsedTime; reduced motion freezes only
  // this reading, so the star pulse stops while everything else keeps timing.
  view.update(reducedMotion ? frozenElapsed : clock.elapsedTime, camera)
  bloom.render() // the whole frame, stars and bloom included
  updateTitle()
})

// Skipped under HMR: without this, every dev-time module reload would trip
// the same "you have unsaved changes" prompt the real close of a dirty tab
// gets. Browsers ignore any custom text here and show their own wording.
if (!import.meta.hot) {
  window.addEventListener('beforeunload', (event) => {
    if (!files.isDirty) return
    event.preventDefault()
    event.returnValue = ''
  })
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    renderer.setAnimationLoop(null)
    physics.stop()
    overview.dispose()
    interaction.dispose()
    lock.dispose()
    view.dispose()
    bloom.dispose()
    skybox.dispose()
    dust.geometry.dispose()
    dust.material.dispose()
    flight.dispose()
    disposeScene()
  })
}
