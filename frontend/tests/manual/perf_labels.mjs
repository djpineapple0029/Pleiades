// Frame cost of the labels on the real GPU at Retina size, through the full
// bloom pipeline: labels laid out and drawn vs. no labels at all (every label
// blank), plus the CPU layout alone.
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
  const { createBloom } = await import('/src/bloom.js')
  const { createSkybox } = await import('/src/skybox.js')
  const { createDust } = await import('/src/dust.js')
  document.getElementById('viewport').remove()
  const canvas = document.createElement('canvas')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(2); renderer.setSize(1280, 800, false)
  const gl = renderer.getContext()
  const scene = new THREE.Scene()
  scene.add(createSkybox(renderer).object)
  scene.add(createDust())
  const camera = new THREE.PerspectiveCamera(70, 1280 / 800, 0.5, 20000); scene.add(camera)
  const graph = createGraph(); const view = createGraphView(graph, scene, renderer)
  const physics = createPhysics(graph, view)
  const bloom = createBloom(renderer, scene, camera)
  const px = new Uint8Array(4)
  let clock = 1
  const time = (frames = 60) => {
    for (let i = 0; i < 5; i++) { view.update((clock += 0.016), camera); bloom.render() }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    const t0 = performance.now()
    for (let i = 0; i < frames; i++) { view.update((clock += 0.016), camera); bloom.render() }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    return (performance.now() - t0) / frames
  }
  const texts = new Map()
  const labels = (on) => { for (const n of graph.nodes.values()) { if (!texts.has(n.id)) texts.set(n.id, n.label); n.label = on ? texts.get(n.id) : '' } }
  const cpu = () => { const t0 = performance.now(); for (let i = 0; i < 60; i++) view.update((clock += 0.016), camera); return (performance.now() - t0) / 60 }
  const out = {}
  const measure = (name) => {
    let a = Infinity, b = Infinity, ca = Infinity, cb = Infinity
    for (let k = 0; k < 4; k++) {
      labels(true); a = Math.min(a, time()); ca = Math.min(ca, cpu())
      labels(false); b = Math.min(b, time()); cb = Math.min(cb, cpu())
    }
    labels(true); time(5)
    out[name] = { frameMs: +a.toFixed(2), noLabelsMs: +b.toFixed(2), labelsMs: +(a - b).toFixed(2), layoutCpuMs: +(ca - cb).toFixed(3), shown: view.labelsShown().length }
  }
  const settle = () => { view.sync(); physics.start(); let g = 0; while (physics.isRunning && g++ < 5000) physics.update(); view.sync() }
  const centroid = () => { let cx = 0, cy = 0, cz = 0; for (const n of graph.nodes.values()) { cx += n.x; cy += n.y; cz += n.z }; const k = graph.nodes.size; return [cx / k, cy / k, cz / k] }
  let s = 7; const rand = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32

  const ids = []
  for (let i = 0; i < 180; i++) ids.push(graph.addNode({ x: (rand() - 0.5) * 200, y: (rand() - 0.5) * 200, z: (rand() - 0.5) * 200, label: `topic number ${i}` }).id)
  for (let i = 1; i < 180; i++) graph.addEdge(ids[i], ids[Math.floor(Math.sqrt(i) * (i % 3 === 0 ? 2 : 1)) % i])
  settle()
  let [cx, cy, cz] = centroid()
  camera.position.set(cx + 40, cy + 20, cz + 110); camera.lookAt(cx, cy, cz); measure('180-node map, inside')
  camera.position.set(cx, cy, cz + 520); camera.lookAt(cx, cy, cz); measure('180-node map, overview')

  // 3000 nodes in a chain-of-clusters layout, ~4500 edges.
  graph.load({ nodes: [], edges: [] }); physics.reset(); view.sync()
  const all = []
  for (let c = 0; c < 30; c++) {
    const ox = (rand() - 0.5) * 1800, oy = (rand() - 0.5) * 1800, oz = (rand() - 0.5) * 1800
    const group = []
    for (let i = 0; i < 100; i++) {
      const n = graph.addNode({ x: ox + (rand() - 0.5) * 200, y: oy + (rand() - 0.5) * 200, z: oz + (rand() - 0.5) * 200, label: `idea ${c}.${i}` })
      if (i === 0) graph.setCore(n.id, true)
      if (group.length) graph.addEdge(n.id, group[Math.floor(rand() * group.length)])
      if (group.length > 3 && rand() < 0.5) graph.addEdge(n.id, group[Math.floor(rand() * group.length)])
      group.push(n.id); all.push(n.id)
    }
  }
  view.sync()
  ;[cx, cy, cz] = centroid()
  camera.position.set(cx, cy, cz + 3200); camera.lookAt(cx, cy, cz); measure('3000 nodes, overview')
  const a = graph.getNode(all[50])
  camera.position.set(a.x + 30, a.y + 20, a.z + 80); camera.lookAt(cx, cy, cz); measure('3000 nodes, inside a cluster')
  return out
})
console.table(res)
await browser.close()
