/**
 * Session 9 against the real view, physics and labels: Louvain's partition
 * becomes a layout (clusters gather and separate), a colour (star tints and
 * label ink), and stays stable across re-balances, saves and reopens.
 */
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'

const BASE = process.env.BASE ?? 'http://localhost:5180'
const SHOTS = process.env.SHOTS ?? '/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/872efa37-50c3-4497-9872-41d95a7e9502/scratchpad'
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
  const { clusterInk, CLUSTER_INKS } = await import('/src/clustering.js')

  const W = 800, H = 500
  const canvas = document.createElement('canvas')
  canvas.width = W; canvas.height = H
  document.body.append(canvas)
  const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true })
  renderer.setSize(W, H, false)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, W / H, 0.5, 20000)
  camera.layers.enable(1) // the star mesh is on layer 1 only
  scene.add(camera)
  const target = new THREE.WebGLRenderTarget(W, H)

  const graph = createGraph()
  const view = createGraphView(graph, scene, renderer)
  const physics = createPhysics(graph, view)
  const files = createFiles({ graph, view, camera, physics })
  const root = scene.getObjectByName('graph')
  const r = {}

  const mesh = () => root.children.find((c) => c.isInstancedMesh)
  /** The tint the shader actually has for a node, read out of the attribute. */
  const attrTint = (id) => {
    const m = mesh()
    // Slot order is private, so the slot is found by position — *nearest*, not
    // exact: instance matrices are float32 and the model's positions float64,
    // so an equality test can never match at map-sized coordinates.
    const node = graph.getNode(id)
    const mat = new THREE.Matrix4(), pos = new THREE.Vector3()
    let best = -1, bestD = Infinity
    for (let s = 0; s < m.count; s++) {
      m.getMatrixAt(s, mat)
      pos.setFromMatrixPosition(mat)
      const d = (pos.x - node.x) ** 2 + (pos.y - node.y) ** 2 + (pos.z - node.z) ** 2
      if (d < bestD) { bestD = d; best = s }
    }
    // Nodes sit tens of units apart, so this still catches a real mismatch.
    if (best < 0 || bestD > 1e-2) return null
    const a = m.geometry.getAttribute('instanceTint')
    return [a.array[best * 3], a.array[best * 3 + 1], a.array[best * 3 + 2]]
  }
  const linear = (ink) => { const c = new THREE.Color().setRGB(ink[0], ink[1], ink[2], THREE.SRGBColorSpace); return [c.r, c.g, c.b] }
  /** Dominant hue as an angle, so "which cluster's colour is this" is one number. */
  const hueOf = ([rr, gg, bb]) => { const c = new THREE.Color(rr, gg, bb); const h = {}; c.getHSL(h); return h.h * 360 }
  const settle = (cap = 4000) => { let n = 0; while (physics.isRunning && n++ < cap) physics.update(); return n }
  const frames = (count, dt = 1 / 60) => { for (let i = 0; i < count; i++) { r._t = (r._t ?? 0) + dt; view.update(r._t, camera) } }
  const centroid = (ids) => {
    const c = { x: 0, y: 0, z: 0 }
    for (const id of ids) { const n = graph.getNode(id); c.x += n.x; c.y += n.y; c.z += n.z }
    return { x: c.x / ids.length, y: c.y / ids.length, z: c.z / ids.length }
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  const spread = (ids) => { const c = centroid(ids); return ids.reduce((m, id) => Math.max(m, dist(graph.getNode(id), c)), 0) }

  // --- two blobs joined by one edge --------------------------------------
  const blobs = [[], []]
  for (const blob of blobs) for (let i = 0; i < 10; i++) blob.push(graph.addNode({ x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 400, z: (Math.random() - 0.5) * 400 }).id)
  for (const blob of blobs) for (const a of blob) for (const b of blob) if (a < b) graph.addEdge(a, b)
  graph.addEdge(blobs[0][0], blobs[1][0])
  view.sync()

  r.clustersBefore = graph.clusterCount
  r.tintBeforeBalance = attrTint(blobs[0][0])
  physics.start()
  r.clusters = graph.clusterCount
  r.colors = blobs.map((blob) => blob.map((id) => graph.getNode(id).cluster_color_id))
  r.ticks = settle()
  frames(2)

  const c0 = centroid(blobs[0]), c1 = centroid(blobs[1])
  r.apart = dist(c0, c1)
  r.spread = [spread(blobs[0]), spread(blobs[1])]
  // Every node nearer its own cluster's centre than the other's: the strongest
  // statement of "these are two groups" that does not depend on scale.
  r.allOwnSide = blobs.every((blob, i) =>
    blob.every((id) => dist(graph.getNode(id), i ? c1 : c0) < dist(graph.getNode(id), i ? c0 : c1)))
  r.minSurfaceGap = Math.min(...blobs[0].flatMap((a) => blobs[1].map((b) =>
    dist(graph.getNode(a), graph.getNode(b)) - view.radiusOf(a) - view.radiusOf(b))))

  // --- the colours reached the GPU ---------------------------------------
  frames(90) // tints ease over ~0.3 s
  r.tints = blobs.map((blob) => blob.map((id) => attrTint(id)))
  r.wantInks = r.colors.map((list) => linear(clusterInk(list[0])))
  r.hues = r.tints.map((list) => list.map(hueOf))
  r.inkHues = r.wantInks.map(hueOf)
  r.tintOf = blobs.map((blob) => view.tintOf(blob[0]))

  // --- easing, not popping ----------------------------------------------
  const colorBefore = blobs.map((blob) => graph.getNode(blob[0]).cluster_color_id)
  const tintsBefore = blobs.map((blob) => attrTint(blob[0]))
  // Force a recolour by making the two blobs one cluster.
  for (const a of blobs[0]) for (const b of blobs[1]) graph.addEdge(a, b)
  physics.start()
  physics.stop()
  r.mergedClusters = graph.clusterCount
  // The merged cluster keeps one of the two colours it already had, so watch
  // the blob that actually had to change rather than assuming which one it is.
  const moved = graph.getNode(blobs[0][0]).cluster_color_id === colorBefore[0] ? 1 : 0
  r.movedBlob = moved
  r.movedReallyChanged = graph.getNode(blobs[moved][0]).cluster_color_id !== colorBefore[moved]
  const before = tintsBefore[moved]
  frames(1)
  const oneFrame = attrTint(blobs[moved][0])
  frames(120)
  const settled = attrTint(blobs[moved][0])
  const delta = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  r.easePartial = delta(before, oneFrame) > 1e-4 && delta(oneFrame, settled) > 1e-3
  // Hue, not exact RGB: a star's tint is its cluster's hue lifted toward white
  // by a hash of its id, so it is deliberately not the palette entry itself.
  r.settledHue = hueOf(settled)
  r.settledWantHue = hueOf(linear(clusterInk(graph.getNode(blobs[moved][0]).cluster_color_id)))

  // --- one cluster lays out as it did before clustering ------------------
  // A hub and its spokes are a single community; the cluster force must stand
  // aside so the link spring still reaches its rest length (cf. e2e_core).
  const hg = createGraph()
  const hub = hg.addNode({ x: 0, y: 0, z: 0 }).id
  const spokes = []
  for (let i = 0; i < 12; i++) spokes.push(hg.addNode({ x: (Math.random() - 0.5) * 300, y: (Math.random() - 0.5) * 300, z: (Math.random() - 0.5) * 300 }).id)
  for (const id of spokes) hg.addEdge(hub, id)
  const hview = createGraphView(hg, scene, renderer)
  const hphys = createPhysics(hg, hview)
  hview.sync()
  hphys.start()
  r.hubClusters = hg.clusterCount
  let n = 0; while (hphys.isRunning && n++ < 4000) hphys.update()
  const hubNode = hg.getNode(hub)
  r.hubPair = Math.min(...spokes.map((id) => dist(hg.getNode(id), hubNode)))
  // The link's own rest length, as physics.js builds it: LINK_DISTANCE plus how
  // far each end's collision shell reaches past base size. A 12-spoke hub is
  // well above 1x on degree alone, so this is not simply 60.
  const COLLIDE = NODE_RADIUS * 2.6
  r.hubRest = 60 + COLLIDE * (hg.sizeOf(hub) - 1) + COLLIDE * (hg.sizeOf(spokes[0]) - 1)

  // --- stability across re-balances -------------------------------------
  const sg = createGraph()
  const groups = [[], [], []]
  for (const group of groups) for (let i = 0; i < 9; i++) group.push(sg.addNode({ x: (Math.random() - 0.5) * 500, y: (Math.random() - 0.5) * 500, z: (Math.random() - 0.5) * 500 }).id)
  for (const group of groups) for (const a of group) for (const b of group) if (a < b) sg.addEdge(a, b)
  sg.addEdge(groups[0][0], groups[1][0])
  sg.addEdge(groups[1][1], groups[2][0])
  const sview = createGraphView(sg, scene, renderer)
  const sphys = createPhysics(sg, sview)
  sview.sync()
  const snapshot = () => groups.map((group) => group.map((id) => sg.getNode(id).cluster_color_id))
  sphys.start(); let m = 0; while (sphys.isRunning && m++ < 4000) sphys.update()
  const runA = snapshot()
  sphys.start(); m = 0; while (sphys.isRunning && m++ < 4000) sphys.update()
  const runB = snapshot()
  sphys.start(); m = 0; while (sphys.isRunning && m++ < 4000) sphys.update()
  const runC = snapshot()
  r.threeClusters = sg.clusterCount
  r.stable = JSON.stringify(runA) === JSON.stringify(runB) && JSON.stringify(runB) === JSON.stringify(runC)
  r.runA = runA.map((g) => g[0])
  r.distinctColors = new Set(runA.map((g) => g[0])).size
  r.groupsUniform = runA.every((g) => new Set(g).size === 1)

  // A node added and linked into one group does not recolour the others.
  const joiner = sg.addNode({ x: 0, y: 0, z: 0 }).id
  for (const id of groups[2]) sg.addEdge(joiner, id)
  sphys.start(); m = 0; while (sphys.isRunning && m++ < 4000) sphys.update()
  const runD = snapshot()
  r.growKeepsOthers = JSON.stringify(runD[0]) === JSON.stringify(runA[0]) && JSON.stringify(runD[1]) === JSON.stringify(runA[1])
  r.joinerTookGroup = sg.getNode(joiner).cluster_color_id === runA[2][0]

  // --- on screen: the two clusters really are different colours ---------
  const look = (at, distance) => {
    camera.position.set(at.x, at.y, at.z + distance)
    camera.rotation.set(0, 0, 0)
    camera.updateMatrixWorld(true)
  }
  /**
   * A star's *glow* colour. Not its centre: the core is saturated white-hot and
   * clips, so it carries no hue at all. The cluster's colour lives in the glow
   * around it, so this samples a ring `at` node radii out and keeps the most
   * saturated sample it finds.
   */
  const pixelNear = (v, node, at = 2) => {
    const centre = new THREE.Vector3(node.x, node.y, node.z).project(camera)
    const edge = new THREE.Vector3(node.x + v.radiusOf(node.id) * at, node.y, node.z).project(camera)
    const cx = (centre.x * 0.5 + 0.5) * W, cy = (0.5 - centre.y * 0.5) * H
    const ringPx = Math.max(3, Math.abs((edge.x * 0.5 + 0.5) * W - cx))
    renderer.setRenderTarget(target)
    renderer.setClearColor(0x000000, 1)
    renderer.clear()
    // Stars alone (layer 1). Edges are on layer 0 and run right through the
    // sampling ring, and a pale blue line is more saturated than a green glow,
    // so it would win the search below and report the edge's hue, not the star's.
    camera.layers.set(1)
    renderer.render(scene, camera)
    camera.layers.set(0)
    camera.layers.enable(1)
    renderer.setRenderTarget(null)
    const buf = new Uint8Array(W * H * 4)
    renderer.readRenderTargetPixels(target, 0, 0, W, H, buf)
    let best = [0, 0, 0], bestSat = -1
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2
      const px = Math.round(cx + Math.cos(a) * ringPx), py = Math.round(cy + Math.sin(a) * ringPx)
      if (px < 0 || px >= W || py < 0 || py >= H) continue
      const i = ((H - 1 - py) * W + px) * 4
      const c = [buf[i] / 255, buf[i + 1] / 255, buf[i + 2] / 255]
      const sat = Math.max(...c) - Math.min(...c)
      if (sat > bestSat) { bestSat = sat; best = c }
    }
    return best
  }
  // Every view above added its own 'graph' group to this one scene. Clear them
  // all out first, or their stars add light into the pixels sampled below.
  for (const child of [...scene.children]) if (child.name === 'graph') scene.remove(child)

  // A fresh two-cluster map, far enough apart to photograph one at a time.
  const pg = createGraph()
  const pblobs = [[], []]
  for (const blob of pblobs) for (let i = 0; i < 8; i++) blob.push(pg.addNode({ x: 0, y: 0, z: 0 }).id)
  for (const blob of pblobs) for (const a of blob) for (const b of blob) if (a < b) pg.addEdge(a, b)
  pg.addEdge(pblobs[0][0], pblobs[1][0])
  const pview = createGraphView(pg, scene, renderer)
  const pphys = createPhysics(pg, pview)
  pview.sync()
  pphys.start(); let q = 0; while (pphys.isRunning && q++ < 4000) pphys.update()
  pview.sync() // snap tints
  r.pixelColors = pblobs.map((blob) => {
    const node = pg.getNode(blob[0])
    look(node, 90)
    return pixelNear(pview, node)
  })
  r.pixelHues = r.pixelColors.map(hueOf)
  r.pixelInkHues = pblobs.map((blob) => hueOf(linear(clusterInk(pg.getNode(blob[0]).cluster_color_id))))
  r.pixelLit = r.pixelColors.every((c) => c[0] + c[1] + c[2] > 0.3)
  scene.remove(scene.getObjectByName('graph'))

  // --- labels take the cluster's ink ------------------------------------
  const lg = createGraph()
  const lblobs = [[], []]
  for (const blob of lblobs) for (let i = 0; i < 6; i++) blob.push(lg.addNode({ x: 0, y: 0, z: 0 }).id)
  for (const blob of lblobs) for (const a of blob) for (const b of blob) if (a < b) lg.addEdge(a, b)
  lg.addEdge(lblobs[0][0], lblobs[1][0])
  lblobs.forEach((blob, i) => blob.forEach((id, j) => { lg.getNode(id).label = `g${i}n${j}` }))
  const lview = createGraphView(lg, scene, renderer)
  const lphys = createPhysics(lg, lview)
  lview.sync()
  lphys.start(); let z = 0; while (lphys.isRunning && z++ < 4000) lphys.update()
  lview.sync()
  const mid = centroid([...lblobs[0], ...lblobs[1]].map((id) => id))
  // centroid() reads `graph`; recompute against lg by hand.
  const lmid = (() => { const c = { x: 0, y: 0, z: 0 }; const all = [...lblobs[0], ...lblobs[1]]; for (const id of all) { const n = lg.getNode(id); c.x += n.x; c.y += n.y; c.z += n.z } return { x: c.x / all.length, y: c.y / all.length, z: c.z / all.length } })()
  camera.position.set(lmid.x, lmid.y, lmid.z + 150)
  camera.rotation.set(0, 0, 0)
  camera.updateMatrixWorld(true)
  let lt = 0
  for (let i = 0; i < 40; i++) { lt += 1 / 60; lview.update(lt, camera) }
  /**
   * Renders the names alone and returns the brightest pixel in each rect.
   * Only the names: they live on LABEL_LAYER (2), and a label is placed clear
   * of every other star but never clear of the edges, so drawing layer 0 too
   * would let a line crossing the name's box out-brighten its own glyphs.
   */
  const sampleLabels = (rects) => {
    camera.layers.set(2)
    renderer.setRenderTarget(target)
    renderer.setClearColor(0x000000, 1)
    renderer.clear()
    renderer.render(scene, camera)
    renderer.setRenderTarget(null)
    camera.layers.set(0)
    camera.layers.enable(1)
    const buf = new Uint8Array(W * H * 4)
    renderer.readRenderTargetPixels(target, 0, 0, W, H, buf)
    return rects.map((rect) => {
      let best = [0, 0, 0], bestL = -1
      for (let y = Math.max(0, Math.floor(rect.y)); y < Math.min(H, Math.ceil(rect.y + rect.height)); y++) {
        for (let x = Math.max(0, Math.floor(rect.x)); x < Math.min(W, Math.ceil(rect.x + rect.width)); x++) {
          const i = ((H - 1 - y) * W + x) * 4
          const c = [buf[i] / 255, buf[i + 1] / 255, buf[i + 2] / 255]
          const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
          if (L > bestL) { bestL = L; best = c }
        }
      }
      return { color: best, luminance: bestL }
    })
  }
  const shownLabels = lview.labelsShown()
  // Snapshot the model's colours now: the plain-ink comparison below zeroes
  // every node's cluster, and the "matches the model" assertion runs after it.
  const modelClusters = new Map([...lg.nodes.keys()].map((id) => [id, lg.getNode(id).cluster_color_id]))
  // Only labels that found a clean spot: one lying over a star would sample the
  // star's light rather than its own ink.
  const perCluster = new Map()
  for (const s of shownLabels) if (s.clean && s.cluster > 0 && !perCluster.has(s.cluster)) perCluster.set(s.cluster, s)
  const picked = [...perCluster.values()]
  const clusteredInk = sampleLabels(picked)
  r.labelInk = picked.map((s, i) => ({
    cluster: s.cluster, id: s.id, text: s.text, opacity: s.opacity,
    luminance: clusteredInk[i].luminance, color: clusteredInk[i].color,
    hue: hueOf(clusteredInk[i].color), wantHue: hueOf(linear(clusterInk(s.cluster))),
  }))
  // The same names again with no cluster at all. A label is dimmed by distance
  // by design (session 8b), which clustering should not be blamed for, so the
  // question worth asking is only whether the cluster colour made it darker.
  for (const node of lg.nodes.values()) node.cluster_color_id = 0
  for (let i = 0; i < 5; i++) { lt += 1 / 60; lview.update(lt, camera) }
  const plainShown = lview.labelsShown()
  const plainInk = sampleLabels(picked.map((s) => plainShown.find((q) => q.id === s.id) ?? s))
  r.labelInkPlain = picked.map((s, i) => ({ id: s.id, luminance: plainInk[i].luminance }))
  r.labelCount = shownLabels.length
  r.labelClusters = lblobs.map((blob) => blob.map((id) => shownLabels.find((s) => s.id === id)?.cluster).filter((v) => v !== undefined))
  r.labelReportsCluster = shownLabels.length > 0 && shownLabels.every((s) => Number.isInteger(s.cluster))
  r.labelClusterMatchesModel = shownLabels.every((s) => s.cluster === modelClusters.get(s.id))
  r.labelTwoClusters = new Set(shownLabels.map((s) => s.cluster)).size === 2

  // --- a save and reopen keeps the colours -------------------------------
  const payload = files.toPayload()
  // This graph was merged into one cluster above, so that — not the original
  // two — is what a reopen has to come back with.
  r.sourceClusters = graph.clusterCount
  r.payloadHasColors = payload.nodes.every((node) => Number.isInteger(node.cluster_color_id))
  const rg = createGraph()
  const rview = createGraphView(rg, scene, renderer)
  const rphys = createPhysics(rg, rview)
  const rfiles = createFiles({ graph: rg, view: rview, camera, physics: rphys })
  rfiles.applyPayload(JSON.parse(JSON.stringify(payload)))
  r.reopenKeeps = payload.nodes.every((node) => rg.getNode(node.id).cluster_color_id === node.cluster_color_id)
  r.reopenCount = rg.clusterCount
  r.reopenSnapsTint = (() => {
    const coloured = payload.nodes.find((node) => node.cluster_color_id > 0)
    if (!coloured) return false
    const want = linear(clusterInk(coloured.cluster_color_id))
    const got = rview.tintOf(coloured.id)
    // Snapped, not eased up from nothing: the hue is already right.
    return got && Math.abs(hueOf(got) - hueOf(want)) < 25
  })()

  // --- cost --------------------------------------------------------------
  const bg = createGraph()
  const bids = []
  for (let i = 0; i < 3000; i++) bids.push(bg.addNode({ x: (Math.random() - 0.5) * 3000, y: (Math.random() - 0.5) * 3000, z: (Math.random() - 0.5) * 3000 }).id)
  for (let c = 0; c < 60; c++) {
    const members = bids.slice(c * 50, c * 50 + 50)
    for (let i = 0; i < members.length; i++) for (let j = 0; j < 4; j++) bg.addEdge(members[i], members[(i + 1 + j) % members.length])
    if (c > 0) bg.addEdge(members[0], bids[(c - 1) * 50])
  }
  const bview = createGraphView(bg, scene, renderer)
  const bphys = createPhysics(bg, bview)
  bview.sync()
  const t0 = performance.now()
  bg.recluster()
  const t1 = performance.now()
  r.reclusterMs = t1 - t0
  r.bigClusters = bg.clusterCount
  let bt = 0
  bview.update((bt += 1 / 60), camera) // the frame that retargets every tint
  const t2 = performance.now()
  bview.update((bt += 1 / 60), camera)
  const t3 = performance.now()
  r.easeFrameMs = t3 - t2
  r.drawCalls = (() => { const info = renderer.info; return info.render.calls })()

  return r
})

const errs = errors.filter((e) => !e.includes('THREE.WebGLRenderer: Context Lost'))
console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v), 1).slice(0, 3000))

// --- the partition becomes a layout ---
check('two blobs are two clusters', out.clusters === 2, `${out.clusters}`)
check('unbalanced map has no clusters yet', out.clustersBefore === 0)
check('each blob is one colour', out.colors.every((list) => new Set(list).size === 1), JSON.stringify(out.colors.map((l) => l[0])))
check('the two blobs differ in colour', out.colors[0][0] !== out.colors[1][0])
check('the run settled', out.ticks < 4000)
check('clusters separate: every node sits on its own cluster\'s side', out.allOwnSide)
check('the two clusters are further apart than either is wide',
  out.apart > Math.max(...out.spread) * 2, `apart ${out.apart}, spread ${JSON.stringify(out.spread)}`)
check('and do not interpenetrate', out.minSurfaceGap > 0, `${out.minSurfaceGap}`)

// --- the partition becomes a colour ---
check('star tints reach the instance attribute', out.tints.every((list) => list.every((t) => t && t.some((c) => c > 0))))
check('every star in a cluster carries that cluster\'s hue',
  out.hues.every((list, i) => list.every((h) => Math.abs(h - out.inkHues[i]) < 25)),
  JSON.stringify(out.hues.map((l, i) => [Math.round(out.inkHues[i]), l.map(Math.round)])))
check('the two clusters are visibly different hues', Math.abs(out.hues[0][0] - out.hues[1][0]) > 30,
  `${out.hues[0][0]} vs ${out.hues[1][0]}`)
check('stars within one cluster still vary (not N copies of one dot)',
  out.tints.every((list) => new Set(list.map((t) => t.map((c) => Math.round(c * 255)).join())).size > 3))
check('view.tintOf agrees with the attribute', out.tintOf.every((t, i) => t && Math.abs(hueOf0(t) - out.hues[i][0]) < 1))
function hueOf0(t) { // mirror of the in-page hue, for the assertion above
  const [r0, g0, b0] = t
  const max = Math.max(r0, g0, b0), min = Math.min(r0, g0, b0), d = max - min
  if (d === 0) return 0
  let h
  if (max === r0) h = ((g0 - b0) / d) % 6
  else if (max === g0) h = (b0 - r0) / d + 2
  else h = (r0 - g0) / d + 4
  h *= 60
  return h < 0 ? h + 360 : h
}
check('merging the blobs is one cluster', out.mergedClusters === 1)
check('the watched blob really did change colour', out.movedReallyChanged)
check('a recolour eases rather than pops', out.easePartial)
check('and lands on the new cluster colour', Math.abs(out.settledHue - out.settledWantHue) < 25,
  `${out.settledHue} want ${out.settledWantHue}`)

// --- one cluster is left alone ---
check('a hub and its spokes are a single cluster', out.hubClusters === 1, `${out.hubClusters}`)
// Collide between the spokes can push them past the rest length; only the
// cluster force could pull them inside it, which is what this rules out.
check('a single cluster is not compressed inside the link rest length', out.hubPair > out.hubRest - 4,
  `${out.hubPair} vs rest ${out.hubRest}`)

// --- stability, the acceptance criterion ---
check('three groups are three clusters', out.threeClusters === 3, `${out.threeClusters}`)
check('each group is uniformly coloured', out.groupsUniform)
check('three distinct colours', out.distinctColors === 3, JSON.stringify(out.runA))
check('re-pressing Balance twice more changes no colour at all', out.stable, JSON.stringify(out.runA))
check('growing one group leaves the others\' colours alone', out.growKeepsOthers)
check('and the new node takes the group\'s colour', out.joinerTookGroup)

// --- on screen ---
check('both clusters light their pixels', out.pixelLit, JSON.stringify(out.pixelColors))
check('on screen, each cluster renders in its own hue',
  out.pixelHues.every((h, i) => Math.abs(h - out.pixelInkHues[i]) < 40),
  `${JSON.stringify(out.pixelHues)} want ${JSON.stringify(out.pixelInkHues)}`)
check('and the two look different on screen', Math.abs(out.pixelHues[0] - out.pixelHues[1]) > 30,
  JSON.stringify(out.pixelHues))

// --- labels ---
check('labels are drawn', out.labelCount > 0, `${out.labelCount}`)
check('labelsShown reports each label\'s cluster', out.labelReportsCluster)
check('and it matches the model', out.labelClusterMatchesModel)
check('labels span both clusters', out.labelTwoClusters, JSON.stringify(out.labelClusters))
check('a label was sampled from each cluster', out.labelInk.length === 2, JSON.stringify(out.labelInk.map((k) => k.cluster)))
check('a clustered label is still bright enough to read',
  out.labelInk.every((k) => k.luminance > 0.3),
  JSON.stringify(out.labelInk.map((k) => [k.text, Math.round(k.luminance * 100) / 100, k.color.map((c) => Math.round(c * 255))])))
check('and the cluster colour does not darken it against no cluster at all',
  out.labelInk.every((k, i) => k.luminance >= out.labelInkPlain[i].luminance * 0.85),
  JSON.stringify(out.labelInk.map((k, i) => [k.text, Math.round(k.luminance * 100) / 100, Math.round(out.labelInkPlain[i].luminance * 100) / 100])))
check('and its ink carries its cluster\'s hue',
  out.labelInk.every((k) => Math.abs(k.hue - k.wantHue) < 45),
  JSON.stringify(out.labelInk.map((k) => [k.text, Math.round(k.hue), Math.round(k.wantHue)])))
check('the two clusters\' labels are different colours',
  out.labelInk.length === 2 && Math.abs(out.labelInk[0].hue - out.labelInk[1].hue) > 25,
  JSON.stringify(out.labelInk.map((k) => Math.round(k.hue))))

// --- persistence ---
check('the payload carries cluster_color_id', out.payloadHasColors)
check('a reopened map keeps every colour', out.reopenKeeps)
check('and recovers its cluster count', out.reopenCount === out.sourceClusters, `${out.reopenCount} vs ${out.sourceClusters}`)
check('a load snaps tints instead of easing them in', out.reopenSnapsTint)

// --- cost ---
console.log(`    3000 nodes: recluster ${out.reclusterMs.toFixed(1)} ms, retarget+ease frame ${out.easeFrameMs.toFixed(2)} ms, ${out.bigClusters} clusters`)
check('recluster at 3000 nodes under 400 ms', out.reclusterMs < 400, `${out.reclusterMs.toFixed(1)}`)
check('a tint-easing frame at 3000 nodes under 3 ms', out.easeFrameMs < 3, `${out.easeFrameMs.toFixed(2)}`)
check('no console errors or warnings', errs.length === 0, errs.join(' | '))

await browser.close()
console.log(`\n${ok} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
