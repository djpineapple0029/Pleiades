/**
 * Session 10: overview mode — zoom-to-fit, the orbit camera, and the handoff
 * back to locked flight. Against the real modules on deterministic SwiftShader.
 *
 * Pointer lock does not work in chrome-headless-shell, so the suite drives a
 * real `PointerLockControls` (from `flight.js`) with `isLocked` set by hand and
 * `lock`/`unlock` counted — every other code path is the app's own.
 */
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'

const BASE = process.env.BASE ?? 'http://localhost:5180'
let ok = 0, fails = 0
const check = (name, cond, extra = '') =>
  cond ? (ok++, console.log(`  pass  ${name}`)) : (fails++, console.log(`  FAIL  ${name} ${extra}`))

const browser = await chromium.launch({
  executablePath: '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('ReadPixels')) errors.push(`${m.type()}: ${m.text()}`) })
await page.goto(`${BASE}/`)
await page.waitForTimeout(1500)

const r = await page.evaluate(async () => {
  const THREE = await import('/node_modules/.vite/deps/three.js')
  const { createGraph } = await import('/src/graph.js')
  const { createGraphView, NODE_RADIUS } = await import('/src/graphView.js')
  const { createPhysics } = await import('/src/physics.js')
  const { createFlight } = await import('/src/flight.js')
  const { createOverview } = await import('/src/overview.js')
  const { createBloom, STAR_LAYER } = await import('/src/bloom.js')

  // Stop the app's own loop sharing SwiftShader with this one.
  document.getElementById('viewport').remove()

  const W = 800, H = 600
  const canvas = document.createElement('canvas')
  canvas.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px`
  document.body.append(canvas)
  // Synthetic PointerEvents are not "active" pointers, so the real capture
  // calls OrbitControls makes would throw on them.
  canvas.setPointerCapture = () => {}
  canvas.releasePointerCapture = () => {}
  canvas.hasPointerCapture = () => false

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(1)
  renderer.setSize(W, H, false)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, W / H, 0.5, 20000)
  scene.add(camera)

  const graph = createGraph()
  const view = createGraphView(graph, scene, renderer)
  const physics = createPhysics(graph, view)
  const bloom = createBloom(renderer, scene, camera)
  const flight = createFlight(camera, canvas)
  const controls = flight.controls
  let lockCalls = 0, unlockCalls = 0
  controls.lock = () => { lockCalls++; controls.isLocked = true }
  controls.unlock = () => { unlockCalls++; controls.isLocked = false }

  const overview = createOverview({ camera, canvas, graph, view, controls })
  const out = {}

  const place = (x, y, z, lookX = 0, lookY = 0, lookZ = 0) => {
    camera.position.set(x, y, z)
    camera.lookAt(lookX, lookY, lookZ)
    camera.updateMatrixWorld()
  }
  // The transition is 0.45 s; a single big step lands on t === 1.
  const arrive = () => { overview.update(1) }
  const frames = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) overview.update(dt) }

  const vp = new THREE.Matrix4()
  const probe = new THREE.Vector3()
  /** How every node lands in clip space for the camera as it stands. */
  const framing = () => {
    camera.updateMatrixWorld()
    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    let inside = 0, total = 0, worst = 0
    for (const n of graph.nodes.values()) {
      probe.set(n.x, n.y, n.z).applyMatrix4(vp)
      total++
      const m = Math.max(Math.abs(probe.x), Math.abs(probe.y))
      // A point behind the camera divides by a negative w and lands mirrored,
      // so the depth test is what actually catches it.
      if (m <= 1 && probe.z > -1 && probe.z < 1) inside++
      worst = Math.max(worst, m)
    }
    return { inside, total, worst }
  }
  const forward = () => new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
  const aimError = () => {
    const toTarget = overview.target.clone().sub(camera.position).normalize()
    return forward().angleTo(toTarget)
  }
  const rollOf = () => Math.abs(new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ').z)

  // ---- a map to frame -------------------------------------------------
  let seed = 11
  const rand = () => ((seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32
  const ids = []
  for (let i = 0; i < 120; i++) {
    ids.push(graph.addNode({ x: 400 + (rand() - 0.5) * 600, y: -200 + (rand() - 0.5) * 400, z: (rand() - 0.5) * 500 }).id)
  }
  for (let i = 1; i < 120; i++) graph.addEdge(ids[i], ids[Math.floor(rand() * i)])
  graph.setCore(ids[0], true)
  view.sync()

  // ---- entering ---------------------------------------------------------
  place(0, 0, 900)
  const startPosition = camera.position.clone()
  // Tab is pressed from locked flight, which is the only way a user reaches it.
  controls.isLocked = true
  out.beforeActive = overview.isActive

  overview.toggle()
  out.activeImmediately = overview.isActive       // click-to-lock must be suppressed at once
  out.orbitingImmediately = overview.isOrbiting   // but the orbit does not have it yet
  out.unlockCalls = unlockCalls
  out.lockedAfterEnter = controls.isLocked

  overview.update(1 / 60)
  const partial = camera.position.clone()
  out.movedPartway = partial.distanceTo(startPosition) > 0.5
  out.notSnapped = partial.distanceTo(startPosition) < startPosition.distanceTo(overview.target)
  out.stillEntering = !overview.isOrbiting && overview.isActive

  arrive()
  out.orbitingAfterArrival = overview.isOrbiting
  const fitted = framing()
  out.fitInside = fitted.inside
  out.fitTotal = fitted.total
  out.fitWorst = Number(fitted.worst.toFixed(3))
  out.fitAim = Number(aimError().toFixed(5))
  out.fitRoll = Number(rollOf().toFixed(6))
  out.fitDistance = Number(overview.distance.toFixed(1))

  // The map's own centre, independent of the module's arithmetic.
  let cx = 0, cy = 0, cz = 0
  for (const n of graph.nodes.values()) { cx += n.x; cy += n.y; cz += n.z }
  cx /= graph.nodes.size; cy /= graph.nodes.size; cz /= graph.nodes.size
  out.targetOffCentroid = Number(overview.target.distanceTo(new THREE.Vector3(cx, cy, cz)).toFixed(1))

  // Still on the side of the map the camera was on, rather than swung round it.
  const wasSide = startPosition.clone().sub(overview.target)
  const isSide = camera.position.clone().sub(overview.target)
  out.sameSide = wasSide.dot(isSide) > 0

  // The defect the look frames caught and no number here did: framing a
  // bounding *sphere* sets the distance by the map's longest axis and then
  // fits that against the narrowest field angle, which left a wide, flat map
  // filling under half the screen. Guard the silhouette fit against sliding
  // back to it. Node centres stop short of the frame edge on purpose — a label
  // hangs well outside its node's own reach — so the honest measure is against
  // what the sphere would have asked for, not against the edge.
  let sphereRadius = 0
  const centreProbe = new THREE.Vector3()
  for (const n of graph.nodes.values()) {
    sphereRadius = Math.max(
      sphereRadius,
      centreProbe.set(n.x, n.y, n.z).distanceTo(overview.target) + view.radiusOf(n.id) * 2
    )
  }
  const halfV = THREE.MathUtils.degToRad(camera.fov) / 2
  const halfH = Math.atan(Math.tan(halfV) * camera.aspect)
  out.sphereFit = Number(((sphereRadius * 1.12) / Math.sin(Math.min(halfV, halfH))).toFixed(1))

  // ---- the orbit itself -------------------------------------------------
  const drag = (dx, dy, button = 0) => {
    const opts = { pointerId: 1, pointerType: 'mouse', bubbles: true, cancelable: true, clientX: 400, clientY: 300 }
    canvas.dispatchEvent(new PointerEvent('pointerdown', { ...opts, button, buttons: button === 0 ? 1 : 2 }))
    canvas.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: 400 + dx, clientY: 300 + dy, buttons: button === 0 ? 1 : 2 }))
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: 400 + dx, clientY: 300 + dy, button, buttons: 0 }))
  }
  const beforeDrag = camera.position.clone()
  const distanceBefore = overview.distance
  drag(160, 0)
  frames(90)
  out.dragMoved = camera.position.distanceTo(beforeDrag) > 10
  out.dragKeptDistance = Math.abs(overview.distance - distanceBefore) < distanceBefore * 0.02
  out.dragAim = Number(aimError().toFixed(5))
  out.dragRoll = Number(rollOf().toFixed(6))

  const beforeZoom = overview.distance
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }))
  frames(90)
  out.zoomedIn = overview.distance < beforeZoom * 0.95
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }))
  frames(90)
  out.zoomedBack = Math.abs(overview.distance - beforeZoom) < beforeZoom * 0.05

  // Dollying all the way in stops at the min distance rather than through it.
  for (let i = 0; i < 40; i++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }))
  frames(200)
  out.minDistance = Number(overview.distance.toFixed(2))
  for (let i = 0; i < 60; i++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }))
  frames(300)
  out.maxDistance = Number(overview.distance.toFixed(0))

  // ---- the handoff back to flight ---------------------------------------
  overview.toggle()
  const handoffPosition = camera.position.clone()
  const handoffQuaternion = camera.quaternion.clone()
  out.inactiveAfterExit = !overview.isActive
  out.lockCalls = lockCalls
  out.lockedAfterExit = controls.isLocked

  // A frame of the app's loop must not move the camera now the orbit is gone.
  flight.update(1 / 60)
  overview.update(1 / 60)
  out.steadyAfterExit = camera.position.distanceTo(handoffPosition) < 1e-6

  // The real test of a clean handoff: PointerLockControls rebuilds the camera
  // orientation from a YXZ euler on every mouse move, which silently discards
  // any roll the orbit left behind. A zero-delta move must therefore be a
  // no-op — if it is not, the first twitch of the mouse snaps the view.
  controls.isLocked = true
  document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 0 }))
  out.idleMoveSnap = Number(handoffQuaternion.angleTo(camera.quaternion).toFixed(6))

  const beforeLook = camera.quaternion.clone()
  document.dispatchEvent(new MouseEvent('mousemove', { movementX: 100, movementY: 0 }))
  out.lookAngle = Number(beforeLook.angleTo(camera.quaternion).toFixed(4)) // 100 * 0.002 rad
  controls.isLocked = false

  // ---- straight overhead: the degenerate lookAt --------------------------
  place(cx, cy + 2000, cz + 0.001, cx, cy, cz)
  overview.toggle(); arrive()
  out.overheadPolar = Number(
    new THREE.Spherical().setFromVector3(camera.position.clone().sub(overview.target)).phi.toFixed(4)
  )
  out.overheadAim = Number(aimError().toFixed(5))
  out.overheadRoll = Number(rollOf().toFixed(6))
  const overheadFrame = framing()
  out.overheadInside = overheadFrame.inside
  const overheadQuaternion = camera.quaternion.clone()
  overview.toggle()
  controls.isLocked = true
  document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 0 }))
  out.overheadSnap = Number(overheadQuaternion.angleTo(camera.quaternion).toFixed(6))
  controls.isLocked = false

  // ---- Tab pressed mid-drag ---------------------------------------------
  place(0, 0, 900)
  overview.toggle(); arrive()
  canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, pointerType: 'mouse', button: 0, buttons: 1, clientX: 400, clientY: 300, bubbles: true, cancelable: true }))
  overview.toggle() // out, with the pointer still down
  overview.toggle(); arrive() // and back in
  const beforeRedrag = camera.position.clone()
  const distanceRedrag = overview.distance
  drag(160, 0)
  frames(90)
  out.redragRotated = camera.position.distanceTo(beforeRedrag) > 10
  out.redragKeptDistance = Math.abs(overview.distance - distanceRedrag) < distanceRedrag * 0.02
  overview.toggle()

  // ---- repeated toggling -------------------------------------------------
  let togglesClean = true
  for (let i = 0; i < 6; i++) {
    overview.toggle(); frames(10); arrive()
    if (!overview.isOrbiting || framing().inside !== graph.nodes.size) togglesClean = false
    overview.toggle()
    if (overview.isActive) togglesClean = false
  }
  out.togglesClean = togglesClean

  // ---- everything else still works from the orbit camera ------------------
  overview.toggle(); arrive()
  // The core node: its label is the one that carries at a fitted distance.
  graph.getNode(ids[0]).label = 'Overview label'
  // A label's alpha eases, and the first update has no dt to ease across.
  view.update(2, camera)
  view.update(2.4, camera)
  view.update(2.8, camera)
  out.labelsDrawn = view.labelsShown().length
  renderer.info.reset()
  bloom.render()
  out.renderCalls = renderer.info.render.calls
  out.cameraLayersRestored = camera.layers.mask === new THREE.Layers().mask
  out.starLayerIntact = scene.getObjectByName('nodes').layers.mask === (1 << STAR_LAYER)

  // Balance from the overview: the layout settles and the frame keeps up.
  physics.start()
  let guard = 0
  while (physics.isRunning && guard++ < 4000) { physics.update(); overview.update(1 / 60) }
  out.balanceFinished = !physics.isRunning
  out.balanceAim = Number(aimError().toFixed(5))
  overview.toggle()

  // ---- a file opened while the overview is up -----------------------------
  overview.toggle(); arrive()
  const farTarget = overview.target.clone()
  graph.load({
    nodes: [0, 1, 2, 3].map((i) => ({ id: `n${i + 1}`, label: '', notes: '', links: [], x: -3000 + i * 60, y: 1500, z: 800, cluster_color_id: 0, is_core: false })),
    edges: [],
  })
  physics.reset()
  view.sync()
  overview.refit()
  out.refitEntering = !overview.isOrbiting && overview.isActive
  arrive()
  out.refitMoved = overview.target.distanceTo(farTarget) > 1000
  out.refitInside = framing().inside
  out.refitTotal = graph.nodes.size
  overview.toggle()

  // ---- a single node, and none at all -------------------------------------
  graph.load({ nodes: [{ id: 'n1', label: '', notes: '', links: [], x: 0, y: 0, z: 0, cluster_color_id: 0, is_core: false }], edges: [] })
  view.sync()
  place(0, 0, 300)
  overview.toggle(); arrive()
  out.oneDistance = Number(overview.distance.toFixed(1))
  out.oneRadius = Number(view.radiusOf('n1').toFixed(2))
  out.oneInside = framing().inside
  overview.toggle()

  graph.load({ nodes: [], edges: [] })
  view.sync()
  place(0, 0, 260)
  const emptyPosition = camera.position.clone()
  overview.toggle(); arrive()
  out.emptyStayed = camera.position.distanceTo(emptyPosition) < 1e-6
  out.emptyTarget = Number(overview.distance.toFixed(1))
  drag(120, 0)
  frames(90)
  out.emptyOrbits = camera.position.distanceTo(emptyPosition) > 10
  overview.toggle()

  overview.dispose()
  out.disposedInactive = !overview.isActive
  return out
}).catch((e) => ({ threw: e.message }))

if (r.threw) {
  console.log(`  FAIL  page threw: ${r.threw}`)
  fails++
} else {
  console.log('\nentering')
  check('inactive before Tab', r.beforeActive === false)
  check('active the moment Tab is pressed', r.activeImmediately === true)
  check('the orbit does not have the camera yet', r.orbitingImmediately === false)
  check('pointer lock released on the way in', r.unlockCalls === 1 && r.lockedAfterEnter === false, `${r.unlockCalls} ${r.lockedAfterEnter}`)
  check('one frame moves the camera partway, not all the way', r.movedPartway && r.notSnapped)
  check('still transitioning after one frame', r.stillEntering === true)
  check('the orbit takes over on arrival', r.orbitingAfterArrival === true)

  console.log('\nzoom-to-fit')
  check('every node is in frame', r.fitInside === r.fitTotal, `${r.fitInside}/${r.fitTotal}`)
  check('the map carries the frame rather than floating in it', r.fitWorst > 0.6 && r.fitWorst <= 1, `worst ${r.fitWorst}`)
  check('the silhouette fit beats a bounding-sphere one', r.fitDistance < r.sphereFit * 0.8, `${r.fitDistance} vs sphere ${r.sphereFit}`)
  check('the camera looks straight at the target', r.fitAim < 1e-4, `${r.fitAim} rad`)
  check('the target is the map, not the origin', r.targetOffCentroid < 120, `${r.targetOffCentroid} off centroid`)
  check('the map stays on the side it was on', r.sameSide === true)
  check('no roll in the fitted view', r.fitRoll < 1e-4, `${r.fitRoll}`)

  console.log('\norbiting')
  check('a left drag turns the map', r.dragMoved === true)
  check('and keeps its distance', r.dragKeptDistance === true)
  check('still aimed at the target after a drag', r.dragAim < 1e-4, `${r.dragAim} rad`)
  check('still no roll after a drag', r.dragRoll < 1e-4, `${r.dragRoll}`)
  check('the wheel dollies in', r.zoomedIn === true)
  check('and back out again', r.zoomedBack === true)
  check('dolly stops at the min distance', r.minDistance >= 19.9 && r.minDistance < 30, `${r.minDistance}`)
  check('and at the max distance', r.maxDistance >= 2000, `${r.maxDistance}`)

  console.log('\nhandoff back to flight')
  check('inactive after the second Tab', r.inactiveAfterExit === true)
  check('pointer lock asked for again', r.lockCalls === 1 && r.lockedAfterExit === true, `${r.lockCalls} ${r.lockedAfterExit}`)
  check('the camera stays where the orbit left it', r.steadyAfterExit === true)
  check('the first mouse move does not snap the view', r.idleMoveSnap < 1e-4, `${r.idleMoveSnap} rad`)
  check('and then looks at the usual sensitivity', Math.abs(r.lookAngle - 0.2) < 0.005, `${r.lookAngle} rad`)

  console.log('\nstraight overhead (the degenerate lookAt)')
  check('the orbit is held off the pole', r.overheadPolar > 0.1 && r.overheadPolar < Math.PI - 0.1, `phi ${r.overheadPolar}`)
  check('still aimed at the target', r.overheadAim < 1e-4, `${r.overheadAim} rad`)
  check('no roll overhead', r.overheadRoll < 1e-4, `${r.overheadRoll}`)
  check('the whole map is still framed', r.overheadInside === r.fitTotal, `${r.overheadInside}/${r.fitTotal}`)
  check('and the handoff out of it is clean', r.overheadSnap < 1e-4, `${r.overheadSnap} rad`)

  console.log('\nstate between activations')
  check('Tab mid-drag leaves no pointer behind: a fresh drag rotates', r.redragRotated === true)
  check('and does not dolly', r.redragKeptDistance === true)
  check('six toggles in a row all fit and all leave cleanly', r.togglesClean === true)

  console.log('\nthe rest of the app, from the orbit camera')
  check('labels are laid out for it', r.labelsDrawn > 0, `${r.labelsDrawn}`)
  check('the bloom pipeline draws the frame', r.renderCalls > 0, `${r.renderCalls} calls`)
  check('camera layers restored after the frame', r.cameraLayersRestored === true)
  check('the stars are still on their own layer', r.starLayerIntact === true)
  check('Balance runs to a finish from the overview', r.balanceFinished === true)
  check('and the view is still aimed at the target after it', r.balanceAim < 1e-4, `${r.balanceAim} rad`)

  console.log('\nre-framing')
  check('opening a file re-enters the transition', r.refitEntering === true)
  check('and the target follows the new map', r.refitMoved === true)
  check('every node of it in frame', r.refitInside === r.refitTotal, `${r.refitInside}/${r.refitTotal}`)

  console.log('\nsmall and empty maps')
  check('one node is framed well clear of its own fade-out', r.oneDistance > r.oneRadius * 2.5, `${r.oneDistance} vs ${r.oneRadius}`)
  check('and is on screen', r.oneInside === 1)
  check('an empty map does not move the camera', r.emptyStayed === true)
  check('but still has something to orbit', r.emptyTarget > 100, `${r.emptyTarget}`)
  check('and orbits it', r.emptyOrbits === true)
  check('dispose leaves it inactive', r.disposedInactive === true)
}

check('no console errors or warnings', errors.length === 0, JSON.stringify(errors))
console.log(`\n${ok} passed, ${fails} failed`)
await browser.close()
process.exit(fails ? 1 : 0)
