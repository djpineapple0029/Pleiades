/**
 * The load path against the real GraphView and the real physics: a map that
 * comes back off disk has to render, raycast, and balance like one that was
 * built by hand.
 */
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'

let ok = 0, fails = 0
const check = (name, cond, extra = '') =>
  cond ? (ok++, console.log(`  pass  ${name}`)) : (fails++, console.log(`  FAIL  ${name} ${extra}`))

const browser = await chromium.launch({
  executablePath: '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('  page error:', e.message))
await page.goto('http://localhost:5180/')

const out = await page.evaluate(async () => {
  // page.evaluate is not run through Vite, so a bare 'three' will not resolve.
  // Lift the rewritten specifier out of a module Vite did transform.
  const transformed = await (await fetch('/src/graphView.js')).text()
  const threeUrl = transformed.match(/["']([^"']*deps\/three\.js[^"']*)["']/)[1]
  const THREE = await import(threeUrl)
  const { createGraph } = await import('/src/graph.js')
  const { createGraphView, NODE_RADIUS } = await import('/src/graphView.js')
  const { createPhysics } = await import('/src/physics.js')
  const { createFiles } = await import('/src/files.js')

  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  document.body.append(canvas)
  const renderer = new THREE.WebGLRenderer({ canvas })
  renderer.setSize(1280, 720, false)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, 1280 / 720, 0.5, 20000)
  camera.layers.enable(1) // session 6: the star mesh is on layer 1 only
  scene.add(camera)

  const graph = createGraph()
  const view = createGraphView(graph, scene, renderer)
  const physics = createPhysics(graph, view)
  const files = createFiles({ graph, view, camera, physics })
  const r = {}

  // A map with a shape worth balancing, saved and reopened for real.
  const ids = []
  for (let i = 0; i < 40; i++) ids.push(graph.addNode({ x: (i % 8) * 40 - 140, y: Math.floor(i / 8) * 40 - 80, z: 0 }).id)
  for (let i = 1; i < 40; i++) graph.addEdge(ids[i], ids[Math.floor(i / 3)])
  view.sync()
  files.setCredentials('pw', 'render test')
  const payload = JSON.parse(JSON.stringify(files.toPayload()))

  // Balance is mid-flight when the new file lands — the worst moment for it.
  physics.start()
  for (let i = 0; i < 5; i++) physics.update()
  r.wasRunning = physics.isRunning

  const res = await fetch('/api/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'pw', payload }),
  })
  const blob = await res.blob()

  // A different, smaller map to land on top of it, reusing the same ids.
  const other = createGraph()
  const oa = other.addNode({ x: -60, y: 0, z: 0, label: 'left' })
  const ob = other.addNode({ x: 60, y: 0, z: 0, label: 'right' })
  other.addEdge(oa.id, ob.id)
  const otherRes = await fetch('/api/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'pw', payload: { ...other.toPayload(), camera: { position: [0, 0, 200], rotation: [0, 0, 0] } } }),
  })
  const openResult = await files.open(new File([await otherRes.blob()], 'other.atlasmap'), 'pw')
  r.openResult = openResult
  r.balanceStopped = physics.isRunning === false
  r.nodeCount = graph.nodes.size
  r.edgeCount = graph.edges.size

  renderer.render(scene, camera)
  r.rendered = true

  // The loaded nodes and the loaded edge must both be pickable. Camera looks
  // down -Z from +Z, so the crosshair sits on the edge's midpoint at (0,0,0).
  camera.position.set(0, 0, 300)
  camera.rotation.set(0, 0, 0)
  camera.updateMatrixWorld(true)
  renderer.render(scene, camera)
  const raycaster = new THREE.Raycaster()

  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera)
  r.midpointHit = view.raycast(raycaster)

  // And straight at a node: project its world position back to NDC.
  const target = graph.getNode(oa.id)
  const ndc = new THREE.Vector3(target.x, target.y, target.z).project(camera)
  raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera)
  r.nodeHit = view.raycast(raycaster)
  r.nodeHitIsLeft = r.nodeHit?.id === oa.id

  // Balancing a freshly loaded graph exercises the seed ordering: the previous
  // run's links still pointed at bodies that no longer exist.
  const before = { x: graph.getNode(oa.id).x, y: graph.getNode(oa.id).y, z: graph.getNode(oa.id).z }
  r.restarted = physics.start()
  for (let i = 0; i < 60; i++) physics.update()
  const after = graph.getNode(oa.id)
  r.moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) > 0.5
  r.finite = [after.x, after.y, after.z].every(Number.isFinite)

  // Edges must still be pickable after physics has moved everything.
  camera.position.set(
    (graph.getNode(oa.id).x + graph.getNode(ob.id).x) / 2,
    (graph.getNode(oa.id).y + graph.getNode(ob.id).y) / 2,
    (graph.getNode(oa.id).z + graph.getNode(ob.id).z) / 2 + 300,
  )
  camera.rotation.set(0, 0, 0)
  camera.updateMatrixWorld(true)
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera)
  r.midpointHitAfterSettle = view.raycast(raycaster)

  // Finally, the original 40-node file back over the top of the small one.
  const back = await files.open(new File([blob], 'render test.atlasmap'), 'pw')
  r.backResult = back
  r.backNodeCount = graph.nodes.size
  r.backEdgeCount = graph.edges.size
  r.backRestart = physics.start()
  for (let i = 0; i < 20; i++) physics.update()
  r.backFinite = [...graph.nodes.values()].every((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z))
  r.nodeRadius = NODE_RADIUS
  return r
})

check('WebGL renderer came up and drew', out.rendered === true)
check('balance was running when the file landed', out.wasRunning === true)
check('open succeeded', out.openResult?.ok === true, JSON.stringify(out.openResult))
check('loading stopped the balance run', out.balanceStopped === true)
check('graph replaced by the loaded one', out.nodeCount === 2 && out.edgeCount === 1, `${out.nodeCount}/${out.edgeCount}`)
check('loaded edge is pickable at its midpoint', out.midpointHit?.kind === 'edge', JSON.stringify(out.midpointHit))
check('loaded node is pickable', out.nodeHit?.kind === 'node' && out.nodeHitIsLeft, JSON.stringify(out.nodeHit))
check('a loaded graph can be balanced', out.restarted === true)
check('balancing moves loaded nodes', out.moved === true)
check('positions stay finite', out.finite === true)
check('edges still pickable after a settle', out.midpointHitAfterSettle?.kind === 'edge', JSON.stringify(out.midpointHitAfterSettle))
check('second load succeeded', out.backResult?.ok === true, JSON.stringify(out.backResult))
check('40-node map restored over the small one', out.backNodeCount === 40 && out.backEdgeCount === 39, `${out.backNodeCount}/${out.backEdgeCount}`)
check('and balances without NaN', out.backRestart === true && out.backFinite === true)

await browser.close()
console.log(`\n${ok} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
