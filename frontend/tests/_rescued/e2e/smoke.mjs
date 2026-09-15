// Does the redesigned labels.js run at all: shaders compile, labels place,
// leaders get instances, the font lands. Deterministic SwiftShader.
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'

const BASE = process.env.BASE ?? 'http://localhost:5180'
const browser = await chromium.launch({
  executablePath: '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('ReadPixels')) errors.push(`${m.type()}: ${m.text()}`) })
await page.goto(`${BASE}/`)
await page.waitForTimeout(1500)

const out = await page.evaluate(async () => {
  const THREE = await import('/node_modules/.vite/deps/three.js')
  const { createGraph } = await import('/src/graph.js')
  const { createGraphView } = await import('/src/graphView.js')
  const { LABEL_LAYER } = await import('/src/bloom.js')
  document.getElementById('viewport').remove()
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'width:800px;height:600px'
  document.body.append(canvas)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(1)
  renderer.setSize(800, 600, false)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, 800 / 600, 0.5, 20000)
  scene.add(camera)
  const graph = createGraph()
  const view = createGraphView(graph, scene, renderer)
  await document.fonts.ready

  const core = graph.addNode({ x: 0, y: 0, z: 0, label: 'Quarterly plan' })
  const near = graph.addNode({ x: 90, y: 20, z: 0, label: 'Hiring' })
  const far = graph.addNode({ x: 40, y: -30, z: -900, label: 'distant idea' })
  graph.addEdge(core.id, near.id)
  graph.setCore(core.id, true)
  view.sync()
  camera.position.set(40, 0, 260)
  camera.lookAt(40, 0, 0)
  camera.updateMatrixWorld(true)
  let clock = 10
  for (let i = 0; i < 40; i++) view.update((clock += 0.05), camera)

  const mesh = scene.getObjectByName('labels')
  const leaders = scene.getObjectByName('labelLeaders')
  // Force a compile and catch any shader error as a console message.
  camera.layers.set(LABEL_LAYER)
  renderer.render(scene, camera)
  camera.layers.set(0)
  const programs = renderer.info.programs.map((p) => p.name)

  view.setHover({ kind: 'node', id: near.id })
  for (let i = 0; i < 20; i++) view.update((clock += 0.05), camera)
  const hovered = view.labelsShown().find((l) => l.id === near.id)

  return {
    fontLoaded: document.fonts.check(`400 40px Jost`),
    shown: view.labelsShown().map((l) => ({ id: l.id, text: l.text, tier: l.tier, side: l.side, align: l.align, x: +l.x.toFixed(1), y: +l.y.toFixed(1), w: +l.width.toFixed(1), h: +l.height.toFixed(1), o: +l.opacity.toFixed(3) })),
    instances: [mesh.geometry.instanceCount, leaders.geometry.instanceCount],
    visible: [mesh.visible, leaders.visible],
    programs,
    hoveredText: hovered?.text,
    renderCalls: (renderer.info.autoReset = false, renderer.info.reset(), camera.layers.set(LABEL_LAYER), renderer.render(scene, camera), camera.layers.set(0), renderer.info.render.calls),
  }
})
console.log(JSON.stringify(out, null, 1))
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors')
await browser.close()
