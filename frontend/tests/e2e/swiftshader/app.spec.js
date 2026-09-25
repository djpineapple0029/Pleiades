// Ported from tests/_rescued/e2e/e2e_app.mjs.
//
// The whole app, driven through its own input handlers: spawn a chain, link
// it with the radial menu, mark a node core from the menu's bottom wedge,
// and see the pick radius grow under the real crosshair; name a node
// in place through the Edit wedge and see its label drawn under it. Pointer lock is
// faked (see helpers/gestures.js) — chrome-headless-shell cannot take a
// real one.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, installGestures, t, settle, pickMenu } from '../helpers/gestures.js'

test('the whole app, driven through its own input handlers', async ({ page }, testInfo) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  await installGestures(page)

  expect.soft(await page.evaluate(() => !document.getElementById('crosshair').hidden), 'crosshair up under faked lock').toBe(true)

  // Three nodes, each 0.3 rad to the right of the last.
  await t(page, 'doubleClick()'); await settle(page)
  await t(page, 'look(150, 0)'); await settle(page)
  await t(page, 'doubleClick()'); await settle(page)
  await t(page, 'look(150, 0)'); await settle(page)
  await t(page, 'doubleClick()'); await settle(page)
  expect.soft((await t(page, 'hud()')).startsWith('node n3'), 'three nodes spawned').toBe(true)

  // n1 -> n2 -> n3 via the menu's top wedge.
  await t(page, 'look(-300, 0)'); await settle(page)
  expect.soft((await t(page, 'hud()')).startsWith('node n1'), 'aimed at n1').toBe(true)
  const connectMenu = await pickMenu(page, 0, -60)
  // Five wedges now: the "Move" node-move affordance shipped after this
  // suite was first captured (see the "Radial wheel: map menu, auto-resizing
  // wedges, and Move" commit) — Connect/Edit/Move/Mark core/Delete, evenly
  // spaced at 72 degrees apart starting from straight up.
  expect.soft(JSON.stringify(connectMenu.labels), 'node menu has five wedges with Mark core second from the bottom')
    .toBe(JSON.stringify(['Connect', 'Edit', 'Move', 'Mark core', 'Delete']))
  expect.soft(connectMenu.armed, 'up arms Connect').toBe('Connect')
  await t(page, 'look(150, 0)'); await settle(page)
  await t(page, 'click()'); await settle(page)
  await pickMenu(page, 0, -60)
  await t(page, 'look(150, 0)'); await settle(page)
  await t(page, 'click()'); await settle(page)
  expect.soft((await t(page, 'hud()')).startsWith('node n3 · 1 links'), 'chain linked').toBe(true)

  // Aim at n1, then a little above it: off a plain node, onto a core one.
  await t(page, 'look(-300, 0)'); await settle(page)
  expect.soft(await t(page, 'hud()'), 'back on n1, not core').toBe('node n1 · 1 links')
  const UP = -50 // 0.10 rad: ~9 units at 90, outside a plain 5, inside a core 11.25
  await t(page, `look(0, ${UP})`); await settle(page)
  expect.soft(await t(page, 'hud()'), 'above plain n1 is empty space').toBe('map.atlasmap · unsaved · 3 nodes · 2 edges')
  await t(page, `look(0, ${-UP})`); await settle(page)
  await page.screenshot({ path: testInfo.outputPath('app_before.png') })

  const coreMenu = await pickMenu(page, 0, 60)
  expect.soft(coreMenu.armed, 'down arms Mark core').toBe('Mark core')
  expect.soft(await page.evaluate(() => document.getElementById('radial-menu').hidden), 'menu closed after release').toBe(true)
  expect.soft(await t(page, 'hud()'), 'HUD marks n1 core').toBe('node n1 · 1 links · core')
  await settle(page, 700) // easing
  await page.screenshot({ path: testInfo.outputPath('app_after.png') })
  await t(page, `look(0, ${UP})`); await settle(page)
  expect.soft(await t(page, 'hud()'), 'same offset now lands on the grown core').toBe('node n1 · 1 links · core')
  await t(page, `look(0, ${-UP})`); await settle(page)

  const unmark = await pickMenu(page, 0, 60)
  expect.soft(unmark.labels[3] === 'Unmark core' && unmark.armed === 'Unmark core', 'core node offers Unmark core').toBe(true)
  expect.soft(await t(page, 'hud()'), 'HUD drops core').toBe('node n1 · 1 links')
  await settle(page, 700)
  await t(page, `look(0, ${UP})`); await settle(page)
  expect.soft(await t(page, 'hud()'), 'shrunk back: offset misses again').toBe('map.atlasmap · unsaved · 3 nodes · 2 edges')
  await t(page, `look(0, ${-UP})`); await settle(page)

  // Name n1 through the Edit wedge: its label appears under it, in the hover
  // colour, since the crosshair is on it.
  const W = 1280, H = 720
  // Label pixels where the callout puts the name: down and to the right of
  // the targeted star, starting right of its hover ring (also amber) so the
  // ring is never counted as text. A plain star is 1x now, so the name sits
  // higher than it did when one link made it 1.15x.
  const labelPixels = async () => {
    const png = await page.screenshot({ clip: { x: W / 2 + 40, y: H / 2 + 28, width: 160, height: 30 } })
    return page.evaluate(async (data) => {
      const img = new Image()
      await new Promise((done) => { img.onload = done; img.src = `data:image/png;base64,${data}` })
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0)
      const px = ctx.getImageData(0, 0, c.width, c.height).data
      let amber = 0
      for (let i = 0; i < px.length; i += 4) if (px[i] > 190 && px[i + 1] > 140 && px[i + 1] < 215 && px[i + 2] < 150) amber++
      return amber
    }, png.toString('base64'))
  }
  // Motion off first, through the map menu's More ring: the dust rivers glow
  // warm by a star, pass the same amber test, and move between the two
  // readings. With motion off they aren't drawn at all (and the star pulse
  // holds still), so what changes in the band is the label alone.
  await t(page, `look(0, ${UP})`); await settle(page)
  const mapMenu = await pickMenu(page, -52, -30) // More…, up and to the left
  expect.soft(mapMenu.armed, 'up-left on the map menu arms More…').toBe('More…')
  expect.soft((await t(page, 'wedges()'))[0], 'More ring offers Motion first').toBe('Motion: on')
  await t(page, 'look(52, -90)'); await settle(page) // from More… back across to the top
  expect.soft(await t(page, 'armed()'), 'up arms Motion').toBe('Motion: on')
  await t(page, 'rightUp()'); await settle(page)
  await t(page, `look(0, ${-UP})`); await settle(page)
  expect.soft(await t(page, 'hud()'), 'back on n1 after switching motion off').toBe('node n1 · 1 links')

  // Measured, not assumed zero: the warm-tinted neighbour's rays reach into
  // this band and pass the amber test too, so the name is what gets added.
  const amberBefore = await labelPixels()
  const editMenu = await pickMenu(page, 60, 0)
  expect.soft(editMenu.armed, 'right arms Edit').toBe('Edit')
  await settle(page)
  expect.soft(
    await page.evaluate(() => document.getElementById('editor').hidden && document.activeElement?.classList.contains('title-edit-input')),
    'renaming in place: no panel, the hidden title field focused',
  ).toBe(true)
  await page.keyboard.type('Alpha')
  await page.keyboard.press('Enter')
  await settle(page, 300)
  // Renaming happens on the star itself, so pointer lock is never let go.
  expect.soft(await t(page, 'locked()'), 'still locked after renaming in place').toBe(true)
  expect.soft(await t(page, 'hud()'), 'HUD uses the new label').toBe('node Alpha · 1 links')
  const amber = await labelPixels()
  expect.soft(amber - amberBefore, 'label drawn under the targeted node, in the hover colour').toBeGreaterThan(30)
  await page.screenshot({ path: testInfo.outputPath('app_label.png') })

  // Balance with a core in the graph, then everything still picks.
  await pickMenu(page, 0, 60)
  await page.keyboard.press('b')
  await settle(page)
  const started = (await t(page, 'hud()')).includes('balancing')
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && (await t(page, 'hud()')).includes('balancing')) await page.waitForTimeout(250)
  await settle(page)
  const hudAfterBalance = await t(page, 'hud()')
  expect.soft(started && !hudAfterBalance.includes('balancing'), 'balance runs with a core node and finishes').toBe(true)
  await page.screenshot({ path: testInfo.outputPath('app_balanced.png') })

  // Tab into the overview and back, through the real key handler.
  await page.keyboard.press('Tab')
  await settle(page)
  expect.soft(await t(page, 'locked()'), 'Tab releases pointer lock').toBe(false)
  expect.soft((await t(page, 'hud()')).startsWith('overview · 3 nodes · 2 edges · Tab to fly'), 'overview HUD, with the way out in it').toBe(true)
  expect.soft(await t(page, 'overlay()'), 'no click-to-fly overlay over the overview').toBe(false)
  expect.soft(await t(page, 'crosshair()'), 'no crosshair in the overview').toBe(false)
  await settle(page, 700) // the flight out to the fitted view
  await page.screenshot({ path: testInfo.outputPath('app_overview.png') })
  expect.soft(await page.evaluate(async () => {
    const before = document.getElementById('hud').textContent
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', key: 'b', bubbles: true }))
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    return document.getElementById('hud').textContent !== before && document.getElementById('hud').textContent.includes('balancing')
  }), 'B still balances from the overview').toBe(true)
  const overviewDeadline = Date.now() + 60000
  while (Date.now() < overviewDeadline && (await t(page, 'hud()')).includes('balancing')) await page.waitForTimeout(250)

  await page.keyboard.press('Tab')
  await settle(page)
  expect.soft(await t(page, 'locked()'), 'Tab takes the lock back').toBe(true)
  expect.soft(await t(page, 'crosshair()'), 'crosshair back').toBe(true)
  expect.soft(await t(page, 'overlay()'), 'overlay stays down').toBe(false)
  expect.soft((await t(page, 'hud()')).startsWith('overview'), 'HUD back off the overview').toBe(false)

  expect.soft(errors, 'no console errors or warnings').toEqual([])
})
