/**
 * Look frames for the tree Balance (context/BALANCE2.md §8): the backbone laid
 * out as flat discs or cone trees, cross-links drawn as arcs, on
 * artifacts/busy_map.json. Headless-harness Vite on :5180, real GPU.
 *
 *   node tests/manual/tree_look.mjs
 *
 * Saves artifacts/tree_<shape>_<view>.png for shape disc, cone and off (the
 * round-1 constellation layout, with arcs).
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

for (const shape of ['disc', 'cone', 'off']) {
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  ).newPage()
  const errors = []
  page.on('pageerror', (x) => errors.push(String(x)))
  await page.goto('http://localhost:5180/src/random.js')
  const info = await page.evaluate(
    async ([payload, treeShape]) => {
      document.documentElement.innerHTML =
        '<body style="margin:0;background:#000"><canvas id="c" style="width:100vw;height:100vh;display:block"></canvas></body>'
      const { createScene } = await import('/src/scene.js')
      const { createSkybox } = await import('/src/skybox.js')
      const { createDust } = await import('/src/dust.js')
      const { createBloom } = await import('/src/bloom.js')
      const { createGraph } = await import('/src/graph.js')
      const { createGraphView } = await import('/src/graphView.js')
      const { createPhysics } = await import('/src/physics.js')
      const { computeBackbone } = await import('/src/backbone.js')
      const graph = createGraph()
      graph.load(payload)
      const canvas = document.getElementById('c')
      const { renderer, scene, camera } = createScene(canvas)
      scene.add(createSkybox(renderer).object)
      scene.add(createDust())
      const bloom = createBloom(renderer, scene, camera)
      const view = createGraphView(graph, scene, renderer)
      const physics = createPhysics(graph, view, { layout: { tree: treeShape } })
      view.sync()
      const began = performance.now()
      physics.start()
      const ms = performance.now() - began
      let frames = 0
      while (physics.isRunning && frames++ < 20000) physics.update()
      const backbone = computeBackbone(graph.nodes, graph.edges)

      let clock = 0
      const degree = new Map()
      for (const e of graph.edges.values())
        for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1)
      const hub = [...degree].sort((a, b) => b[1] - a[1])[0][0]
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
        aim: (on) => view.setHover(on ? { kind: 'node', id: hub } : null),
        frame() {
          const pts = [...graph.nodes.values()].map((n) => [n.x, n.y, n.z])
          const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length)
          const extent = Math.max(...pts.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])))
          const node = graph.getNode(hub)
          return { c, extent, hub: [node.x, node.y, node.z] }
        },
      }
      return { ms, trees: backbone.roots.length, branch: backbone.branch.size, cross: backbone.cross.size }
    },
    [MAP, shape],
  )
  const shot = async (name) => {
    await page.evaluate(() => fx.advance(2))
    await page.locator('canvas').screenshot({ path: `${DIR}/tree_${shape}_${name}.png` })
  }
  await page.evaluate(() => fx.advance(6))
  const { c, extent, hub } = await page.evaluate(() => fx.frame())
  await page.evaluate(
    ([f, a]) => fx.look(f, a),
    [[c[0] + extent * 0.9, c[1] + extent * 0.5, c[2] + extent * 1.6], c],
  )
  await shot('overview')
  await page.evaluate(
    ([f, a]) => fx.look(f, a),
    [[c[0] + extent * 0.05, c[1] + extent * 2.1, c[2] + extent * 0.4], c],
  )
  await shot('top')
  await page.evaluate(([f, a]) => fx.look(f, a), [[hub[0] + 140, hub[1] + 90, hub[2] + 300], hub])
  await shot('inside')
  await page.evaluate(() => fx.aim(true))
  await shot('inside_aim')
  console.log(
    `${shape}: layout ${Math.round(info.ms)} ms, ${info.trees} trees, ${info.branch} branch links, ` +
      `${info.cross} cross-links, extent ${Math.round(extent)}`,
  )
  if (errors.length) console.log(errors.join('\n'))
  await page.context().close()
}
await browser.close()
