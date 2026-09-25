// Bloom energy under sub-pixel motion of a distant star, for several bloom configs and distances.
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'
const configs = JSON.parse(process.argv[2])
const browser = await chromium.launch({
  executablePath:
    '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('page error', e.message))
await page.goto('http://localhost:5180/')
await page.waitForTimeout(1200)
const res = await page.evaluate(async (configs) => {
  const THREE = await import('/node_modules/.vite/deps/three.js')
  const { createGraph } = await import('/src/graph.js')
  const { createGraphView } = await import('/src/graphView.js')
  const { createBloom } = await import('/src/bloom.js')
  document.getElementById('viewport').remove()
  const W = 320,
    H = 240
  const canvas = document.createElement('canvas')
  document.body.append(canvas)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(1)
  renderer.setSize(W, H, false)
  const gl = renderer.getContext()
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(70, W / H, 0.5, 20000)
  scene.add(camera)
  const graph = createGraph()
  const view = createGraphView(graph, scene, renderer)
  view.update(1)
  graph.addNode({ x: 0, y: 0, z: 0 })
  view.sync()
  const node = [...graph.nodes.values()][0]
  const read = () => {
    const b = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, b)
    return b
  }
  const zero = createBloom(renderer, scene, camera, { strength: 0 })
  const out = []
  for (const cfg of configs) {
    const bloom = createBloom(renderer, scene, camera, cfg)
    for (const [dist, path] of [
      [855, 'x'],
      [855, 'd'],
      [1400, 'x'],
      [1400, 'd'],
    ]) {
      camera.position.set(0, 0, dist)
      camera.updateMatrixWorld(true)
      const unitPx = H / 2 / Math.tan((35 * Math.PI) / 180) / dist
      const sums = [],
        stars = [],
        lo = new Float32Array(W * H).fill(1e9),
        hi = new Float32Array(W * H).fill(-1e9)
      for (let s = 0; s < 17; s++) {
        node.x = s / 8 / unitPx
        node.y = path === 'd' ? s / 11 / unitPx : 0
        view.syncNodes()
        bloom.render()
        const a = read()
        zero.render()
        const b = read()
        let t = 0,
          u = 0
        for (let i = 0; i < a.length; i++)
          if ((i & 3) !== 3) {
            t += a[i] - b[i]
            u += b[i]
          }
        sums.push(t)
        stars.push(u)
        for (let p = 0; p < W * H; p++) {
          const x = p % W,
            y = (p / W) | 0
          const rr = Math.hypot(x - W / 2, y - H / 2)
          if (rr < 4 * 5 * unitPx + 3) continue
          const v = a[p * 4] + a[p * 4 + 1] + a[p * 4 + 2] - b[p * 4] - b[p * 4 + 1] - b[p * 4 + 2]
          lo[p] = Math.min(lo[p], v)
          hi[p] = Math.max(hi[p], v)
        }
      }
      const m = sums.reduce((x, y) => x + y) / sums.length
      const cv = Math.sqrt(sums.reduce((x, y) => x + (y - m) ** 2, 0) / sums.length) / m
      const ms = stars.reduce((x, y) => x + y) / stars.length
      const cvs = Math.sqrt(stars.reduce((x, y) => x + (y - ms) ** 2, 0) / stars.length) / ms
      let swing = 0
      for (let p = 0; p < W * H; p++) if (hi[p] > -1e9) swing = Math.max(swing, hi[p] - lo[p])
      out.push({
        cfg: JSON.stringify(cfg).slice(0, 30),
        dist,
        path,
        swing,
        starPx: +(5 * unitPx).toFixed(2),
        mean: Math.round(m),
        cv: +cv.toFixed(3),
        starCV: +cvs.toFixed(3),
      })
    }
    bloom.dispose()
  }
  return out
}, configs)
console.table(res)
await browser.close()
