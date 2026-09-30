/**
 * Look frames for the Balance rework's round-2 options (context/BALANCE2.md):
 * the constellation layout with straight lines, aim-to-reveal (portals were
 * here too, and were dropped),
 * orbit view and a path, all on artifacts/busy_map.json. Runs the app's own
 * modules in a page on the headless-harness Vite at :5180 and renders the
 * real scene. Real GPU, headless.
 *
 *   node tests/manual/options_look.mjs
 *
 * Saves artifacts/opt_<scene>_<view>.png.
 */
/* global fx -- set on window by the page.evaluate below */
import { globSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const DIR = fileURLToPath(new URL('../../../artifacts', import.meta.url))
const MAP = JSON.parse(readFileSync(`${DIR}/busy_map.json`, 'utf8'))
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
const errors = []
page.on('pageerror', (x) => errors.push(String(x)))

await page.goto('http://localhost:5180/src/random.js')
await page.evaluate(async (payload) => {
  document.documentElement.innerHTML =
    '<body style="margin:0;background:#000"><canvas id="c" style="width:100vw;height:100vh;display:block"></canvas></body>'
  const { createScene } = await import('/src/scene.js')
  const { createSkybox } = await import('/src/skybox.js')
  const { createDust } = await import('/src/dust.js')
  const { createBloom } = await import('/src/bloom.js')
  const { createGraph } = await import('/src/graph.js')
  const { createGraphView } = await import('/src/graphView.js')
  const { createPhysics } = await import('/src/physics.js')
  const { shortestPath, orbitFocus } = await import('/src/paths.js')
  const graph = createGraph()
  graph.load(payload)
  const canvas = document.getElementById('c')
  const { renderer, scene, camera } = createScene(canvas)
  scene.add(createSkybox(renderer).object)
  scene.add(createDust())
  const bloom = createBloom(renderer, scene, camera)
  const view = createGraphView(graph, scene, renderer)
  const physics = createPhysics(graph, view)
  // Aim to reveal is on by default now; the 'plain' frames are without it.
  view.setReveal(false)
  view.sync()
  const settle = () => {
    let frames = 0
    while (physics.isRunning && frames++ < 20000) physics.update()
  }
  physics.start()
  settle()
  const balanced = graph.layoutSnapshot()

  let clock = 0
  const degree = new Map()
  for (const e of graph.edges.values())
    for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1)
  const hub = [...degree].sort((a, b) => b[1] - a[1])[0][0]
  // The two stars furthest apart by links, for the path frame.
  let pathEnds = null
  let longest = -1
  const ids = [...graph.nodes.keys()]
  for (let i = 0; i < ids.length; i += 7) {
    for (let j = i + 1; j < ids.length; j += 11) {
      const path = shortestPath(graph, ids[i], ids[j])
      if (path && path.nodes.length > longest && path.nodes.length <= 7) {
        longest = path.nodes.length
        pathEnds = [ids[i], ids[j]]
      }
    }
  }
  window.fx = {
    advance(seconds, dt = 1 / 30) {
      for (let s = 0; s < seconds - 1e-9; s += dt) view.update((clock += dt), camera)
      view.update(clock, camera)
      bloom.render()
    },
    look(from, at) {
      camera.position.set(...from)
      camera.lookAt(...at)
      camera.updateMatrixWorld(true)
    },
    frame() {
      const pts = [...graph.nodes.values()].map((n) => [n.x, n.y, n.z])
      const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length)
      const extent = Math.max(...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])))
      const node = graph.getNode(hub)
      return { c, extent, hub: [node.x, node.y, node.z] }
    },
    reset() {
      physics.stop()
      graph.applyLayout(balanced)
      view.syncNodes()
      view.updateEdgePositions()
      view.setReveal(false)
      view.setFocus(null)
      view.setHover(null)
    },
    reveal(on) {
      view.setReveal(on)
      view.setHover(on ? { kind: 'node', id: hub } : null)
    },
    orbit() {
      // Facing the inside camera, as pressing O there would.
      const node = graph.getNode(hub)
      camera.position.set(node.x + 140, node.y + 90, node.z + 300)
      camera.lookAt(node.x, node.y, node.z)
      camera.updateMatrixWorld(true)
      const e = camera.matrixWorld.elements
      physics.orbit(hub, { right: [e[0], e[1], e[2]], up: [e[4], e[5], e[6]] })
      settle()
      view.setFocus(orbitFocus(graph, hub))
    },
    path() {
      const path = shortestPath(graph, ...pathEnds)
      view.setFocus({ nodes: new Set(path.nodes), edges: new Set(path.edges) })
      return path.nodes.map((id) => graph.getNode(id).label)
    },
  }
}, MAP)

const shot = async (name) => {
  await page.evaluate(() => fx.advance(2))
  await page.locator('canvas').screenshot({ path: `${DIR}/opt_${name}.png` })
}
const views = async (scene, { overview = true, inside = true, far = 1 } = {}) => {
  const { c, extent, hub } = await page.evaluate(() => fx.frame())
  await page.evaluate(() => fx.advance(6))
  if (overview) {
    const from = [c[0] + extent * 0.9 * far, c[1] + extent * 0.5 * far, c[2] + extent * 1.6 * far]
    await page.evaluate(([f, a]) => fx.look(f, a), [from, c])
    await shot(`${scene}_overview`)
  }
  if (inside) {
    await page.evaluate(([f, a]) => fx.look(f, a), [[hub[0] + 140, hub[1] + 90, hub[2] + 300], hub])
    await shot(`${scene}_inside`)
  }
}

await views('plain')
await page.evaluate(() => fx.reveal(true))
await views('reveal')
await page.evaluate(() => fx.reset())
await page.evaluate(() => fx.orbit())
await views('orbit', { overview: false })
// From further back along the same line of sight, to take in the whole tree.
const { hub } = await page.evaluate(() => fx.frame())
for (const [name, k] of [
  ['orbit_back', 3.2],
  ['orbit_far', 7],
]) {
  await page.evaluate(([f, a]) => fx.look(f, a), [[hub[0] + 140 * k, hub[1] + 90 * k, hub[2] + 300 * k], hub])
  await shot(name)
}
await page.evaluate(() => fx.reset())
console.log('path:', (await page.evaluate(() => fx.path())).join(' → '))
await views('path', { inside: false })
if (errors.length) console.log(errors.join('\n'))
await browser.close()
