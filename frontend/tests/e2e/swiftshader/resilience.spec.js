// V2.md §2.4.3, §2.5.1, §2.5.2: the three ways the app used to look dead.
//
// No WebGL at all, a throw inside the frame loop, and a lost-then-restored
// context. The first two are provoked from outside the app (a stubbed
// getContext, a draw call that throws on demand), so no test seam is needed
// in the source. Context loss uses the real WEBGL_lose_context extension.
import { test, expect } from '@playwright/test'
import { threeModuleUrl } from '../helpers/gestures.js'

const notice = (page) => page.evaluate(() => document.getElementById('notice').textContent)
const hidden = (page, selector) => page.evaluate((s) => document.querySelector(s).hidden, selector)

test('no WebGL: says so instead of an inviting "Click to fly"', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
      if (/webgl/.test(kind)) return null
      return original.call(this, kind, ...rest)
    }
  })
  await page.goto('/')
  await expect.poll(() => notice(page)).toContain('WebGL 2')
  expect(await hidden(page, '#overlay')).toBe(false)
  expect(await hidden(page, '#overlay .prompt')).toBe(true)
  expect(await hidden(page, '#overlay .keys')).toBe(true)
  await page.mouse.click(400, 300)
  expect(await hidden(page, '#crosshair'), 'a click takes no lock').toBe(true)
})

test('a throw in the frame loop: tells the user to save, and saving still works', async ({ page }) => {
  // Every draw call throws once the page sets the flag: an error from deep in
  // three's render, which is where a real one would come from.
  await page.addInitScript(() => {
    const proto = WebGL2RenderingContext.prototype
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const original = proto[name]
      proto[name] = function (...args) {
        if (window.__failDraw) throw new Error('injected draw failure')
        return original.apply(this, args)
      }
    }
  })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto('/')
  await page.waitForTimeout(1500)
  await page.evaluate(() => (window.__failDraw = true))

  await expect.poll(() => notice(page)).toContain('Rendering stopped: injected draw failure')
  expect(await notice(page)).toMatch(/still in memory — press .+ to save it/)
  expect(await hidden(page, '#overlay .prompt')).toBe(true)
  expect(pageErrors, 'caught by the boundary, not left uncaught').toEqual([])

  await page.mouse.click(400, 300)
  expect(await hidden(page, '#crosshair'), 'a click takes no lock onto a dead scene').toBe(true)

  // The keys outlive the loop: the save panel opens.
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => hidden(page, '#editor')).toBe(false)
})

test('context loss in the app: a notice while it lasts, gone once restored', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto('/')
  await page.waitForTimeout(1500)
  const before = await page.evaluate(() => ({
    overlay: document.getElementById('overlay').hidden,
    notice: document.getElementById('notice').hidden,
  }))

  await page.evaluate(() => {
    const gl = document.getElementById('viewport').getContext('webgl2')
    window.__lose = gl.getExtension('WEBGL_lose_context')
    window.__lose.loseContext()
  })
  await expect.poll(() => notice(page)).toContain('Graphics were reset')
  expect(await hidden(page, '#notice')).toBe(false)

  await page.evaluate(() => window.__lose.restoreContext())
  await expect.poll(() => hidden(page, '#notice')).toBe(before.notice)
  expect(await hidden(page, '#overlay')).toBe(before.overlay)
  expect(await hidden(page, '#overlay .prompt'), 'the click-to-fly prompt is back').toBe(false)
  await page.waitForTimeout(500)
  expect(pageErrors).toEqual([])
})

test('context loss, the modules: the nebula and every name come back', async ({ page }) => {
  await page.goto('/')
  await page.waitForTimeout(1500)
  const threeUrl = await threeModuleUrl(page)

  const out = await page.evaluate(async (url) => {
    const THREE = await import(url)
    const { createGraph } = await import('/src/graph.js')
    const { createGraphView } = await import('/src/graphView.js')
    const { createSkybox } = await import('/src/skybox.js')
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
    const skybox = createSkybox(renderer)
    const skyScene = new THREE.Scene()
    skyScene.add(skybox.object)
    const graph = createGraph()
    const view = createGraphView(graph, scene, renderer)
    // createLabels throws its rasters away once Jost lands; let that happen
    // now, or it would redraw every name mid-test and hide what a loss does.
    await Promise.all(['400', '500'].map((weight) => document.fonts.load(`${weight} 40px Jost`)))
    await new Promise((resolve) => setTimeout(resolve, 50))

    // labels-smoke.spec.js's scene, at the size where its names place.
    const a = graph.addNode({ x: 0, y: 0, z: 0, label: 'Quarterly plan' })
    const b = graph.addNode({ x: 90, y: 20, z: 0, label: 'Hiring' })
    graph.addEdge(a.id, b.id)
    graph.setCore(a.id, true)
    view.sync()
    camera.position.set(40, 0, 260)
    camera.lookAt(40, 0, 0)
    camera.updateMatrixWorld(true)
    let clock = 10
    const step = (n) => {
      for (let i = 0; i < n; i++) view.update((clock += 0.05), camera)
    }

    // Lit pixels in one render, read back before the browser can clear it.
    const gl = renderer.getContext()
    const pixels = new Uint8Array(800 * 600 * 4)
    function lit(render) {
      renderer.setClearColor(0x000000, 1)
      render()
      gl.readPixels(0, 0, 800, 600, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      let sum = 0
      for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2]
      return sum
    }
    const sky = () => lit(() => renderer.render(skyScene, camera))
    // The names' ink alone: the leader lines under them come from geometry,
    // not the atlas, and would survive a loss either way.
    const leaders = scene.getObjectByName('labelLeaders')
    const labels = () =>
      lit(() => {
        leaders.visible = false
        camera.layers.set(LABEL_LAYER)
        renderer.render(scene, camera)
        camera.layers.set(0)
      })

    step(40)
    const names = () => view.labelsShown().map((l) => l.text)
    const fresh = { sky: sky(), labels: labels(), names: names() }

    const lose = gl.getExtension('WEBGL_lose_context')
    await new Promise((resolve) => {
      canvas.addEventListener('webglcontextlost', resolve, { once: true })
      lose.loseContext()
    })
    // Chrome refuses a restore requested from the task that delivered the loss.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await new Promise((resolve) => {
      canvas.addEventListener('webglcontextrestored', resolve, { once: true })
      lose.restoreContext()
    })
    step(40)
    const restored = { sky: sky(), labels: labels(), names: names() }

    skybox.rebake()
    view.invalidateLabels()
    step(40)
    const rebuilt = { sky: sky(), labels: labels(), names: names() }
    return { fresh, restored, rebuilt }
  }, threeUrl)

  expect(out.fresh.sky, 'the nebula draws').toBeGreaterThan(0)
  expect(out.fresh.labels, 'the names draw').toBeGreaterThan(0)
  expect(out.fresh.names, 'a name is placed').toContain('QUARTERLY PLAN')
  // A restore alone: the bug this fixes. The name still counts as shown, and
  // forty frames later it draws nothing.
  expect(out.restored.names).toEqual(out.fresh.names)
  expect(out.restored.sky, 'a restore alone leaves the nebula black').toBeLessThan(out.fresh.sky * 0.1)
  expect(out.restored.labels, 'a restore alone leaves every name blank').toBe(0)
  // Rebaked and re-rasterised: as it was.
  expect(out.rebuilt.sky).toBeGreaterThan(out.fresh.sky * 0.95)
  expect(out.rebuilt.sky).toBeLessThan(out.fresh.sky * 1.05)
  expect(out.rebuilt.labels).toBeGreaterThan(out.fresh.labels * 0.9)
  expect(out.rebuilt.labels).toBeLessThan(out.fresh.labels * 1.1)
})

test('an export with no map says so, with no "Click to fly" under it', async ({ page }) => {
  // The bare viewer page carries the build's placeholder, not a map: the same
  // path as an export whose payload won't load.
  await page.goto('/viewer.html')
  await expect.poll(() => notice(page)).toContain('holds no map')
  expect(await hidden(page, '#overlay .prompt')).toBe(true)
  expect(await hidden(page, '#overlay .keys')).toBe(true)
  await page.mouse.click(400, 300)
  expect(await hidden(page, '#crosshair'), 'a click takes no lock onto an empty scene').toBe(true)
})
