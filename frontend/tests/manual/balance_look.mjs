/**
 * Look frames for Balance (branch balance-rework; first written on
 * balance-cluster-separation): runs the app's
 * own Balance (graph.js + physics.js) in a page on the headless-harness Vite at
 * :5180, then renders the settled map on the real scene — skybox, dust, bloom,
 * graph view — from an overview angle, from above, and from inside next to
 * the busiest star.
 *
 * Two maps: artifacts/busy_map.json (`busy_map.mjs`, ~360 stars, unbalanced)
 * and artifacts/color_balanced.json (`color_fade_look.mjs`, 128 stars), so a
 * change for big maps can be checked against a small one. Saves
 * artifacts/balance_<tag>_<map>_<view>.png. Real GPU, headless.
 *
 *   node tests/manual/balance_look.mjs <tag> [arrangement] [inner]
 *
 * arrangement is free | shell | disc and inner force | rings | subgroups, the
 * constellation layout's prototype variants (context/BALANCE2.md).
 *
 * The numbers it prints are for tuning, not a score: how many pairs of colour
 * groups still overlap, and the tightest gap between two groups' edges.
 */
/* global fx -- set on window by the page.evaluate below */
import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const TAG = process.argv[2] ?? 'look'
const LAYOUT = { arrangement: process.argv[3], inner: process.argv[4] }
// Any further key=value arguments are numeric layout options, e.g. gap=120 gapRatio=0.6.
for (const arg of process.argv.slice(5)) {
  const [key, value] = arg.split('=')
  LAYOUT[key] = Number(value)
}
// LANES=0 draws every link straight, to compare against lanes (lanes.js).
const LANES = process.env.LANES !== '0'
// NEBULA=1 adds the group nebulae (nebulae.js).
const NEBULA = process.env.NEBULA === '1'
const DIR = fileURLToPath(new URL('../../../artifacts', import.meta.url))
const MAPS = {
  busy: JSON.parse(readFileSync(`${DIR}/busy_map.json`, 'utf8')),
  small: JSON.parse(readFileSync(`${DIR}/color_balanced.json`, 'utf8')),
}
const [executablePath] = globSync(
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/*.app/Contents/MacOS/*`,
)
  .sort()
  .reverse()

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--use-angle=metal', '--enable-gpu'],
})

/** Centroid, RMS radius and size of each colour group. */
function groupsOf(nodes) {
  const groups = new Map()
  for (const n of nodes) {
    if (!n.cluster_color_id) continue
    let g = groups.get(n.cluster_color_id)
    if (!g) groups.set(n.cluster_color_id, (g = { x: 0, y: 0, z: 0, n: 0, members: [] }))
    g.x += n.x
    g.y += n.y
    g.z += n.z
    g.n++
    g.members.push(n)
  }
  for (const g of groups.values()) {
    g.x /= g.n
    g.y /= g.n
    g.z /= g.n
    let sum = 0
    for (const m of g.members) sum += (m.x - g.x) ** 2 + (m.y - g.y) ** 2 + (m.z - g.z) ** 2
    g.rms = Math.sqrt(sum / g.n)
  }
  return [...groups.values()]
}

for (const [name, input] of Object.entries(MAPS)) {
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  ).newPage()
  const errs = []
  page.on('pageerror', (x) => errs.push(String(x)))
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))

  await page.goto('http://localhost:5180/src/random.js')
  const settled = await page.evaluate(
    async ([payload, layout, lanes, nebula]) => {
      document.documentElement.innerHTML =
        '<body style="margin:0;background:#000"><canvas id="c" style="width:100vw;height:100vh;display:block"></canvas></body>'
      const { createScene } = await import('/src/scene.js')
      const { createSkybox } = await import('/src/skybox.js')
      const { createDust } = await import('/src/dust.js')
      const { createBloom } = await import('/src/bloom.js')
      const { createGraph } = await import('/src/graph.js')
      const { createGraphView } = await import('/src/graphView.js')
      const { createPhysics } = await import('/src/physics.js')
      const graph = createGraph()
      graph.load(payload)
      const physics = createPhysics(graph, { syncNodes() {}, updateEdgePositions() {} }, { layout })
      const began = performance.now()
      physics.start()
      let frames = 0
      while (physics.isRunning && frames++ < 20000) physics.update()
      const ms = performance.now() - began

      const canvas = document.getElementById('c')
      const { renderer, scene, camera } = createScene(canvas)
      scene.add(createSkybox(renderer).object)
      scene.add(createDust())
      const bloom = createBloom(renderer, scene, camera)
      const view = createGraphView(graph, scene, renderer)
      view.setLanes(lanes)
      view.setNebulae(nebula)
      view.sync()
      let clock = 0
      window.fx = {
        advance(seconds, dt = 1 / 30) {
          for (let s = 0; s < seconds - 1e-9; s += dt) view.update((clock += dt), camera)
          view.update(clock, camera)
          bloom.render()
        },
        look(from, at) {
          camera.position.set(...from)
          camera.lookAt(...at)
        },
        names: () => view.labelsShown().filter((l) => l.kind === 'node').length,
      }
      return { nodes: graph.toPayload().nodes, clusters: graph.clusterCount, frames, ms }
    },
    [input, LAYOUT, LANES, NEBULA],
  )

  const nodes = settled.nodes
  const pts = nodes.map((n) => [n.x, n.y, n.z])
  const centre = [0, 1, 2].map((i) => pts.reduce((s, p) => s + p[i], 0) / pts.length)
  const extent = Math.max(...pts.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2])))

  // Tuning numbers: group pairs whose RMS spheres (×1.29, a solid ball's
  // edge) overlap, and the tightest edge-to-edge gap between two groups.
  const groups = groupsOf(nodes)
  let overlaps = 0
  let tightest = Infinity
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i]
      const b = groups[j]
      const gap = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - 1.29 * (a.rms + b.rms)
      if (gap < 0) overlaps++
      tightest = Math.min(tightest, gap)
    }
  const pairs = (groups.length * (groups.length - 1)) / 2
  // Link lengths, within a group and between groups: medians and the 90th
  // percentile, so "the lines between groups are too long" can be tuned.
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const inside = []
  const across = []
  for (const e of input.edges) {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    const length = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    if (a.cluster_color_id && b.cluster_color_id && a.cluster_color_id !== b.cluster_color_id)
      across.push(length)
    else inside.push(length)
  }
  const pct = (list, p) => Math.round([...list].sort((x, y) => x - y)[Math.floor((list.length - 1) * p)] ?? 0)
  const lengths = `links in-group median ${pct(inside, 0.5)} / across median ${pct(across, 0.5)} p90 ${pct(across, 0.9)}`

  const shot = async (view) => {
    await page.evaluate(() => fx.advance(2))
    const names = await page.evaluate(() => fx.names())
    await page.locator('canvas').screenshot({ path: `${DIR}/balance_${TAG}_${name}_${view}.png` })
    return names
  }
  await page.evaluate(() => fx.advance(10))
  const report = {}
  const side = [centre[0] + extent * 0.9, centre[1] + extent * 0.5, centre[2] + extent * 1.6]
  await page.evaluate(([from, at]) => fx.look(from, at), [side, centre])
  report.overviewNames = await shot('overview')
  const top = [centre[0] + extent * 0.05, centre[1] + extent * 2.1, centre[2] + extent * 0.4]
  await page.evaluate(([from, at]) => fx.look(from, at), [top, centre])
  report.topNames = await shot('top')

  const degree = new Map()
  for (const e of input.edges) for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1)
  const hubId = [...degree].sort((a, b) => b[1] - a[1])[0][0]
  const hub = nodes.find((n) => n.id === hubId)
  const h = [hub.x, hub.y, hub.z]
  await page.evaluate(([from, at]) => fx.look(from, at), [[h[0] + 140, h[1] + 90, h[2] + 300], h])
  report.insideNames = await shot('inside')

  console.log(
    `${name}: ${nodes.length} stars, ${settled.clusters} groups, balance ${settled.frames} frames ` +
      `(${Math.round(settled.ms)} ms), extent ${Math.round(extent)}, ` +
      `overlapping group pairs ${overlaps}/${pairs}, tightest group gap ${Math.round(tightest)}, ${lengths}, ` +
      `names ${JSON.stringify(report)}`,
  )
  if (errs.length) console.log(errs.join('\n'))
  await page.context().close()
}
await browser.close()
