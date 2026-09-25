/**
 * Entry point for an exported map: the whole renderer, none of the editor.
 *
 * This is `main.js` with everything that can change a graph left out —
 * `interaction.js`, `editor.js`, `radialMenu.js`, `files.js` and `physics.js`
 * are not imported, so an exported file cannot spawn, connect, edit, delete,
 * re-balance, save or open. What it keeps is the entire look: stars, bloom,
 * skybox, dust, edges and their drift motes, labels, flight and the overview.
 *
 * The map itself is a JSON payload spliced into the page at export time (see
 * `files.js`), so the file is self-contained and needs no server. The layout is
 * frozen exactly as it was exported: there is no physics here to move it.
 */

import './style.css'
import * as THREE from 'three'
import { createScene } from './scene.js'
import { createFlight } from './flight.js'
import { createSkybox } from './skybox.js'
import { createDust } from './dust.js'
import { createDustRivers } from './dustRivers.js'
import { createBloom } from './bloom.js'
import { createGraph } from './graph.js'
import { createGraphView } from './graphView.js'
import { createOverview } from './overview.js'
import { createViewerInteraction } from './viewerInteraction.js'

const MAX_FRAME_DELTA = 0.1 // seconds — clamps the jump after a backgrounded tab

const canvas = document.getElementById('viewport')
const overlay = document.getElementById('overlay')
const crosshair = document.getElementById('crosshair')
const notice = document.getElementById('notice')
const hud = document.getElementById('hud')
const speed = document.getElementById('speed')

/**
 * The embedded map, or null if this page has none.
 *
 * A template that was built but never exported still carries the build's
 * `__ATLASMAP_*` placeholder there, which is not JSON — so it lands here as
 * "no map", the same as any other unreadable payload. Deliberately not tested
 * for by name: naming it would put a second copy of the marker in the bundle,
 * and `files.js` fills only the first one it finds.
 */
function readPayload() {
  const tag = document.getElementById('atlasmap-map')
  const text = tag?.textContent?.trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const { renderer, scene, camera } = createScene(canvas)
const skybox = createSkybox(renderer)
scene.add(skybox.object)
scene.add(createDust())
const bloom = createBloom(renderer, scene, camera)

const flight = createFlight(camera, canvas)
camera.position.set(0, 0, 260)

const graph = createGraph()
const view = createGraphView(graph, scene, renderer)
const rivers = createDustRivers(graph, scene, { radiusOf: view.radiusOf })
const overview = createOverview({ camera, canvas, graph, view, controls: flight.controls })

const interaction = createViewerInteraction({
  camera,
  controls: flight.controls,
  flight,
  graph,
  view,
  overview,
  hud,
  speedEl: speed,
})

const payload = readPayload()
let failure = null
if (!payload) {
  failure = 'This file holds no map.'
} else {
  try {
    graph.load(payload)
    view.sync()
    // The camera the map was exported from. It is where the opening move
    // starts; the fit below is where it ends.
    const saved = payload.camera
    const triple = (v) => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(Number.isFinite)
    if (triple(saved?.position)) camera.position.fromArray(saved.position)
    if (triple(saved?.rotation)) camera.rotation.set(...saved.rotation.slice(0, 3))
  } catch (error) {
    failure = error.message || 'This file does not hold a graph.'
  }
}

if (failure) {
  notice.textContent = failure
  notice.hidden = false
} else {
  // Open on the whole map rather than at the author's camera: whoever opens
  // this did not build it, and the author's last position could be pointed at
  // empty space. `toggle` flies out from the saved pose over 0.45s, so the
  // opening move still says where the map was being looked at from.
  overview.toggle()
  overlay.hidden = true
}

flight.controls.addEventListener('lock', () => {
  overlay.hidden = true
  crosshair.hidden = false
  notice.hidden = true
})

flight.controls.addEventListener('unlock', () => {
  crosshair.hidden = true
  // Not in the overview: there the mouse is a real cursor and the map is the
  // whole point, so a click-to-fly panel over it would only be in the way.
  if (!overview.isActive) overlay.hidden = false
})

function requestLock() {
  // In the overview a click is a drag of the orbit, and taking the lock back
  // would end the mode under the user; Tab is the only way out of it.
  if (overview.isActive) return
  if (!flight.controls.isLocked) flight.controls.lock()
}

canvas.addEventListener('click', requestLock)
window.addEventListener('keydown', (event) => {
  if (event.code === 'Enter') requestLock()
})

// Chrome refuses re-lock for ~1.25s after an Esc release; say so instead of
// leaving the click looking broken.
document.addEventListener('pointerlockerror', () => {
  notice.textContent = 'Pointer lock refused. Wait a moment, then click again.'
  notice.hidden = false
  overlay.hidden = false
})

const clock = new THREE.Clock()

renderer.setAnimationLoop(() => {
  const delta = Math.min(clock.getDelta(), MAX_FRAME_DELTA)
  flight.update(delta)
  // After flight: the flight out to the overview owns the camera outright, and
  // pointer lock takes a moment to actually go.
  overview.update(delta)
  interaction.update()
  view.update(clock.elapsedTime, camera) // getDelta above has just advanced it
  rivers.update(delta)
  bloom.render() // the whole frame, stars and bloom included
})
