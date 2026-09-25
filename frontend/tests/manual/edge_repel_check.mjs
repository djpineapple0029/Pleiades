// Checks forceEdgeRepel (physics.js) against: a small dense "friend group" like
// too-close-example.png, a multi-cluster map (separation should not regress),
// and a 3000-node cost run (tick budget should not regress). Prints a JSON
// report and writes screenshots (real GPU) for the two look scenarios.
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'
import { writeFileSync } from 'node:fs'

const OUT = new URL('.', import.meta.url).pathname
const TAG = process.argv[2] ?? 'run'

const browser = await chromium.launch({
  executablePath:
    '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.goto('http://localhost:5180/?look')
await page.waitForTimeout(800)

const out = await page.evaluate(async () => {
  const THREE = await import('/node_modules/.vite/deps/three.js')
  const { createScene } = await import('/src/scene.js')
  const { createGraph } = await import('/src/graph.js')
  const { createGraphView } = await import('/src/graphView.js')
  const { createPhysics } = await import('/src/physics.js')
  const { createBloom } = await import('/src/bloom.js')
  const { createSkybox } = await import('/src/skybox.js')
  const { createDust } = await import('/src/dust.js')

  document.getElementById('overlay').hidden = true
  document.getElementById('viewport').style.display = 'none'
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh'
  document.body.append(canvas)
  const { renderer, scene, camera } = createScene(canvas)
  scene.add(createSkybox(renderer).object)
  scene.add(createDust())
  const pipeline = createBloom(renderer, scene, camera)

  let s = 42
  const rand = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32

  // --- geometry: 3D closest distance between two segments (Ericson) --------
  function closestSegDist2(p1, q1, p2, q2) {
    const d1x = q1.x - p1.x,
      d1y = q1.y - p1.y,
      d1z = q1.z - p1.z
    const d2x = q2.x - p2.x,
      d2y = q2.y - p2.y,
      d2z = q2.z - p2.z
    const rx = p1.x - p2.x,
      ry = p1.y - p2.y,
      rz = p1.z - p2.z
    const a = d1x * d1x + d1y * d1y + d1z * d1z
    const e = d2x * d2x + d2y * d2y + d2z * d2z
    const f = d2x * rx + d2y * ry + d2z * rz
    let s, t
    if (a <= 1e-9 && e <= 1e-9) {
      s = t = 0
    } else if (a <= 1e-9) {
      s = 0
      t = Math.min(1, Math.max(0, f / e))
    } else {
      const c = d1x * rx + d1y * ry + d1z * rz
      if (e <= 1e-9) {
        t = 0
        s = Math.min(1, Math.max(0, -c / a))
      } else {
        const b = d1x * d2x + d1y * d2y + d1z * d2z
        const denom = a * e - b * b
        s = denom > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0
        t = (b * s + f) / e
        if (t < 0) {
          t = 0
          s = Math.min(1, Math.max(0, -c / a))
        } else if (t > 1) {
          t = 1
          s = Math.min(1, Math.max(0, (b - c) / a))
        }
      }
    }
    const c1x = p1.x + d1x * s,
      c1y = p1.y + d1y * s,
      c1z = p1.z + d1z * s
    const c2x = p2.x + d2x * t,
      c2y = p2.y + d2y * t,
      c2z = p2.z + d2z * t
    const dx = c1x - c2x,
      dy = c1y - c2y,
      dz = c1z - c2z
    return dx * dx + dy * dy + dz * dz
  }

  const settle = (physics, cap = 6000) => {
    let n = 0
    while (physics.isRunning && n++ < cap) physics.update()
    return n
  }

  /** Every unordered pair of edges not sharing an endpoint, min segment gap. */
  function tangleReport(graph) {
    const edges = [...graph.edges.values()].filter((e) => e.from !== e.to)
    const pos = (id) => {
      const n = graph.getNode(id)
      return { x: n.x, y: n.y, z: n.z }
    }
    const gaps = []
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const e1 = edges[i],
          e2 = edges[j]
        if (e1.from === e2.from || e1.from === e2.to || e1.to === e2.from || e1.to === e2.to) continue
        const d2 = closestSegDist2(pos(e1.from), pos(e1.to), pos(e2.from), pos(e2.to))
        gaps.push(Math.sqrt(d2))
      }
    }
    gaps.sort((a, b) => a - b)
    const under = (t) => gaps.filter((g) => g < t).length
    return {
      pairs: gaps.length,
      minGap: gaps[0] ?? null,
      p10: gaps[Math.floor(gaps.length * 0.1)] ?? null,
      median: gaps[Math.floor(gaps.length * 0.5)] ?? null,
      crossingLike: under(5), // NODE_RADIUS-ish: reads as touching/crossing on screen
      near: under(20),
    }
  }

  const r = {}

  // === Scenario 1: small dense "friend group", too-close-example.png shape ===
  {
    const graph = createGraph()
    const view = createGraphView(graph, scene, renderer)
    const physics = createPhysics(graph, view)
    const names = ['Me', 'Tor', 'Rinya', 'Arthur', 'Freddy', 'Merek', 'Alyssa', 'Romy']
    const ids = names.map(
      (label) =>
        graph.addNode({ x: (rand() - 0.5) * 40, y: (rand() - 0.5) * 40, z: (rand() - 0.5) * 40, label }).id,
    )
    const [me, tor, rinya, arthur, freddy, merek, alyssa, romy] = ids
    const pairs = [
      [me, tor],
      [me, rinya],
      [me, freddy],
      [tor, rinya],
      [tor, arthur],
      [tor, freddy],
      [tor, merek],
      [rinya, arthur],
      [rinya, freddy],
      [arthur, freddy],
      [arthur, alyssa],
      [freddy, merek],
      [freddy, alyssa],
      [alyssa, romy],
      [merek, freddy],
    ]
    for (const [a, b] of pairs) graph.addEdge(a, b)
    view.sync()
    physics.start()
    r.friendTicks = settle(physics)
    view.sync()
    r.friend = tangleReport(graph)

    const c = ids.reduce(
      (acc, id) => {
        const n = graph.getNode(id)
        acc.x += n.x
        acc.y += n.y
        acc.z += n.z
        return acc
      },
      { x: 0, y: 0, z: 0 },
    )
    c.x /= ids.length
    c.y /= ids.length
    c.z /= ids.length
    let radius = 0
    for (const id of ids) {
      const n = graph.getNode(id)
      radius = Math.max(radius, Math.hypot(n.x - c.x, n.y - c.y, n.z - c.z))
    }
    camera.position.set(c.x, c.y, c.z + radius * 3.2 + 40)
    camera.up.set(0, 1, 0)
    camera.lookAt(c.x, c.y, c.z)
    camera.updateMatrixWorld()
    for (let i = 0; i < 40; i++) {
      r._t = (r._t ?? 0) + 0.016
      view.update(r._t, camera)
    }
    pipeline.render()
    r.friendPng = canvas.toDataURL('image/png')
    scene.remove(scene.getObjectByName('graph'))
  }

  // === Scenario 2: multi-cluster map, separation must not regress ===========
  {
    const graph = createGraph()
    const view = createGraphView(graph, scene, renderer)
    const physics = createPhysics(graph, view)
    const CLUSTERS = 6,
      PER = 30
    const groups = []
    for (let c = 0; c < CLUSTERS; c++) {
      const ox = (rand() - 0.5) * 500,
        oy = (rand() - 0.5) * 500,
        oz = (rand() - 0.5) * 500
      const group = []
      for (let i = 0; i < PER; i++) {
        const n = graph.addNode({
          x: ox + (rand() - 0.5) * 100,
          y: oy + (rand() - 0.5) * 100,
          z: oz + (rand() - 0.5) * 100,
        })
        if (group.length) graph.addEdge(n.id, group[Math.floor(rand() * group.length)])
        if (group.length > 3 && rand() < 0.6) graph.addEdge(n.id, group[Math.floor(rand() * group.length)])
        group.push(n.id)
      }
      groups.push(group)
    }
    for (let i = 0; i < 14; i++) {
      const a = groups[Math.floor(rand() * CLUSTERS)],
        b = groups[Math.floor(rand() * CLUSTERS)]
      graph.addEdge(a[Math.floor(rand() * PER)], b[Math.floor(rand() * PER)])
    }
    view.sync()
    physics.start()
    r.clusterTicks = settle(physics)
    view.sync()
    r.clusters = graph.clusterCount
    const centroid = (ids) => {
      const c = { x: 0, y: 0, z: 0 }
      for (const id of ids) {
        const n = graph.getNode(id)
        c.x += n.x
        c.y += n.y
        c.z += n.z
      }
      return { x: c.x / ids.length, y: c.y / ids.length, z: c.z / ids.length }
    }
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    const spread = (ids) => {
      const c = centroid(ids)
      return ids.reduce((m, id) => Math.max(m, dist(graph.getNode(id), c)), 0)
    }
    const cents = groups.map(centroid)
    let minApart = Infinity
    for (let i = 0; i < CLUSTERS; i++)
      for (let j = i + 1; j < CLUSTERS; j++) minApart = Math.min(minApart, dist(cents[i], cents[j]))
    r.minApart = minApart
    r.maxSpread = Math.max(...groups.map(spread))
    r.tangle = tangleReport(graph)

    const all = groups.flat()
    const mid = centroid(all)
    let radius = 0
    for (const id of all) {
      const n = graph.getNode(id)
      radius = Math.max(radius, Math.hypot(n.x - mid.x, n.y - mid.y, n.z - mid.z))
    }
    camera.position.set(mid.x + radius * 0.3, mid.y + radius * 0.2, mid.z + radius * 1.6)
    camera.up.set(0, 1, 0)
    camera.lookAt(mid.x, mid.y, mid.z)
    camera.updateMatrixWorld()
    for (let i = 0; i < 40; i++) {
      r._t = (r._t ?? 0) + 0.016
      view.update(r._t, camera)
    }
    pipeline.render()
    r.clusterPng = canvas.toDataURL('image/png')
    scene.remove(scene.getObjectByName('graph'))
  }

  // === Scenario 3: cost at 3000 nodes, tick budget must not regress =========
  {
    const graph = createGraph()
    const view = createGraphView(graph, scene, renderer)
    const physics = createPhysics(graph, view)
    const ids = []
    for (let i = 0; i < 3000; i++)
      ids.push(
        graph.addNode({ x: (rand() - 0.5) * 3000, y: (rand() - 0.5) * 3000, z: (rand() - 0.5) * 3000 }).id,
      )
    for (let c = 0; c < 60; c++) {
      const members = ids.slice(c * 50, c * 50 + 50)
      for (let i = 0; i < members.length; i++)
        for (let j = 0; j < 4; j++) graph.addEdge(members[i], members[(i + 1 + j) % members.length])
      if (c > 0) graph.addEdge(members[0], ids[(c - 1) * 50])
    }
    view.sync()
    physics.start()
    const t0 = performance.now()
    let ticks = 0
    for (let f = 0; f < 40; f++) {
      physics.update()
      ticks++
    }
    r.bigFrameMs = (performance.now() - t0) / 40
    r.bigEdges = graph.edges.size
    r.bigTicksStillRunning = physics.isRunning
  }

  return r
})

const shots = {}
for (const key of ['friendPng', 'clusterPng']) {
  if (!out[key]) continue
  writeFileSync(`${OUT}/${TAG}_${key.replace('Png', '')}.png`, Buffer.from(out[key].split(',')[1], 'base64'))
  delete out[key]
}
console.log(`--- ${TAG} ---`)
console.log(JSON.stringify(out, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v), 1))
if (errors.length) console.log('page errors:', errors.join(' | '))
await browser.close()
