import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'
const browser = await chromium.launch({
  executablePath: '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('page error:', e.message))
await page.goto('http://localhost:5180/')
await page.waitForTimeout(800)
const out = await page.evaluate(async () => {
  const { createGraph } = await import('/src/graph.js')
  const { createGraphView } = await import('/src/graphView.js')
  const { createPhysics } = await import('/src/physics.js')
  const transformed = await (await fetch('/src/graphView.js')).text()
  const threeUrl = transformed.match(/["']([^"']*deps\/three\.js[^"']*)["']/)[1]
  const THREE = await import(threeUrl)
  const canvas = document.createElement('canvas')
  const renderer = new THREE.WebGLRenderer({ canvas }); renderer.setSize(400, 300, false)
  const scene = new THREE.Scene()
  let s = 7
  const rand = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32
  async function run(label, N, edgesPerNode, spawnClose) {
    const graph = createGraph(); const view = createGraphView(graph, scene, renderer); const physics = createPhysics(graph, view)
    const ids = []
    for (let i = 0; i < N; i++) {
      const near = spawnClose && ids.length ? graph.getNode(ids[Math.floor(rand() * ids.length)]) : null
      const base = near ? near : { x: 0, y: 0, z: 0 }
      ids.push(graph.addNode({ x: base.x + (rand() - 0.5) * 60, y: base.y + (rand() - 0.5) * 60, z: base.z + (rand() - 0.5) * 60 }).id)
    }
    for (let i = 1; i < N; i++) for (let j = 0; j < edgesPerNode; j++) graph.addEdge(ids[i], ids[Math.floor(rand() * i)])
    view.sync(); physics.start()
    const frames = []
    for (let f = 0; f < 20; f++) { const t0 = performance.now(); physics.update(); frames.push(+(performance.now() - t0).toFixed(2)) }
    return { label, N, edges: graph.edges.size, frames, avg: +(frames.reduce((a, b) => a + b, 0) / frames.length).toFixed(2), max: Math.max(...frames) }
  }
  const results = []
  results.push(await run('180 nodes, ~1 edge/node, spawned near neighbours', 180, 1, true))
  results.push(await run('800 nodes, ~2 edges/node, spawned near neighbours', 800, 2, true))
  results.push(await run('1500 nodes, ~3 edges/node, spawned near neighbours', 1500, 3, true))
  return results
})
console.log(JSON.stringify(out.map(({ frames, ...r }) => r), null, 1))
await browser.close()
