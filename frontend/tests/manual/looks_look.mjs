/**
 * Look frames for the looks (branch `looks`, `src/looks.js`): Deep Space,
 * Deep Sea, Minimal and Shallow Space, each from the overview and from inside
 * the map, on the real scene built from the source modules on the
 * headless-harness Vite at :5180. Also a rough frame cost per look (a
 * synchronous pixel read after each frame, so GPU work is included).
 *
 * Loads the balanced ~130-node map `color_fade_look.mjs` leaves in artifacts/
 * (run that first if it's missing). Saves artifacts/looks_*.png. Headless only.
 *
 *   node tests/manual/looks_look.mjs [look,look…]
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
  const { createLooks } = await import('/src/looks.js')
  const { createGrid } = await import('/src/grid.js')
  const canvas = document.getElementById('c')
  const { renderer, scene, camera } = createScene(canvas)
  const skybox = createSkybox(renderer)
  scene.add(skybox.object)
  const dust = createDust()
  scene.add(dust.object)
  const bloom = createBloom(renderer, scene, camera)
  const graph = createGraph()
  graph.load(input)
  const view = createGraphView(graph, scene, renderer)
  view.sync()
  const rivers = createDustRivers(graph, scene, { radiusOf: view.radiusOf })
  const grid = createGrid()
  scene.add(grid.object)
  const looks = createLooks({ renderer, skybox, dust, bloom, view, rivers, grid })
  let clock = 0
  const gl = renderer.getContext()
  const pixel = new Uint8Array(4)
  function step(dt) {
    const look = looks.current
    clock += dt
    view.update(clock, camera, look.motion ? clock : 0)
    dust.update(look.motion ? dt : 0)
    grid.update(look.motion ? dt : 0, camera, graph)
    if (look.rivers) rivers.update(dt, [])
    else rivers.hide()
  }
  window.fx = {
    setLook: (id) => looks.set(id, { instant: true, remember: false }),
    advance(seconds, dt = 1 / 60) {
      for (let s = 0; s < seconds - 1e-9; s += dt) step(dt)
      step(0)
      rivers.setDim?.(view.mapDim)
      bloom.render()
    },
    /** Median ms per frame, pixel-read each frame so the GPU has finished. */
    cost(frames = 90) {
      const times = []
      for (let i = 0; i < frames; i++) {
        const t0 = performance.now()
        step(1 / 60)
        bloom.render()
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        times.push(performance.now() - t0)
      }
      times.sort((a, b) => a - b)
      return times[frames >> 1]
    },
    look(from, at) {
      camera.position.set(...from)
      camera.lookAt(...at)
    },
  }
}, payload)

const xs = payload.nodes.map((n) => [n.x, n.y, n.z])
const centre = [0, 1, 2].map((i) => xs.reduce((sum, p) => sum + p[i], 0) / xs.length)
const extent = Math.max(...xs.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2])))
const far = [centre[0] + extent * 0.9, centre[1] + extent * 0.5, centre[2] + extent * 1.6]
const degree = new Map()
for (const e of payload.edges) for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1)
const hubId = [...degree].sort((a, b) => b[1] - a[1])[0][0]
const hub = payload.nodes.find((n) => n.id === hubId)
const h = [hub.x, hub.y, hub.z]
const near = [h[0] + 120, h[1] + 60, h[2] + 220]

const report = {}
const only = process.argv[2]?.split(',')
for (const id of only ?? ['deep-space', 'deep-sea', 'cyberspace', 'minimal', 'shallow-space']) {
  await page.evaluate((look) => fx.setLook(look), id)
  await page.evaluate(() => fx.advance(6, 1 / 30))
  await page.evaluate(([from, at]) => fx.look(from, at), [far, centre])
  await page.evaluate(() => fx.advance(0.5))
  await page.locator('canvas').screenshot({ path: `${DIR}/looks_${id}_overview.png` })
  const overviewMs = await page.evaluate(() => fx.cost())
  await page.evaluate(([from, at]) => fx.look(from, at), [near, h])
  await page.evaluate(() => fx.advance(0.5))
  await page.locator('canvas').screenshot({ path: `${DIR}/looks_${id}_inside.png` })
  const insideMs = await page.evaluate(() => fx.cost())
  // Out past the map toward the sun (Shallow Space's planet and its day/night line).
  const out = [centre[0] + extent * 2.5, centre[1], centre[2] - extent * 2]
  await page.evaluate(([from]) => fx.look(from, [from[0] + 0.9, from[1] - 0.3, from[2] + 0.25]), [out])
  await page.evaluate(() => fx.advance(0.5))
  await page.locator('canvas').screenshot({ path: `${DIR}/looks_${id}_horizon.png` })
  report[id] = { overviewMs: +overviewMs.toFixed(2), insideMs: +insideMs.toFixed(2) }
}

console.log(JSON.stringify({ report, errs }, null, 2))
await browser.close()
