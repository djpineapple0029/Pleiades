/**
 * Look frames for the readability pass (branch readability-nexus): connection
 * heat, click-to-focus, the stretched name range and the nexus, on the real
 * scene — skybox, dust, bloom, graph view, rivers — built from the source
 * modules on the headless-harness Vite at :5180.
 *
 * Loads the balanced ~130-node map `color_fade_look.mjs` leaves in artifacts/
 * (run that first if it's missing). Saves artifacts/read_*.png. Headless only.
 *
 *   node tests/manual/readability_look.mjs
 */
/* global fx -- set on window by the page.evaluate below */
import { globSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const DIR = fileURLToPath(new URL('../../../artifacts', import.meta.url))
mkdirSync(DIR, { recursive: true })
const payload = JSON.parse(readFileSync(`${DIR}/color_balanced.json`, 'utf8'))
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
const page = await (
  await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
).newPage()
const errs = []
page.on('pageerror', (x) => errs.push(String(x)))
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))

await page.goto('http://localhost:5180/src/random.js')
await page.evaluate(async (input) => {
  document.documentElement.innerHTML =
    '<body style="margin:0;background:#000"><canvas id="c" style="width:100vw;height:100vh;display:block"></canvas></body>'
  const { createScene } = await import('/src/scene.js')
  const { createSkybox } = await import('/src/skybox.js')
  const { createDust } = await import('/src/dust.js')
  const { createBloom } = await import('/src/bloom.js')
  const { createGraph } = await import('/src/graph.js')
  const { createGraphView } = await import('/src/graphView.js')
  const { createDustRivers } = await import('/src/dustRivers.js')
  const { focusSetOf } = await import('/src/heat.js')
  const canvas = document.getElementById('c')
  const { renderer, scene, camera } = createScene(canvas)
  scene.add(createSkybox(renderer).object)
  scene.add(createDust().object)
  const bloom = createBloom(renderer, scene, camera)
  const graph = createGraph()
  graph.load(input)
  const view = createGraphView(graph, scene, renderer)
  view.sync()
  const rivers = createDustRivers(graph, scene, { radiusOf: view.radiusOf })
  let clock = 0
  window.fx = {
    graph,
    view,
    advance(seconds, dt = 1 / 60) {
      for (let s = 0; s < seconds - 1e-9; s += dt) {
        clock += dt
        view.update(clock, camera)
        rivers.update(dt, [])
      }
      view.update(clock, camera)
      rivers.setDim?.(view.mapDim)
      bloom.render()
    },
    look(from, at) {
      camera.position.set(...from)
      camera.lookAt(...at)
    },
    focus(target) {
      view.setFocus(target ? focusSetOf(graph, target) : null)
    },
    names: () => view.labelsShown().filter((l) => l.kind === 'node').length,
  }
}, payload)

const shot = (name) => page.locator('canvas').screenshot({ path: `${DIR}/read_${name}.png` })
const report = {}

await page.evaluate(() => fx.advance(20, 1 / 30))

// The map's centre and extent, for the overview.
const xs = payload.nodes.map((n) => [n.x, n.y, n.z])
const centre = [0, 1, 2].map((i) => xs.reduce((sum, p) => sum + p[i], 0) / xs.length)
const extent = Math.max(...xs.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2])))
const far = [centre[0] + extent * 0.9, centre[1] + extent * 0.5, centre[2] + extent * 1.6]

await page.evaluate(([from, at]) => fx.look(from, at), [far, centre])
await page.evaluate(() => fx.advance(2))
report.overviewNames = await page.evaluate(() => fx.names())
await shot('overview_heat')
await page.evaluate(() => fx.view.setHeat(false, { instant: true }))
await page.evaluate(() => fx.advance(0.2))
await shot('overview_plain')
await page.evaluate(() => fx.view.setHeat(true, { instant: true }))

// Inside, near the busiest star.
const degree = new Map()
for (const e of payload.edges) for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1)
const hubId = [...degree].sort((a, b) => b[1] - a[1])[0][0]
const hub = payload.nodes.find((n) => n.id === hubId)
const h = [hub.x, hub.y, hub.z]
const near = [h[0] + 120, h[1] + 80, h[2] + 260]
await page.evaluate(([from, at]) => fx.look(from, at), [near, h])
await page.evaluate(() => fx.advance(2))
report.insideNames = await page.evaluate(() => fx.names())
await shot('inside_heat')

// Focus on the hub.
await page.evaluate((id) => fx.focus({ kind: 'node', id }), hubId)
await page.evaluate(() => fx.advance(1))
report.focusNames = await page.evaluate(() => fx.names())
await shot('inside_focus')
await page.evaluate(([from, at]) => fx.look(from, at), [far, centre])
await page.evaluate(() => fx.advance(1))
await shot('overview_focus')
await page.evaluate(() => fx.focus(null))

// A nexus: four stars sharing one, close up.
await page.evaluate(() => {
  const { graph, view } = fx
  const base = [...graph.nodes.values()].reduce((a, n) => (n.x > a.x ? n : a))
  const at = { x: base.x + 400, y: base.y, z: base.z }
  const nexus = graph.addNode({ ...at, label: 'shared budget' })
  graph.setNexus(nexus.id, true)
  const names = ['Rent', 'Groceries', 'Travel', 'Savings']
  names.forEach((label, i) => {
    const a = (i / names.length) * Math.PI * 2
    const star = graph.addNode({ x: at.x + Math.cos(a) * 45, y: at.y + Math.sin(a) * 45, z: at.z, label })
    graph.addEdge(star.id, nexus.id)
  })
  view.syncNodes()
  view.syncEdges()
  window.nexusAt = [at.x, at.y, at.z]
})
const n = await page.evaluate(() => window.nexusAt)
await page.evaluate(([from, at]) => fx.look(from, at), [[n[0] + 20, n[1] + 10, n[2] + 150], n])
await page.evaluate(() => fx.advance(2))
await shot('nexus')

console.log(JSON.stringify(report))
console.log(errs.length ? errs.join('\n') : 'no page errors')
await browser.close()
