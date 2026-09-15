// Label-free frames on the real GPU, plus each labelled star's screen position,
// for mocking label directions over. Usage: node backdrop.mjs
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'
import { writeFileSync } from 'node:fs'

const OUT = new URL('.', import.meta.url).pathname
const browser = await chromium.launch({
  executablePath: '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
page.on('pageerror', (e) => console.log('page error:', e.message))
await page.goto('http://localhost:5180/?look')
await page.waitForTimeout(1200)

const frames = await page.evaluate(async () => {
  const THREE = await import('/node_modules/.vite/deps/three.js')
  const { createScene } = await import('/src/scene.js')
  const { createGraph } = await import('/src/graph.js')
  const { createGraphView } = await import('/src/graphView.js')
  const { createPhysics } = await import('/src/physics.js')
  const { createBloom } = await import('/src/bloom.js')
  const { createSkybox } = await import('/src/skybox.js')
  const { createDust } = await import('/src/dust.js')

  document.getElementById('overlay').hidden = true
  document.getElementById('viewport').style.display = 'none'
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh'
  document.body.append(canvas)
  const { renderer, scene, camera } = createScene(canvas)
  scene.add(createSkybox(renderer).object)
  scene.add(createDust())
  const graph = createGraph()
  const view = createGraphView(graph, scene, renderer)
  const physics = createPhysics(graph, view)
  const pipeline = createBloom(renderer, scene, camera)
  let clock = 1
  const draw = () => {
    clock += 0.016
    view.update(clock, camera)
    scene.getObjectByName('labels').visible = false
    pipeline.render()
  }
  const shots = {}
  const v = new THREE.Vector3()
  const shoot = (name) => {
    for (let i = 0; i < 40; i++) draw()
    const shown = new Set(view.labelsShown().map((l) => l.id))
    const pxPerUnit = 0.5 * 800 * camera.projectionMatrix.elements[5]
    const eye = camera.position
    const stars = []
    for (const n of graph.nodes.values()) {
      v.set(n.x, n.y, n.z)
      const dist = v.distanceTo(eye)
      v.applyMatrix4(camera.matrixWorldInverse)
      const depth = -v.z
      if (depth <= camera.near) continue
      v.set(n.x, n.y, n.z).project(camera)
      const x = (v.x * 0.5 + 0.5) * 1280
      const y = (0.5 - v.y * 0.5) * 800
      if (x < -50 || x > 1330 || y < -50 || y > 850) continue
      const r = view.radiusOf(n.id)
      stars.push({ id: n.id, label: n.label, x, y, rPx: (r * pxPerUnit) / depth, size: r / 3, dist, shown: shown.has(n.id) })
    }
    shots[name] = { png: canvas.toDataURL('image/png'), stars }
  }
  const settle = () => { view.sync(); physics.start(); let g = 0; while (physics.isRunning && g++ < 5000) physics.update(); view.sync() }
  let s = 11
  const rand = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32
  const WORDS = ['orbit', 'signal', 'harbor', 'lattice', 'ember', 'quarry', 'meridian', 'thesis', 'cobalt', 'archive', 'delta', 'margin', 'vector', 'pilgrim', 'ledger', 'canopy', 'furnace', 'glacier', 'kernel', 'ribbon', 'summit', 'tundra', 'vessel', 'willow', 'budget', 'hiring', 'roadmap', 'research', 'design review', 'Q3 goals', 'user interviews', 'pricing', 'onboarding flow']
  const word = () => WORDS[Math.floor(rand() * WORDS.length)]
  const title = () => (rand() < 0.5 ? word() : `${word()} ${word()}`)
  const look = (px, py, pz, tx, ty, tz) => { camera.position.set(px, py, pz); camera.up.set(0, 1, 0); camera.lookAt(tx, ty, tz); camera.updateMatrixWorld() }

  const chain = []
  const names = ['Inbox', 'Weekly review', 'Strategy', 'Quarterly plan', 'Hiring', 'Budget 2027', 'Vendors']
  for (let i = 0; i < 7; i++) { chain.push(graph.addNode({ x: i * 70, y: (i % 2) * 25, z: 0, label: names[i] }).id); if (i) graph.addEdge(chain[i - 1], chain[i]) }
  graph.setCore(chain[3], true)
  view.sync()
  look(210, 30, 160, 210, 12, 0)
  shoot('chain')

  graph.load({ nodes: [], edges: [] }); physics.reset(); view.sync()
  const CLUSTERS = 8, PER = 50
  const ids = []
  for (let c = 0; c < CLUSTERS; c++) {
    const ox = (rand() - 0.5) * 600, oy = (rand() - 0.5) * 600, oz = (rand() - 0.5) * 600
    const group = []
    for (let i = 0; i < PER; i++) {
      const n = graph.addNode({ x: ox + (rand() - 0.5) * 120, y: oy + (rand() - 0.5) * 120, z: oz + (rand() - 0.5) * 120, label: i === 0 ? `Topic ${String.fromCharCode(65 + c)}` : title() })
      if (group.length) graph.addEdge(n.id, group[Math.floor(rand() * group.length)])
      if (group.length > 3 && rand() < 0.7) graph.addEdge(n.id, group[Math.floor(rand() * group.length)])
      if (group.length > 3 && rand() < 0.3) graph.addEdge(n.id, group[Math.floor(rand() * group.length)])
      group.push(n.id)
    }
    graph.setCore(group[0], true)
    ids.push(group)
  }
  for (let i = 0; i < 24; i++) {
    const a = ids[Math.floor(rand() * CLUSTERS)], b = ids[Math.floor(rand() * CLUSTERS)]
    graph.addEdge(a[Math.floor(rand() * PER)], b[Math.floor(rand() * PER)])
  }
  settle()
  const c0 = graph.getNode(ids[0][0])
  look(c0.x + 150, c0.y + 80, c0.z + 260, c0.x, c0.y, c0.z)
  shoot('dense')
  return shots
})
for (const [name, { png, stars }] of Object.entries(frames)) {
  writeFileSync(`${OUT}/bg_${name}.png`, Buffer.from(png.split(',')[1], 'base64'))
  writeFileSync(`${OUT}/bg_${name}.json`, JSON.stringify(stars))
  console.log(name, stars.length, 'stars on screen,', stars.filter((s) => s.shown).length, 'labelled')
}
await browser.close()
