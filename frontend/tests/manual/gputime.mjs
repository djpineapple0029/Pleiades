// GPU time per stage of the bloom pipeline via EXT_disjoint_timer_query_webgl2, at 2560x1600 on Metal.
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'
const browser = await chromium.launch({
  executablePath:
    '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
  ],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('page error:', e.message))
page.on('console', (m) => {
  if (m.text().startsWith('[q]')) console.log(m.text())
})
await page.goto('http://localhost:5180/')
await page.waitForTimeout(1000)
const res = await page.evaluate(async () => {
  const origin = location.origin
  let src = await (await fetch('/src/bloom.js')).text()
  src = src.replace(/from\s*["'](\/[^"']+)["']/g, (m, p) => `from "${origin}${p}"`)
  const at = (marker, code, before = false) => {
    if (!src.includes(marker)) throw new Error('marker missing: ' + marker)
    src = src.replace(marker, before ? `${code}\n${marker}` : `${marker}\n${code}`)
  }
  at('    const layers = camera.layers.mask', '    window.__q.begin("stars")', true)
  at(
    '    renderer.setClearColor(clearColor, clearAlpha)',
    '    window.__q.end(); window.__q.begin("downsample")',
  )
  at(
    '    for (let i = 1; i < LEVELS; i++) pass(downsample, levels[i - 1], levels[i])',
    '    window.__q.end(); window.__q.begin("upsample")',
  )
  at(
    '    for (let i = LEVELS - 2; i >= 0; i--) pass(upsample, levels[i + 1], levels[i])',
    '    window.__q.end(); window.__q.begin("canvas")',
  )
  at('    // 4.', '    window.__q.end(); window.__q.begin("composite")', true)
  src = src.replace(
    '    renderer.autoClear = autoClear\n  }',
    '    renderer.autoClear = autoClear\n    window.__q.end()\n  }',
  )
  const THREE = await import('/node_modules/.vite/deps/three.js')
  const { createGraph } = await import('/src/graph.js')
  const { createGraphView } = await import('/src/graphView.js')
  const { createSkybox } = await import('/src/skybox.js')
  const { createDust } = await import('/src/dust.js')
  document.getElementById('viewport').remove()
  const W = 2560,
    H = 1600
  const out = {}
  for (const aa of [true, false]) {
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: aa })
    renderer.setSize(W, H, false)
    const gl = renderer.getContext()
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    const pending = []
    const totals = {}
    let current = null
    window.__q = {
      begin(name) {
        const q = gl.createQuery()
        gl.beginQuery(ext.TIME_ELAPSED_EXT, q)
        current = { q, name }
      },
      end() {
        if (!current) {
          console.log('[q] end without begin', new Error().stack.split('\n').slice(1, 4).join(' | '))
          return
        }
        gl.endQuery(ext.TIME_ELAPSED_EXT)
        pending.push(current)
        current = null
      },
    }
    const mod = await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    const scene = new THREE.Scene()
    scene.add(createSkybox(renderer).object)
    scene.add(createDust())
    const camera = new THREE.PerspectiveCamera(70, W / H, 0.5, 20000)
    scene.add(camera)
    const graph = createGraph()
    const view = createGraphView(graph, scene, renderer)
    graph.addNode({ x: 0, y: 0, z: 0 })
    view.sync()
    camera.position.set(0, 0, 90)
    const bloom = mod.createBloom(renderer, scene, camera)
    const single = () => {
      window.__q.begin('singlePass')
      camera.layers.enable(1)
      renderer.render(scene, camera)
      camera.layers.set(0)
      window.__q.end()
    }
    const frames = 60
    for (let i = 0; i < frames; i++) {
      view.update(1 + i * 0.016)
      bloom.render()
      single()
    }
    gl.finish()
    // Results arrive asynchronously.
    for (let tries = 0; tries < 200 && pending.length; tries++) {
      await new Promise((r) => setTimeout(r, 10))
      for (let i = pending.length - 1; i >= 0; i--) {
        const { q, name } = pending[i]
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT))
          (totals[name] ??= []).push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6)
        gl.deleteQuery(q)
        pending.splice(i, 1)
      }
    }
    const row = {}
    for (const [name, xs] of Object.entries(totals)) {
      xs.sort((a, b) => a - b)
      row[name] = +xs[Math.floor(xs.length / 2)].toFixed(3)
    }
    row.pipeline = +['stars', 'downsample', 'upsample', 'canvas', 'composite']
      .reduce((s, k) => s + (row[k] ?? 0), 0)
      .toFixed(3)
    out[aa ? 'antialias (ms, median)' : 'no antialias'] = row
    renderer.dispose()
  }
  return out
})
console.table(res)
await browser.close()
