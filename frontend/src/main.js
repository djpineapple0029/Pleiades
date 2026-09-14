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

const MAX_FRAME_DELTA = 0.1 // seconds — clamps the jump after a backgrounded tab

const canvas = document.getElementById('viewport')
const overlay = document.getElementById('overlay')
const crosshair = document.getElementById('crosshair')
const notice = document.getElementById('notice')
const hud = document.getElementById('hud')

const { renderer, scene, camera, dispose: disposeScene } = createScene(canvas)
const skybox = createSkybox(renderer)
scene.add(skybox.object)
const dust = createDust()
scene.add(dust)
const bloom = createBloom(renderer, scene, camera)

const flight = createFlight(camera, canvas)
camera.position.set(0, 0, 260)

const graph = createGraph()
const view = createGraphView(graph, scene, renderer)
const physics = createPhysics(graph, view)
const files = createFiles({ graph, view, camera, physics })

// Drives the same camera as flight does — the bloom pipeline captured that one.
const overview = createOverview({ camera, canvas, graph, view, controls: flight.controls })

const interaction = createInteraction({
  camera,
  controls: flight.controls,
  flight,
  graph,
  view,
  physics,
  files,
  overview,
  menu: createRadialMenu(document.getElementById('radial-menu')),
  editor: createEditor(document.getElementById('editor')),
  hud,
})

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
})

// Chrome refuses re-lock for ~1.25s after an Esc release; say so instead of
// leaving the click looking broken.
document.addEventListener('pointerlockerror', () => {
  notice.textContent = 'Pointer lock refused. Wait a moment, then click again.'
  notice.hidden = false
  // The notice lives inside the overlay, and Tab out of the overview leaves it
  // hidden — a refusal there would otherwise land on an empty screen.
  overlay.hidden = false
})

const clock = new THREE.Clock()

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
  view.update(clock.elapsedTime, camera) // getDelta above has just advanced it
  bloom.render() // the whole frame, stars and bloom included
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    renderer.setAnimationLoop(null)
    physics.stop()
    overview.dispose()
    interaction.dispose()
    view.dispose()
    bloom.dispose()
    skybox.dispose()
    dust.geometry.dispose()
    dust.material.dispose()
    flight.dispose()
    disposeScene()
  })
}
