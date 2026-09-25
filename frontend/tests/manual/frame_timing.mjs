import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'
const browser = await chromium.launch({
  executablePath:
    '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
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
  const renderer = new THREE.WebGLRenderer({ canvas })
  renderer.setSize(400, 300, false)
  const scene = new THREE.Scene()
  let s = 7
  const rand = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32
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
  const frames = []
  for (let f = 0; f < 30; f++) {
    const t0 = performance.now()
    physics.update()
    frames.push(+(performance.now() - t0).toFixed(2))
  }
  return { frames, stillRunning: physics.isRunning }
})
console.log(JSON.stringify(out))
await browser.close()
