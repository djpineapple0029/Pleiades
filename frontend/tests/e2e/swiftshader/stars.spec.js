// Ported from tests/_rescued/e2e/e2e_stars.mjs.
//
// Star-node checks against the real GraphView: one draw call for all nodes,
// independent pulses, a seamless clock wrap (now covering the ray shimmer
// too), picking on the node radius rather than the billboard, and
// everything session 4 already guaranteed — deletes, growth, physics, a
// file load, halos.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, threeModuleUrl } from '../helpers/gestures.js'

test('star nodes: draw calls, pulses, picking, growth, halos', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  const threeUrl = await threeModuleUrl(page)

  const out = await page.evaluate(async (threeUrl) => {
    const THREE = await import(threeUrl)
    const { createGraph } = await import('/src/graph.js')
    const { createGraphView, NODE_RADIUS } = await import('/src/graphView.js')
    const { createPhysics } = await import('/src/physics.js')
    const { createFiles } = await import('/src/files.js')

    const W = 640, H = 480
    const canvas = document.createElement('canvas')
    canvas.width = W; canvas.height = H
    document.body.append(canvas)
    const renderer = new THREE.WebGLRenderer({ canvas })
    renderer.setSize(W, H, false)
    const scene = new THREE.Scene()
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
    const pick = (node) => pickAt(node.x, node.y, node.z)
    const pixelAtPoint = (x, y, z) => {
      const ndc = ndcOf(x, y, z)
      const px = Math.round((ndc.x * 0.5 + 0.5) * W)
      const py = Math.round((ndc.y * 0.5 + 0.5) * H) // render targets are bottom-up
      const buf = new Uint8Array(4)
      renderer.readRenderTargetPixels(target, px, py, 1, 1, buf)
      return [...buf.slice(0, 3)]
    }
    const pixelAt = (node, dx = 0) => pixelAtPoint(node.x + dx, node.y, node.z)
    const frame = () => {
      const buf = new Uint8Array(W * H * 4)
      renderer.readRenderTargetPixels(target, 0, 0, W, H, buf)
      return buf
    }
    const frameDiff = (a, b) => {
      let worst = 0
      for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) worst = Math.max(worst, Math.abs(a[i] - b[i]))
      return worst
    }
    const renderAt = (seconds) => {
      view.update(seconds)
      renderer.setRenderTarget(target)
      renderer.render(scene, camera)
      renderer.setRenderTarget(null)
    }
    const instanced = () => root.children.filter((c) => c.isInstancedMesh)
    const plainNodeMeshes = () => root.children.filter((c) => c.isMesh && !c.isInstancedMesh && !c.isLineSegments2 && c.visible)

    // --- 500 nodes, 499 edges: how many draw calls? ------------------------
    const ids = []
    for (let i = 0; i < 500; i++) {
      ids.push(graph.addNode({ x: (i % 25) * 16 - 200, y: Math.floor(i / 25) * 16 - 160, z: 0 }).id)
    }
    for (let i = 1; i < 500; i++) graph.addEdge(ids[i], ids[i - 1])
    view.sync()
    look(0, 0, 0, 420)
    renderer.info.autoReset = true
    renderAt(1)
    r.calls500 = renderer.info.render.calls
    r.instancedCount = instanced().length
    r.instanceCount = instanced()[0]?.count
    r.plainMeshes = plainNodeMeshes().length

    // --- Pulse and shimmer ---------------------------------------------------
    const mesh = instanced()[0]
    const stars = mesh.geometry.getAttribute('instanceStar')
    const tints = mesh.geometry.getAttribute('instanceTint')

    graph.load({ nodes: [], edges: [] })
    view.sync()
    const patch = []
    for (let i = 0; i < 25; i++) patch.push(graph.addNode({ x: (i % 5) * 30 - 60, y: Math.floor(i / 5) * 30 - 60, z: 0 }))
    view.sync()
    look(0, 0, 0, 200)

    const slotOfNode = (node, live = instanced()[0]) => [...Array(live.count).keys()].find((s) => {
      const m = new THREE.Matrix4(); live.getMatrixAt(s, m)
      const p = new THREE.Vector3().setFromMatrixPosition(m)
      return p.distanceTo(new THREE.Vector3(node.x, node.y, node.z)) < 1e-3
    })
    const starOf = (node, live = instanced()[0]) => {
      const s = slotOfNode(node, live)
      const a = live.geometry.getAttribute('instanceStar'), t = live.geometry.getAttribute('instanceTint')
      return [a.getX(s), a.getY(s), a.getZ(s), t.getX(s), t.getY(s), t.getZ(s)]
    }

    // Glow ring just outside the core, where the pulse shows (the core itself saturates).
    const glowOffset = NODE_RADIUS * 1.1
    const times = [0, 0.4, 0.9, 1.3, 1.8, 2.2, 2.7, 3.1, 3.6, 5.0, 7.7, 12.1]
    const series = patch.map(() => [])
    let coreMin = 255
    for (const t of times) {
      renderAt(t)
      patch.forEach((node, i) => {
        series[i].push(Math.max(...pixelAt(node, glowOffset)))
        coreMin = Math.min(coreMin, ...pixelAt(node))
      })
    }
    r.coreMin = coreMin
    r.pulseRanges = series.map((s) => Math.max(...s) - Math.min(...s))
    renderAt(2.0)
    const snapshot = patch.map((n) => Math.max(...pixelAt(n, glowOffset)))
    r.snapshotSpread = Math.max(...snapshot) - Math.min(...snapshot)
    r.distinctRates = new Set(Array.from({ length: mesh.count }, (_, s) => stars.getY(s))).size
    r.distinctSeeds = new Set(Array.from({ length: mesh.count }, (_, s) => stars.getZ(s))).size
    const tintList = Array.from({ length: mesh.count }, (_, s) => [tints.getX(s), tints.getY(s), tints.getZ(s)])
    r.blueish = tintList.filter(([cr, , cb]) => cb > cr + 0.05).length
    r.warm = tintList.filter(([cr, , cb]) => cr > cb + 0.05).length

    // Close on one star so its rays cover many pixels, then check the whole
    // frame for seams: across the clock wrap, and hours into uptime.
    look(patch[12].x, patch[12].y, 0, 40)
    renderAt(0.3)
    const a0 = frame()
    renderAt(1.7)
    r.shimmerMoves = frameDiff(a0, frame())
    renderAt(3.6 * 8 - 1e-4)
    const beforeWrap = frame()
    renderAt(3.6 * 8 + 1e-4)
    r.wrapJump = frameDiff(beforeWrap, frame())
    renderAt(4 * 3600 + 1.3)
    const late = frame()
    renderAt((4 * 3600 + 1.3) % (3.6 * 8))
    r.lateDrift = frameDiff(late, frame())
    // The billboard edge: nothing lit at the square's corners or along its sides.
    renderAt(1.0)
    const c = patch[12]
    const e = NODE_RADIUS * 4
    r.billboardEdge = Math.max(...[
      [e * 0.98, 0], [0, e * 0.98], [-e * 0.98, 0], [0, -e * 0.98], [e * 0.7, e * 0.7], [-e * 0.7, -e * 0.7],
    ].map(([dx, dy]) => Math.max(...pixelAtPoint(c.x + dx, c.y + dy, 0))))
    look(0, 0, 0, 200)

    // --- Picking on the node radius, not the billboard ----------------------
    r.allPicked = patch.every((n) => pick(n)?.id === n.id)
    const p0 = patch[12]
    r.pickInsideRadius = pickAt(p0.x + NODE_RADIUS * 0.9, p0.y, 0)?.id === p0.id
    r.pickInRays = pickAt(p0.x + NODE_RADIUS * 1.6, p0.y, 0)?.id ?? null
    r.pickInRaysLit = Math.max(...pixelAtPoint(p0.x + NODE_RADIUS * 1.6, p0.y, 0))

    // Delete from the middle: the last instance moves into the hole, and must
    // keep its own id, pulse, seed and tint.
    const victim = patch[7]
    const lastNode = patch[24]
    renderAt(2.0)
    const lastColorBefore = [pixelAt(lastNode, glowOffset), pixelAt(lastNode, -glowOffset)]
    const lastStarBefore = starOf(lastNode)
    graph.removeNode(victim.id)
    view.sync()
    renderAt(2.0)
    r.victimGone = pick(victim)?.id !== victim.id
    r.victimPixel = pixelAt(victim)
    const survivors = patch.filter((n) => n !== victim)
    r.survivorsPicked = survivors.every((n) => pick(n)?.id === n.id)
    r.movedKeepsColor = JSON.stringify([pixelAt(lastNode, glowOffset), pixelAt(lastNode, -glowOffset)]) === JSON.stringify(lastColorBefore)
    r.movedKeepsStar = JSON.stringify(starOf(lastNode)) === JSON.stringify(lastStarBefore)
    r.countAfterDelete = mesh.count

    // --- Stale-bounds trap: move a node far outside the old bounding sphere --
    renderAt(0.5) // bounds computed around the patch
    const far = patch[3]
    far.x = 1500; far.y = -900; far.z = 400
    view.syncNodes()
    look(far.x, far.y, far.z, 200)
    r.farPicked = pick(far)?.id === far.id
    renderAt(0.5)
    r.farPixel = pixelAt(far)
    r.farNotCulled = r.farPixel.some((v) => v > 5)

    // A star whose centre is just off-screen but whose rays reach into view has
    // to be drawn: the geometry bounds cover the whole billboard.
    graph.load({ nodes: [], edges: [] })
    view.sync()
    const lone = graph.addNode({ x: 0, y: 0, z: 0 })
    view.sync()
    look(0, 0, 0, 60)
    // Half-width of the view at distance 60, plus 1.5 radii: centre off-screen.
    const halfW = Math.tan(THREE.MathUtils.degToRad(35)) * 60 * (W / H)
    camera.position.x = halfW + NODE_RADIUS * 1.5
    camera.updateMatrixWorld(true)
    renderAt(0.5)
    r.edgeStarOffscreen = ndcOf(0, 0, 0).x < -1
    const buf = frame()
    let edgeLit = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < 20; x++) edgeLit = Math.max(edgeLit, buf[(y * W + x) * 4], buf[(y * W + x) * 4 + 2])
    r.edgeStarLit = edgeLit

    // --- Rays are fixed in the world, not painted on the screen --------------
    // Orbiting 20 degrees round the star has to change what it looks like; a
    // flat billboard would give the same image.
    const shotFrom = (x, y, z, roll = 0) => {
      camera.position.set(x, y, z)
      camera.up.set(0, 1, 0)
      camera.lookAt(0, 0, 0)
      camera.rotateZ(roll)
      camera.updateMatrixWorld(true)
      renderAt(0.5)
      return frame()
    }
    const meanDiff = (a, b) => {
      let s = 0
      for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
      return s / (a.length / 4)
    }
    const D = 40
    const front = shotFrom(0, 0, D)
    const orbited = shotFrom(D * Math.sin(0.35), 0, D * Math.cos(0.35))
    r.orbitChange = meanDiff(front, orbited)
    // Rolling the camera in place turns the rays with the world: the rolled
    // image matches the unrolled one rotated by the roll, not the unrolled one.
    const rollAngle = 0.5
    const rolled = shotFrom(0, 0, D, rollAngle)
    const rotate = (img, angle) => {
      const outImg = new Uint8Array(img.length)
      const c = Math.cos(angle), s = Math.sin(angle)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dx = x - W / 2, dy = y - H / 2
        const sx = Math.round(W / 2 + c * dx - s * dy), sy = Math.round(H / 2 + s * dx + c * dy)
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue
        for (let k = 0; k < 4; k++) outImg[(y * W + x) * 4 + k] = img[(sy * W + sx) * 4 + k]
      }
      return outImg
    }
    r.rollVsUnrotated = meanDiff(rolled, front)
    r.rollVsRotated = Math.min(meanDiff(rolled, rotate(front, rollAngle)), meanDiff(rolled, rotate(front, -rollAngle)))
    graph.removeNode(lone.id)

    // --- Growth past the initial 256 slots -----------------------------------
    // Capacity is 512 from the 500-node test; 521 forces 1024, then 1121 forces 2048.
    graph.load({ nodes: [], edges: [] })
    view.sync()
    const keeper = graph.addNode({ x: 0, y: 0, z: 0 })
    for (let i = 0; i < 520; i++) graph.addNode({ x: -3000, y: i, z: 0 }) // capacity -> 1024 eventually
    view.sync()
    const keeperStar = starOf(keeper)
    const before = instanced()[0]
    const grown = []
    for (let i = 0; i < 600; i++) grown.push(graph.addNode({ x: 3000 + (i % 30) * 14, y: Math.floor(i / 30) * 14, z: 0 }))
    view.syncNodes()
    const after = instanced()
    r.growthOneMesh = after.length === 1
    r.growthReplaced = after[0] !== before
    r.growthCapacity = after[0].instanceMatrix.count
    r.growthCount = after[0].count
    r.renderOrderKept = after[0].renderOrder === 1
    look(3000 + 29 * 7, 19 * 7, 0, 260)
    r.grownPicked = grown.filter((_, i) => i % 7 === 0).every((n) => pick(n)?.id === n.id)
    renderer.info.autoReset = true
    renderAt(1)
    r.callsAfterGrowth = renderer.info.render.calls
    r.starPreservedAcrossGrowth = JSON.stringify(starOf(keeper, after[0])) === JSON.stringify(keeperStar)

    // --- Physics: settle, then everything is still pickable ------------------
    graph.load({ nodes: [], edges: [] })
    physics.reset()
    view.sync()
    const tree = []
    for (let i = 0; i < 60; i++) tree.push(graph.addNode({ x: (Math.random() - 0.5) * 20, y: (Math.random() - 0.5) * 20, z: (Math.random() - 0.5) * 20 }))
    for (let i = 1; i < 60; i++) graph.addEdge(tree[i].id, tree[Math.floor(i / 3)].id)
    view.sync()
    physics.start()
    let guard = 0
    while (physics.isRunning && guard++ < 2000) physics.update()
    r.settled = !physics.isRunning
    let pickedAfterSettle = 0
    for (const n of tree) {
      camera.position.set(n.x, n.y, n.z + 12)
      camera.rotation.set(0, 0, 0)
      camera.updateMatrixWorld(true)
      if (pick(n)?.id === n.id) pickedAfterSettle++
    }
    r.pickedAfterSettle = pickedAfterSettle

    // --- A file load lands on the instanced view ---------------------------
    const other = createGraph()
    const a = other.addNode({ x: -60, y: 0, z: 0, label: 'left' })
    const b = other.addNode({ x: 60, y: 0, z: 0, label: 'right' })
    other.addEdge(a.id, b.id)
    files.applyPayload(JSON.parse(JSON.stringify({ ...other.toPayload(), camera: { position: [0, 0, 300], rotation: [0, 0, 0] } })))
    camera.updateMatrixWorld(true)
    r.loadedCount = instanced()[0].count
    r.loadedLeft = pick(graph.getNode(a.id))?.id === a.id
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera)
    r.loadedEdgeMid = view.raycast(raycaster)?.kind
    // Edge drawn before the stars: the core stays white where the edge enters it.
    renderAt(0.2)
    r.coreOverEdge = pixelAt(graph.getNode(a.id))

    // --- Hover / source halos follow the instance ---------------------------
    view.setHover({ kind: 'node', id: b.id })
    const hoverHalo = root.children.find((c) => c.isSprite && c.visible)
    r.haloOnNode = Boolean(hoverHalo) && hoverHalo.position.x === 60
    graph.getNode(b.id).x = 90
    view.syncNodes()
    r.haloFollows = Boolean(hoverHalo) && hoverHalo.position.x === 90
    view.setHover(null)
    r.haloHidden = !hoverHalo.visible

    // --- Cost at scale -------------------------------------------------------
    graph.load({ nodes: [], edges: [] })
    physics.reset()
    view.sync()
    for (let i = 0; i < 3000; i++) graph.addNode({ x: Math.random() * 2000, y: Math.random() * 2000, z: Math.random() * 2000 })
    view.sync()
    let t0 = performance.now()
    for (let i = 0; i < 50; i++) view.syncNodes()
    r.syncMs3000 = (performance.now() - t0) / 50
    look(1000, 1000, 1000, 2600)
    raycaster.setFromCamera(new THREE.Vector2(0.01, 0.02), camera)
    t0 = performance.now()
    for (let i = 0; i < 200; i++) view.raycast(raycaster)
    r.raycastMs3000 = (performance.now() - t0) / 200
    renderAt(1)
    r.calls3000 = renderer.info.render.calls

    return r
  }, threeUrl)

  expect.soft(out.calls500, '500 nodes + 499 edges = 3 draw calls (stars, edges, drift)').toBe(3)
  expect.soft(out.instancedCount === 1 && out.instanceCount === 500, 'exactly one InstancedMesh holding every node').toBe(true)
  expect.soft(out.plainMeshes, 'no per-node meshes left').toBe(0)
  expect.soft(out.coreMin, 'core stays saturated through the pulse').toBeGreaterThanOrEqual(240)
  expect.soft(out.pulseRanges.every((d) => d >= 20), 'every star visibly pulses').toBe(true)
  expect.soft(out.snapshotSpread, 'pulses are not in sync').toBeGreaterThanOrEqual(40)
  expect.soft(out.distinctRates, 'rates vary across nodes').toBeGreaterThanOrEqual(4)
  expect.soft(out.distinctSeeds, 'every star has its own ray pattern').toBeGreaterThanOrEqual(24)
  expect.soft(out.blueish >= 5 && out.warm >= 2, 'tints span blue and warm').toBe(true)
  expect.soft(out.shimmerMoves, 'rays shimmer over time').toBeGreaterThanOrEqual(30)
  expect.soft(out.wrapJump, 'no jump across the clock wrap (pulse + shimmer, whole frame)').toBeLessThanOrEqual(2)
  expect.soft(out.lateDrift, 'clock is precise after hours of uptime (whole frame)').toBeLessThanOrEqual(2)
  expect.soft(out.billboardEdge, 'nothing lit at the billboard edge').toBeLessThanOrEqual(3)
  expect.soft(out.allPicked, 'every star picks as its own node').toBe(true)
  expect.soft(out.pickInsideRadius, 'pick inside the node radius hits').toBe(true)
  expect.soft(out.pickInRays === null && out.pickInRaysLit > 10, 'pick in the rays, outside the radius, misses').toBe(true)
  expect.soft(out.victimGone && out.victimPixel.every((v) => v <= 3), 'deleted node no longer picks or draws').toBe(true)
  expect.soft(out.survivorsPicked, 'survivors still pick correctly after swap-remove').toBe(true)
  expect.soft(out.movedKeepsColor && out.movedKeepsStar, 'node moved into the hole keeps its star').toBe(true)
  expect.soft(out.countAfterDelete, 'count drops on delete').toBe(24)
  expect.soft(out.farPicked, 'node moved outside the old bounds is pickable').toBe(true)
  expect.soft(out.farNotCulled, 'node moved outside the old bounds is not culled').toBe(true)
  expect.soft(out.edgeStarOffscreen && out.edgeStarLit > 10, 'off-screen centre, on-screen rays: not culled').toBe(true)
  expect.soft(out.orbitChange, 'orbiting 20° changes how a star looks').toBeGreaterThan(3)
  expect.soft(out.rollVsRotated, 'rolling the camera turns the rays with the world').toBeLessThan(out.rollVsUnrotated * 0.35)
  expect.soft(out.growthOneMesh && out.growthReplaced && out.growthCapacity === 2048 && out.growthCount === 1121, 'growth keeps one mesh, replaced').toBe(true)
  expect.soft(out.renderOrderKept, 'render order survives reallocation').toBe(true)
  expect.soft(out.grownPicked, 'grown nodes pickable').toBe(true)
  expect.soft(out.callsAfterGrowth, 'still 1 draw call for nodes after growth (no edges)').toBe(1)
  expect.soft(out.starPreservedAcrossGrowth, 'star survives reallocation').toBe(true)
  expect.soft(out.settled, 'physics settles').toBe(true)
  expect.soft(out.pickedAfterSettle, 'every node pickable after a settle').toBe(60)
  expect.soft(out.loadedCount === 2 && out.loadedLeft && out.loadedEdgeMid === 'edge', 'file load renders onto instances').toBe(true)
  expect.soft(out.coreOverEdge.every((v) => v >= 240), 'edge does not darken the core it enters').toBe(true)
  expect.soft(out.haloOnNode && out.haloFollows && out.haloHidden, 'hover halo sits on, follows, and hides').toBe(true)
  expect.soft(out.calls3000, '3000 nodes: 1 draw call').toBe(1)
  expect.soft(out.syncMs3000, '3000 nodes: syncNodes under 2 ms').toBeLessThan(2)
  expect.soft(out.raycastMs3000, '3000 nodes: raycast under 1 ms').toBeLessThan(1)
  expect.soft(errors, 'no console errors or warnings').toEqual([])
})
