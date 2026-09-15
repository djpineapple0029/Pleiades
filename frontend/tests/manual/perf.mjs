// GPU frame cost at Retina resolution on the real GPU: the old single pass vs the bloom pipeline.
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'
const browser = await chromium.launch({
  executablePath: '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('page error:', e.message))
await page.goto('http://localhost:5180/')
await page.waitForTimeout(1000)
const res = await page.evaluate(async () => {
  const THREE = await import('/node_modules/.vite/deps/three.js')
  const { createGraph } = await import('/src/graph.js')
  const { createGraphView } = await import('/src/graphView.js')
  const { createPhysics } = await import('/src/physics.js')
  const { createBloom, STAR_LAYER } = await import('/src/bloom.js')
  const { createSkybox } = await import('/src/skybox.js')
  const { createDust } = await import('/src/dust.js')
  document.getElementById('viewport').remove()
  const W = 2560, H = 1600
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); renderer.setSize(W, H, false)
  const gl = renderer.getContext()
  const scene = new THREE.Scene()
  const t0 = performance.now()
  const sky = createSkybox(renderer)
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
  const bakeMs = performance.now() - t0
  scene.add(sky.object)
  const dust = createDust(); scene.add(dust)
  const camera = new THREE.PerspectiveCamera(70, W / H, 0.5, 20000); scene.add(camera)
  const graph = createGraph(); const view = createGraphView(graph, scene, renderer)
  const physics = createPhysics(graph, view)
  const bloom = createBloom(renderer, scene, camera)
  const px = new Uint8Array(4)
  const single = () => { camera.layers.enable(STAR_LAYER); renderer.render(scene, camera); camera.layers.set(0) }
  const time = (draw, frames = 60) => {
    for (let i = 0; i < 5; i++) { view.update(i * 0.1); draw() }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const t0 = performance.now()
    for (let i = 0; i < frames; i++) { view.update(1 + i * 0.016); draw() }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    return (performance.now() - t0) / frames
  }
  const mesh = () => scene.getObjectByName('nodes')
  const out = {}
  const measure = (name) => {
    // Best of three, each way, interleaved.
    let a = Infinity, b = Infinity
    for (let k = 0; k < 3; k++) { a = Math.min(a, time(single)); b = Math.min(b, time(bloom.render)) }
    sky.object.visible = false; dust.visible = false
    const noSky = time(single)
    sky.object.visible = true; dust.visible = true
    out[name] = { singlePassMs: +a.toFixed(2), bloomPipelineMs: +b.toFixed(2), overheadMs: +(b - a).toFixed(2), skyAndDustMs: +(a - noSky).toFixed(2) }
  }
  measure('empty map')
  const n0 = graph.addNode({ x: 0, y: 0, z: 0 }); view.sync()
  for (const [name, d] of [['one star filling the screen (d=15)', 15], ['one core star filling the screen', 45], ['one star at spawn distance (d=90)', 90]]) {
    graph.setCore(n0.id, name.includes('core')); view.sync()
    camera.position.set(d * 0.3, d * 0.2, d); camera.lookAt(0, 0, 0); measure(name)
  }
  graph.setCore(n0.id, false)
  graph.removeNode(n0.id)
  let s = 7; const rand = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32
  const ids = []
  for (let i = 0; i < 180; i++) ids.push(graph.addNode({ x: (rand() - 0.5) * 200, y: (rand() - 0.5) * 200, z: (rand() - 0.5) * 200 }).id)
  for (let i = 1; i < 180; i++) graph.addEdge(ids[i], ids[Math.floor(Math.sqrt(i) * (i % 3 === 0 ? 2 : 1)) % i])
  view.sync(); physics.start(); let g = 0; while (physics.isRunning && g++ < 3000) physics.update()
  let cx = 0, cy = 0, cz = 0
  for (const n of graph.nodes.values()) { cx += n.x; cy += n.y; cz += n.z }
  cx /= 180; cy /= 180; cz /= 180
  camera.position.set(cx + 40, cy + 20, cz + 110); camera.lookAt(cx, cy, cz); measure('180-node map, inside it')
  camera.position.set(cx, cy, cz + 520); camera.lookAt(cx, cy, cz); measure('180-node map, overview')
  graph.load({ nodes: [], edges: [] }); physics.reset(); view.sync()
  for (let i = 0; i < 3000; i++) graph.addNode({ x: (rand() - 0.5) * 1500, y: (rand() - 0.5) * 1500, z: (rand() - 0.5) * 1500 })
  view.sync()
  camera.position.set(0, 0, 1400); camera.lookAt(0, 0, 0); measure('3000 nodes, overview')
  camera.position.set(0, 0, 300); camera.lookAt(0, 0, 0); measure('3000 nodes, flying inside')
  return { bakeMs: Math.round(bakeMs), out }
})
console.log('nebula bake (incl. GPU sync):', res.bakeMs, 'ms')
console.table(res.out)
await browser.close()
