// The readability pass: names that reach further when there are few of them,
// connection heat on the lines, click-to-focus, and the nexus (a half-size
// shared connection point), against the real modules and through the app's
// own input handlers.
import { test, expect } from '@playwright/test'
import {
  collectConsoleErrors,
  installGestures,
  t,
  settle,
  pickMenu,
  threeModuleUrl,
} from '../helpers/gestures.js'

test('stretched name range, and heat along a line', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  const threeUrl = await threeModuleUrl(page)

  const r = await page.evaluate(async (threeUrl) => {
    const THREE = await import(threeUrl)
    const { createGraph } = await import('/src/graph.js')
    const { createGraphView } = await import('/src/graphView.js')
    const { setLabelTarget, DEFAULT_LABEL_TARGET, revealRange } = await import('/src/labels.js')
    document.getElementById('viewport').remove()
    await document.fonts.ready

    const W = 800
    const H = 600
    const canvas = document.createElement('canvas')
    canvas.style.cssText = `width:${W}px;height:${H}px`
    document.body.append(canvas)
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    renderer.setPixelRatio(1)
    renderer.setSize(W, H, false)
    renderer.setClearColor(0x000000)
    const gl = renderer.getContext()
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(70, W / H, 0.5, 20000)
    scene.add(camera)
    let clock = 10
    const run = (view, n = 60) => {
      for (let i = 0; i < n; i++) view.update((clock += 0.05), camera)
    }
    const out = {}

    // --- A small map, every star 700-1100 units off: all named. ---
    const small = createGraph()
    const smallView = createGraphView(small, scene, renderer)
    for (let i = 0; i < 12; i++) {
      // Spread wide enough on screen that declutter keeps every name.
      small.addNode({
        x: (i % 4) * 300 - 450,
        y: Math.floor(i / 4) * 260 - 260,
        z: -400 - 40 * i,
        label: `Idea ${i}`,
      })
    }
    smallView.sync()
    camera.position.set(0, 0, 300)
    camera.lookAt(0, 0, -600)
    camera.updateMatrixWorld(true)
    run(smallView)
    out.smallShown = smallView.labelsShown().filter((l) => l.kind === 'node').length
    out.floor = revealRange(1)
    // The old rule: nothing within 200 units, so nothing named.
    setLabelTarget(0)
    smallView.sync() // resets the labels, and with them the stretch
    run(smallView)
    out.smallShownFloor = smallView.labelsShown().filter((l) => l.kind === 'node').length
    setLabelTarget(DEFAULT_LABEL_TARGET)
    smallView.dispose()

    // --- A crowd of 400 named stars: the range gives way to the crowd. ---
    const crowd = createGraph()
    const crowdView = createGraphView(crowd, scene, renderer)
    let seed = 7
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
    for (let i = 0; i < 400; i++) {
      crowd.addNode({
        x: rand() * 500,
        y: rand() * 400,
        z: -200 - Math.abs(rand()) * 1500,
        label: `Star ${i}`,
      })
    }
    crowdView.sync()
    run(crowdView, 120)
    out.crowdShown = crowdView.labelsShown().filter((l) => l.kind === 'node').length
    crowdView.dispose()

    // --- Heat: a hub with 12 leaves, one link drawn edge-on to read. ---
    const hubMap = createGraph()
    const hubView = createGraphView(hubMap, scene, renderer)
    const hub = hubMap.addNode({ x: -120, y: 0, z: 0 })
    const leaf = hubMap.addNode({ x: 120, y: 0, z: 0 })
    hubMap.addEdge(hub.id, leaf.id)
    // The rest of the spokes point away from the camera, out of the way.
    for (let i = 0; i < 11; i++) {
      const spoke = hubMap.addNode({ x: -120, y: Math.cos(i) * 60, z: -400 - 30 * i })
      hubMap.addEdge(hub.id, spoke.id)
    }
    hubView.sync()
    camera.position.set(0, 0, 220)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    run(hubView, 30)
    out.heat = [hubMap.heatOf(hub.id), hubMap.heatOf(leaf.id)]
    // Lines only, onto black: layer 0 is the lines and motes, stars live elsewhere.
    const lines = scene.getObjectByName('edges')
    scene.getObjectByName('edge-drift').layers.set(7)
    const colourAt = (worldX) => {
      renderer.render(scene, camera)
      const p = new THREE.Vector3(worldX, 0, 0).project(camera)
      const x = Math.round((p.x * 0.5 + 0.5) * W)
      const y = Math.round((p.y * 0.5 + 0.5) * H)
      // The brightest pixel in a small column across the line.
      let best = [0, 0, 0]
      const buf = new Uint8Array(4)
      for (let dy = -3; dy <= 3; dy++) {
        gl.readPixels(x, y + dy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf)
        if (buf[0] + buf[1] + buf[2] > best[0] + best[1] + best[2]) best = [buf[0], buf[1], buf[2]]
      }
      return best
    }
    out.visibleLines = lines.visible
    out.hubEnd = colourAt(-70)
    out.leafEnd = colourAt(70)
    hubView.setHeat(false, { instant: true })
    out.hubEndOff = colourAt(-70)
    hubView.dispose()
    return out
  }, threeUrl)

  expect.soft(r.floor, 'the floor is the old 200 units').toBe(200)
  expect.soft(r.smallShown, 'a 12-star map names all twelve from 700+ units').toBe(12)
  expect.soft(r.smallShownFloor, 'with the stretch off, none of them (the old rule)').toBe(0)
  expect
    .soft(r.crowdShown, 'a 400-star crowd names a readable handful, not all 400')
    .toBeGreaterThanOrEqual(15)
  expect.soft(r.crowdShown, 'a 400-star crowd names a readable handful, not all 400').toBeLessThan(120)
  expect.soft(r.heat[0], 'the 12-link hub is hot').toBeGreaterThan(0.95)
  expect.soft(r.heat[1], 'its one-link leaf is cool').toBeLessThan(0.4)
  expect.soft(r.visibleLines, 'lines drawn').toBe(true)
  // Hot is red over blue; cool is blue over red.
  expect.soft(r.hubEnd[0] > r.hubEnd[2], `hub end is warm: ${r.hubEnd}`).toBe(true)
  expect.soft(r.leafEnd[2] > r.leafEnd[0], `leaf end is cool: ${r.leafEnd}`).toBe(true)
  expect.soft(r.hubEndOff[2] > r.hubEndOff[0], `heat off: hub end is plain blue: ${r.hubEndOff}`).toBe(true)
  expect.soft(errors, 'no console errors or warnings').toEqual([])
})

test('click-to-focus, the type ring, a nexus, and splitting a link', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  await installGestures(page)

  // n1 ahead, n2 to its right, linked; n3 further right, on its own.
  await t(page, 'doubleClick()')
  await settle(page)
  await t(page, 'look(150, 0)')
  await settle(page)
  await t(page, 'doubleClick()')
  await settle(page)
  await t(page, 'look(150, 0)')
  await settle(page)
  await t(page, 'doubleClick()')
  await settle(page)
  await t(page, 'look(-300, 0)')
  await settle(page)
  await pickMenu(page, 0, -60) // Connect
  await t(page, 'look(150, 0)')
  await settle(page)
  await t(page, 'click()')
  await settle(page)
  expect.soft(await t(page, 'hud()'), 'n1 — n2 linked').toBe('node n2 · 1 links')
  expect.soft(await t(page, 'shown()'), 'hovering a star puts nothing on screen').toBe('')

  // Click n2: focus. Off it, the HUD says what is focused.
  await t(page, 'click()')
  await settle(page)
  await t(page, 'look(0, -80)')
  await settle(page)
  expect
    .soft(await t(page, 'hud()'), 'focus shown on the HUD')
    .toBe('focus n2 · 1 connection · click empty space to clear')
  expect
    .soft(await t(page, 'shown()'), 'the screen says only how to clear it')
    .toBe('focused · click empty space to clear')
  // Empty space clears it.
  await t(page, 'click()')
  await settle(page)
  expect
    .soft(await t(page, 'hud()'), 'a click on empty space clears the focus')
    .toBe('map.plm · unsaved · 3 nodes · 1 edges')
  expect.soft(await t(page, 'shown()'), 'and the screen goes quiet').toBe('')
  await t(page, 'look(0, 80)')
  await settle(page)

  // H switches heat off and on.
  await page.keyboard.press('h')
  await settle(page)
  expect.soft(await t(page, 'hud()'), 'H: heat off').toContain('connection heat off')
  await page.keyboard.press('h')
  await settle(page)
  expect.soft(await t(page, 'hud()'), 'H: heat back on').toContain('connection heat on')

  // n2 through the type ring: Nexus is straight down there.
  await pickMenu(page, 0, 60) // Type…
  expect
    .soft(JSON.stringify(await t(page, 'wedges()')), 'type ring on a star')
    .toBe(JSON.stringify(['Star ✓', 'Core', 'Nexus', 'Back']))
  await t(page, 'look(0, 60)')
  expect.soft(await t(page, 'armed()'), 'down arms Nexus').toBe('Nexus')
  await t(page, 'rightUp()')
  await settle(page, 400) // it shrinks to half; the crosshair is on its centre
  expect.soft(await t(page, 'hud()'), 'n2 is a nexus joining one star').toMatch(/^nexus n2 · joins 1/)
  await page.keyboard.press('Control+z')
  await settle(page, 400)
  expect.soft(await t(page, 'hud()'), 'undo makes it a star again').toMatch(/^node n2 · 1 links/)

  // Halfway back to n1 the crosshair is on the link: split it.
  await t(page, 'look(-75, 0)')
  await settle(page)
  expect.soft(await t(page, 'hud()'), 'aimed at the link').toMatch(/^edge n1 — n2/)
  const linkMenu = await pickMenu(page, 60, 0)
  expect
    .soft(JSON.stringify(linkMenu.labels), 'link menu: edit up, split right, delete down, focus left')
    .toBe(JSON.stringify(['Edit', 'Add nexus', 'Delete', 'Focus']))
  expect.soft(linkMenu.armed, 'right arms Add nexus').toBe('Add nexus')
  await settle(page, 400)
  expect
    .soft(await t(page, 'hud()'), 'a nexus at the midpoint, joining both stars')
    .toMatch(/^nexus n4 · joins 2/)
  await t(page, 'look(0, -80)')
  await settle(page)
  expect
    .soft(await t(page, 'hud()'), 'one link became two')
    .toMatch(/^map\.plm · unsaved · 4 nodes · 2 edges/)
  await page.keyboard.press('Control+z')
  await settle(page)
  expect.soft(await t(page, 'hud()'), 'undo puts the link back').toContain('3 nodes · 1 edges')
  expect.soft(errors, 'no console errors or warnings').toEqual([])
})
