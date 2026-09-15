/**
 * Session 5 against the real GraphView and physics: a core flag grows the node
 * and its neighbourhood in the instance matrices, on screen, in picking, in the
 * halos and in the layout; sizes ease on an edit and snap on a load.
 */
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'

const BASE = process.env.BASE ?? 'http://localhost:5180'
const SHOTS = process.env.SHOTS ?? '/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/6b83a512-7a96-4a39-9c2f-05089b6d3102/scratchpad'
let ok = 0, fails = 0
const check = (name, cond, extra = '') =>
  cond ? (ok++, console.log(`  pass  ${name}`)) : (fails++, console.log(`  FAIL  ${name} ${extra}`))

const browser = await chromium.launch({
  executablePath: '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('ReadPixels')) errors.push(`${m.type()}: ${m.text()}`) })
await page.goto(`${BASE}/`)
await page.waitForTimeout(1500)

const out = await page.evaluate(async () => {
  const transformed = await (await fetch('/src/graphView.js')).text()
  const threeUrl = transformed.match(/["']([^"']*deps\/three\.js[^"']*)["']/)[1]
  const THREE = await import(threeUrl)
  const { createGraph } = await import('/src/graph.js')
  const { createGraphView, NODE_RADIUS } = await import('/src/graphView.js')
  const { createPhysics } = await import('/src/physics.js')
  const { createFiles } = await import('/src/files.js')
  const { CORE_SIZE, coreSize, degreeSize } = await import('/src/sizing.js')

  const W = 800, H = 500
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  document.body.append(canvas)
  const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true })
  renderer.setSize(W, H, false)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x05060a)
  const camera = new THREE.PerspectiveCamera(70, W / H, 0.5, 20000)
  camera.layers.enable(1) // session 6: the star mesh is on layer 1 only
  scene.add(camera)
  const target = new THREE.WebGLRenderTarget(W, H)
  const raycaster = new THREE.Raycaster()

  const graph = createGraph()
  const view = createGraphView(graph, scene, renderer)
  const physics = createPhysics(graph, view)
  const files = createFiles({ graph, view, camera, physics })
  const root = scene.getObjectByName('graph')
  const r = {}

  const mesh = () => root.children.find((c) => c.isInstancedMesh)
  const look = (x, y, z, dist = 300) => {
    camera.position.set(x, y, z + dist)
    camera.rotation.set(0, 0, 0)
    camera.updateMatrixWorld(true)
  }
  const ndcOf = (x, y, z) => new THREE.Vector3(x, y, z).project(camera)
  const pickAt = (x, y, z) => {
    const ndc = ndcOf(x, y, z)
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera)
    return view.raycast(raycaster)
  }
  const pixelAtPoint = (x, y, z) => {
    const ndc = ndcOf(x, y, z)
    const px = Math.round((ndc.x * 0.5 + 0.5) * W)
    const py = Math.round((ndc.y * 0.5 + 0.5) * H)
    const buf = new Uint8Array(4)
    renderer.readRenderTargetPixels(target, px, py, 1, 1, buf)
    return Math.max(buf[0], buf[1], buf[2])
  }
  const render = (toScreen = false) => {
    renderer.setRenderTarget(toScreen ? null : target)
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)
  }
  // Drawn radius of a node straight out of its instance matrix.
  const drawnRadius = (id) => {
    const m = mesh()
    const node = graph.getNode(id)
    const mat = new THREE.Matrix4(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    for (let i = 0; i < m.count; i++) {
      m.getMatrixAt(i, mat)
      mat.decompose(pos, q, s)
      if (pos.distanceTo(new THREE.Vector3(node.x, node.y, node.z)) < 1e-3) return s.x
    }
    return null
  }
  // Rendered footprint: how far out from each star's centre stays lit.
  // Averaged round a ring so single rays don't decide it; the pulse phase
  // still shifts it a little, so compare at one instant.
  const footprint = (node) => {
    let reach = 0
    for (let d = 0; d < SPACING / 2; d += 0.5) {
      let sum = 0
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * Math.PI * 2
        sum += pixelAtPoint(node.x + d * Math.cos(a), node.y + d * Math.sin(a), 0)
      }
      if (sum / 48 > 110) reach = d
    }
    return reach
  }
  let clock = 10
  const frame = (dt = 1 / 60) => { clock += dt; view.update(clock) }
  const settleSizes = () => { for (let i = 0; i < 120; i++) frame() }

  // --- Chain of 11 along x, core in the middle ------------------------------
  const SPACING = 70
  const chain = []
  for (let i = 0; i < 11; i++) chain.push(graph.addNode({ x: (i - 5) * SPACING, y: 0, z: 0 }).id)
  for (let i = 1; i < 11; i++) graph.addEdge(chain[i - 1], chain[i])
  view.sync()
  frame(); frame()
  const mid = chain[5]
  r.beforeRadii = chain.map((id) => drawnRadius(id))
  r.beforeMatchesDegree = chain.every((id, i) => Math.abs(drawnRadius(id) - NODE_RADIUS * degreeSize(i === 0 || i === 10 ? 1 : 2)) < 1e-4)

  look(0, 0, 0, 380)
  frame()
  // Every render that gets compared happens at this one pulse instant: each
  // star's glow swells ~35% with its own pulse, which would swamp the hops.
  const T0 = clock
  render(true)
  r.shotBefore = canvas.toDataURL('image/png')
  render()
  // Square to the chain, so clear of the edges' pick padding; inside a core
  // star's radius (15), outside a plain one's (~6).
  const probe = NODE_RADIUS * 2.6
  r.brightBefore = pixelAtPoint(0, probe * 0.8, 0)
  r.pickBefore = pickAt(0, probe, 0)?.id ?? null
  r.footprintsBefore = chain.map((id) => footprint(graph.getNode(id)))

  graph.setCore(mid, true)
  // Easing: the first frame after the flag moves only part of the way.
  frame()
  r.afterOneFrame = drawnRadius(mid) / NODE_RADIUS
  frame(); frame(); frame(); frame()
  r.afterFiveFrames = drawnRadius(mid) / NODE_RADIUS
  settleSizes()
  r.afterRadii = chain.map((id) => drawnRadius(id))
  r.afterMatchesTarget = chain.every((id) => Math.abs(drawnRadius(id) - NODE_RADIUS * graph.sizeOf(id)) < 1e-4)
  r.coreDrawn = drawnRadius(mid) / NODE_RADIUS
  r.hopSizes = [0, 1, 2, 3, 4, 5].map((h) => drawnRadius(chain[5 + h]) / NODE_RADIUS)
  r.symmetric = [1, 2, 3, 4, 5].every((h) => Math.abs(drawnRadius(chain[5 + h]) - drawnRadius(chain[5 - h])) < 1e-4)
  // Every node here has 2 links except the ends, which are at hop 5.
  r.expectedHop = [0, 1, 2, 3, 4, 5].map((h) => Math.max(degreeSize(2), h === 0 ? 0 : coreSize(h)))
  r.expectedHop[0] = coreSize(0)
  r.expectedHop[5] = degreeSize(1)

  view.update(T0) // sizes are settled; this only rewinds the pulse clock
  render(true)
  r.shotAfter = canvas.toDataURL('image/png')
  render()
  r.brightAfter = pixelAtPoint(0, probe * 0.8, 0)
  r.pickAfter = pickAt(0, probe, 0)?.id ?? null
  r.midId = mid
  r.footprints = chain.map((id) => footprint(graph.getNode(id)))
  r.growth = r.footprints.map((f, i) => f / r.footprintsBefore[i])

  // --- Halos follow size ----------------------------------------------------
  view.setHover({ kind: 'node', id: mid })
  const halo = root.children.filter((c) => c.isSprite && c.visible)[0]
  r.haloScaleCore = halo?.scale.x
  view.setHover({ kind: 'node', id: chain[10] })
  r.haloScaleLeaf = root.children.filter((c) => c.isSprite && c.visible)[0]?.scale.x
  view.setHover(null)

  // --- Pick bias scales with radius: an edge through a core's front half --
  // Camera straight down the chain axis: every edge points at the camera and
  // runs through the core's sphere; the core must still win.
  camera.position.set(0, 0, 0)
  camera.position.set(-5 * SPACING - 200, 0, 0)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera)
  r.endOnPick = view.raycast(raycaster)?.id ?? null

  // --- Unmark: eases back down --------------------------------------------
  look(0, 0, 0, 380)
  graph.setCore(mid, false)
  settleSizes()
  r.unmarkedRadii = chain.map((id) => drawnRadius(id))
  r.unmarkRestores = r.unmarkedRadii.every((v, i) => Math.abs(v - r.beforeRadii[i]) < 1e-4)

  // --- Deleting a neighbour shrinks the survivors (easing, no sync call) --
  graph.setCore(mid, true)
  settleSizes()
  const beforeCut = drawnRadius(chain[7])
  graph.removeNode(chain[6])
  view.syncNodes(); view.syncEdges()
  settleSizes()
  r.cutShrinks = drawnRadius(chain[7]) < beforeCut && Math.abs(drawnRadius(chain[7]) - NODE_RADIUS * degreeSize(1)) < 1e-4
  // Only an edge change, no view call at all: update() alone must retarget.
  graph.addEdge(chain[5], chain[7])
  settleSizes()
  r.edgeOnlyRetargets = Math.abs(drawnRadius(chain[7]) - NODE_RADIUS * coreSize(1)) < 1e-4

  // --- Snap on load: a reused id does not ease from the old map's size ----
  const hubPayload = {
    nodes: [
      { id: chain[5], x: 0, y: 0, z: 0, is_core: false },
      { id: 'n999', x: 60, y: 0, z: 0, is_core: false },
    ],
    edges: [],
  }
  files.applyPayload(hubPayload)
  r.loadSnaps = drawnRadius(chain[5]) === NODE_RADIUS
  frame()
  r.loadStaysSnapped = drawnRadius(chain[5]) === NODE_RADIUS

  // --- Round trip keeps core and its sizes --------------------------------
  graph.load({ nodes: [], edges: [] })
  view.sync()
  const tri = []
  for (let i = 0; i < 6; i++) tri.push(graph.addNode({ x: i * 60, y: 0, z: 0 }).id)
  for (let i = 1; i < 6; i++) graph.addEdge(tri[i - 1], tri[i])
  graph.setCore(tri[0], true)
  view.syncNodes()
  settleSizes()
  const saved = JSON.parse(JSON.stringify(files.toPayload()))
  const radiiSaved = tri.map((id) => drawnRadius(id))
  graph.load({ nodes: [], edges: [] })
  view.sync()
  files.applyPayload(saved)
  r.roundTripRadii = tri.map((id) => drawnRadius(id)).every((v, i) => Math.abs(v - radiiSaved[i]) < 1e-4)
  r.roundTripCore = graph.getNode(tri[0]).is_core === true

  // --- Layout: a core hub spaces its neighbours out -----------------------
  const settle = () => {
    physics.start()
    let guard = 0
    while (physics.isRunning && guard++ < 5000) physics.update()
    return guard
  }
  const star = (core) => {
    graph.load({ nodes: [], edges: [] })
    view.sync()
    physics.reset()
    const hub = graph.addNode({ x: 0, y: 0, z: 0 }).id
    const leaves = []
    let seed = 1
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 40
    for (let i = 0; i < 10; i++) {
      const id = graph.addNode({ x: rnd(), y: rnd(), z: rnd() }).id
      leaves.push(id)
      graph.addEdge(hub, id)
    }
    if (core) graph.setCore(hub, true)
    view.syncNodes()
    view.syncEdges()
    settleSizes()
    settle()
    const h = graph.getNode(hub)
    const dists = leaves.map((id) => { const n = graph.getNode(id); return Math.hypot(n.x - h.x, n.y - h.y, n.z - h.z) })
    let minLeafGap = Infinity
    for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
      const a = graph.getNode(leaves[i]), b = graph.getNode(leaves[j])
      minLeafGap = Math.min(minLeafGap, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - view.radiusOf(leaves[i]) - view.radiusOf(leaves[j]))
    }
    const minSurfaceGap = Math.min(...leaves.map((id, i) => dists[i] - view.radiusOf(hub) - view.radiusOf(id)))
    const finite = [...graph.nodes.values()].every((n) => Number.isFinite(n.x + n.y + n.z))
    return { meanDist: dists.reduce((a, b) => a + b, 0) / dists.length, minDist: Math.min(...dists), minSurfaceGap, minLeafGap, finite, hubR: view.radiusOf(hub), leafR: view.radiusOf(leaves[0]) }
  }
  r.plainStar = star(false)
  r.coreStar = star(true)

  // Toggling core mid-run is picked up (invalidate reseeds collide radii).
  graph.load({ nodes: [], edges: [] })
  view.sync()
  physics.reset()
  const pair = [graph.addNode({ x: 0, y: 0, z: 0 }).id, graph.addNode({ x: 30, y: 0, z: 0 }).id]
  graph.addEdge(pair[0], pair[1])
  view.syncNodes(); view.syncEdges()
  physics.start()
  for (let i = 0; i < 20; i++) physics.update()
  graph.setCore(pair[0], true)
  physics.invalidate()
  let guard = 0
  while (physics.isRunning && guard++ < 5000) physics.update()
  const [a, b] = pair.map((id) => graph.getNode(id))
  r.pairDist = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

  // --- Cost ----------------------------------------------------------------
  graph.load({ nodes: [], edges: [] })
  view.sync()
  physics.reset()
  const ids = []
  for (let i = 0; i < 3000; i++) ids.push(graph.addNode({ x: (i % 60) * 12, y: Math.floor(i / 60) * 12, z: 0 }).id)
  for (let i = 1; i < 3000; i++) graph.addEdge(ids[i], ids[Math.floor(i / 2)])
  view.sync()
  for (let i = 0; i < 30; i++) graph.setCore(ids[i * 97], true)
  let t0 = performance.now()
  graph.sizeOf(ids[0])
  r.bfs3000 = performance.now() - t0
  t0 = performance.now()
  for (let i = 0; i < 30; i++) frame()
  r.easeFrame3000 = (performance.now() - t0) / 30
  settleSizes()
  t0 = performance.now()
  for (let i = 0; i < 30; i++) frame()
  r.idleFrame3000 = (performance.now() - t0) / 30
  r.calls = (() => { look(360, 300, 0, 900); renderer.info.reset(); render(); return renderer.info.render.calls })()
  r.coreSize = CORE_SIZE
  return r
})

const fs = await import('node:fs')
for (const k of ['shotBefore', 'shotAfter']) {
  fs.writeFileSync(`${SHOTS}/${k}.png`, Buffer.from(out[k].split(',')[1], 'base64'))
  delete out[k]
}
console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)))

const R = 5
check('before: radii are degree sizes', out.beforeMatchesDegree)
check('core eases, does not snap (1 frame partial)', out.afterOneFrame > 1.3 && out.afterOneFrame < 2.9, out.afterOneFrame)
check('core eases (5 frames further along)', out.afterFiveFrames > out.afterOneFrame && out.afterFiveFrames < 3)
check('settled radii match graph.sizeOf', out.afterMatchesTarget)
check('core drawn at CORE_SIZE', Math.abs(out.coreDrawn - out.coreSize) < 1e-4)
check('hops 0-5 match max(degree, decay)', out.hopSizes.every((v, h) => Math.abs(v - out.expectedHop[h]) < 1e-4), JSON.stringify(out.expectedHop))
check('hop 4 still above a plain 2-link node', out.hopSizes[4] > out.beforeRadii[4] / R + 0.03, `${out.hopSizes[4]} vs ${out.beforeRadii[4] / R}`)
check('fades monotonically over hops', out.hopSizes.every((v, i, a) => i === 0 || v < a[i - 1]))
check('symmetric on both sides', out.symmetric)
check('neighbour grew visibly (>1.5x)', out.afterRadii[4] / out.beforeRadii[4] > 1.5)
check('hop-5 node untouched', out.afterRadii[0] === out.beforeRadii[0] && out.afterRadii[10] === out.beforeRadii[10])
check('on screen: core region lit after, not before', out.brightAfter > out.brightBefore + 60, `${out.brightBefore} -> ${out.brightAfter}`)
const g = out.growth
check('on screen: each star\'s lit footprint grows, fading over hops', g[5] > g[4] && g[4] > g[3] && g[3] > g[2] && g[6] > g[7] && g[7] > g[8] && g[2] > 1.05 && g[8] > 1.05, JSON.stringify(g))
check('on screen: core footprint ~2x its old one', g[5] > 1.9, g[5])
check('on screen: hop-5 ends unchanged', g[0] === 1 && g[10] === 1, `${g[0]} ${g[10]}`)
check('pick radius grows: miss before, hit after', out.pickBefore === null && out.pickAfter === out.midId, `${out.pickBefore} / ${out.pickAfter}`)
check('halo scales with node', Math.abs(out.haloScaleCore / out.haloScaleLeaf - 3 / (out.beforeRadii[10] / R)) < 1e-4)
check('looking down the chain, the end node beats the edges', out.endOnPick !== null && !String(out.endOnPick).startsWith('e'), out.endOnPick)
check('unmark restores sizes', out.unmarkRestores)
check('delete shrinks the cut-off neighbour', out.cutShrinks)
check('edge-only edit resizes with no view call', out.edgeOnlyRetargets)
check('load snaps a reused id to its new size', out.loadSnaps && out.loadStaysSnapped)
check('round trip keeps core and sizes', out.roundTripCore && out.roundTripRadii)
check('layout finite', out.plainStar.finite && out.coreStar.finite)
check('core hub pushes neighbours further out', out.coreStar.meanDist > out.plainStar.meanDist + 20, `${out.plainStar.meanDist} -> ${out.coreStar.meanDist}`)
check('core hub surfaces keep a gap to neighbours', out.coreStar.minSurfaceGap > 20, out.coreStar.minSurfaceGap)
check('big neighbours do not overlap each other', out.coreStar.minLeafGap > 0, out.coreStar.minLeafGap)
// Link rest length: 60 + 13*(core - 1) + 13*(hop1 - 1).
const pairRest = 60 + 2.6 * R * (out.coreSize - 1) + 2.6 * R * (out.expectedHop[1] - 1)
check('core toggled mid-run is picked up by physics', Math.abs(out.pairDist - pairRest) < 4, `${out.pairDist} want ~${pairRest}`)
check('3000 nodes: BFS under 5 ms', out.bfs3000 < 5, out.bfs3000)
check('3000 nodes: easing frame under 2 ms', out.easeFrame3000 < 2, out.easeFrame3000)
check('3000 nodes: idle frame ~free', out.idleFrame3000 < 0.2, out.idleFrame3000)
check('still one draw call for nodes (+1 edges, +1 drift)', out.calls === 3, out.calls)
check('no console errors or warnings', errors.length === 0, JSON.stringify(errors))

console.log(`\n${ok} passed, ${fails} failed`)
await browser.close()
process.exit(fails ? 1 : 0)
