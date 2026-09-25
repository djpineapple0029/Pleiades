/**
 * Look frames for the dust rivers and the delete supernova (space-fx branch).
 *
 * Builds the real scene — skybox, dust, bloom, graph view, rivers, supernova —
 * from the source modules in a page on the headless-harness Vite at :5180,
 * loads the balanced ~130-node map `color_fade_look.mjs` leaves in artifacts/
 * (run that first if it's missing), and steps time by hand so every frame
 * lands at an exact moment. Saves to artifacts/space_*.png. Headless only.
 *
 *   node tests/manual/space_fx_look.mjs
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

// A same-origin document with nothing running in it, so the modules below can
// be imported and driven by hand.
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
  const { createSupernova } = await import('/src/supernova.js')
  const canvas = document.getElementById('c')
  const { renderer, scene, camera } = createScene(canvas)
  scene.add(createSkybox(renderer).object)
  scene.add(createDust())
  const bloom = createBloom(renderer, scene, camera)
  const graph = createGraph()
  graph.load(input)
  const view = createGraphView(graph, scene, renderer)
  view.sync()
  const rivers = createDustRivers(graph, scene, { radiusOf: view.radiusOf })
  let seed = 11
  const supernova = createSupernova(scene, { rand: () => (seed = (seed * 16807) % 2147483647) / 2147483647 })
  let clock = 0
  window.fx = {
    graph,
    view,
    camera,
    advance(seconds, dt = 1 / 60) {
      for (let s = 0; s < seconds - 1e-9; s += dt) {
        clock += dt
        view.update(clock, camera)
        supernova.update(dt)
        rivers.update(dt, supernova.shocks())
      }
      view.update(clock, camera)
      bloom.render()
    },
    look(from, at) {
      camera.position.set(...from)
      camera.lookAt(...at)
    },
    explode(id) {
      const node = graph.getNode(id)
      supernova.burst({ position: node, radius: view.radiusOf(id), tint: view.tintOf(id) })
      graph.removeNode(id)
      view.syncNodes()
      view.syncEdges()
    },
  }
}, payload)

const shot = (name) => page.locator('canvas').screenshot({ path: `${DIR}/space_${name}.png` })

// Let the rivers settle into their steady state.
await page.evaluate(() => fx.advance(40, 1 / 30))

const core = payload.nodes.find((n) => n.is_core)
const c = [core.x, core.y, core.z]
// Labels fade in over a moment after the camera arrives; give them it.
await page.evaluate((c) => fx.look([c[0] + 30, c[1] + 60, c[2] + 170], c), c)
await page.evaluate(() => fx.advance(1.5))
await shot('rivers_core')

await page.evaluate((c) => fx.look([c[0] + 400, c[1] + 250, c[2] + 520], c), c)
await page.evaluate(() => fx.advance(1.5))
await shot('rivers_wide')

// A plain, linked star for the supernova, framed close.
const victim = payload.nodes.find(
  (n) => !n.is_core && payload.edges.filter((e) => e.from === n.id || e.to === n.id).length >= 3,
)
const v = [victim.x, victim.y, victim.z]
await page.evaluate((v) => fx.look([v[0] + 20, v[1] + 30, v[2] + 110], v), v)
await page.evaluate(() => fx.advance(1.5))
await shot('nova_0_before')
await page.evaluate((id) => fx.explode(id), victim.id)
let t = 0
for (const at of [0.05, 0.15, 0.3, 0.5, 0.7, 1.0, 1.4, 2.5]) {
  await page.evaluate((d) => fx.advance(d), at - t)
  t = at
  await shot(`nova_${String(at).replace('.', '_')}`)
}

console.log(errs.length ? errs.join('\n') : 'no page errors')
await browser.close()
