// `/` search: find a star by name, fly there, Backspace back, and the same
// from the Tab overview. Pointer lock is faked (helpers/gestures.js).
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, installGestures, t, settle } from '../helpers/gestures.js'

const panel = (page) => page.evaluate(() => {
  const root = document.getElementById('search')
  return {
    open: !root.hidden,
    focus: document.activeElement?.className ?? '',
    rows: [...root.querySelectorAll('.search-name')].map((el) => el.textContent),
    selected: root.querySelector('.search-row--selected .search-name')?.textContent ?? null,
    marked: [...root.querySelectorAll('.search-name mark')].map((el) => el.textContent),
    foot: root.querySelector('.search-foot').hidden ? null : root.querySelector('.search-foot').textContent,
  }
})

/** Spawns a star straight ahead and names it in place. */
async function spawnNamed(page, name) {
  await t(page, 'doubleClick()'); await settle(page)
  await page.keyboard.press('Enter'); await settle(page)
  await page.keyboard.type(name)
  await page.keyboard.press('Enter'); await settle(page, 200)
}

// Past the 0.6 s flight, with SwiftShader frames to spare.
const FLIGHT_WAIT = 1200

test('search: find, fly there, fly back, and from the overview', async ({ page }, testInfo) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  await installGestures(page)

  // Empty map: nothing to search.
  await page.keyboard.press('/'); await settle(page)
  expect.soft((await panel(page)).open, 'no panel on an empty map').toBe(false)
  expect.soft(await t(page, 'hud()'), 'says why').toContain('no stars yet')

  // Three stars in three directions, about 90° apart (0.002 rad per px).
  await spawnNamed(page, 'Vega')
  await t(page, 'look(785, 0)'); await settle(page)
  await spawnNamed(page, 'Altair')
  await t(page, 'look(785, 0)'); await settle(page)
  await spawnNamed(page, 'Deneb')
  expect.soft(await t(page, 'hud()'), 'last one named and targeted').toBe('node Deneb · 0 links')

  // Look at open space, away from all three.
  await t(page, 'look(785, 0)'); await settle(page)
  const home = await t(page, 'hud()')
  expect.soft(home.startsWith('node '), 'aimed at open space').toBe(false)

  // --- / opens the field, keeping the lock ---
  await page.keyboard.press('/'); await settle(page)
  let p = await panel(page)
  expect.soft(p.open, '/ opens the panel').toBe(true)
  expect.soft(p.focus, 'field focused').toContain('search-input')
  expect.soft(await t(page, 'locked()'), 'lock kept').toBe(true)
  expect.soft(await t(page, 'hud()'), 'HUD says how to drive it').toContain('Enter fly there')

  await page.keyboard.type('e'); await settle(page)
  p = await panel(page)
  // Vega and Deneb both contain an "e"; neither starts with one, so the tie
  // falls to shorter name (both 0 links, no cores): Vega, then Deneb.
  expect.soft(p.rows, 'substring matches, ranked').toEqual(['Vega', 'Deneb'])
  expect.soft(p.marked, 'matched letter highlighted').toEqual(['e', 'e'])

  await page.keyboard.press('ArrowDown'); await settle(page)
  expect.soft((await panel(page)).selected, 'down moves the selection').toBe('Deneb')
  await page.keyboard.press('ArrowDown'); await settle(page)
  expect.soft((await panel(page)).selected, 'and wraps').toBe('Vega')

  await page.keyboard.press('Backspace')
  await page.keyboard.type('zzz'); await settle(page)
  p = await panel(page)
  expect.soft(p.rows, 'no rows for a miss').toEqual([])
  expect.soft(p.foot, 'says so').toBe('no star by that name')
  await page.keyboard.press('Enter'); await settle(page)
  expect.soft((await panel(page)).open, 'Enter on a miss keeps the panel open').toBe(true)

  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace')
  await page.keyboard.type('ALT'); await settle(page)
  expect.soft((await panel(page)).rows, 'case-insensitive prefix').toEqual(['Altair'])
  await page.screenshot({ path: testInfo.outputPath('search_open.png') })

  // --- Enter flies there ---
  await page.keyboard.press('Enter'); await settle(page)
  expect.soft((await panel(page)).open, 'panel closes on pick').toBe(false)
  expect.soft(await t(page, 'hud()'), 'HUD during the flight').toBe('flying to Altair')
  await settle(page, FLIGHT_WAIT)
  expect.soft(await t(page, 'hud()'), 'landed with Altair under the crosshair').toBe('node Altair · 0 links')
  expect.soft(await t(page, 'locked()'), 'still locked').toBe(true)
  await page.screenshot({ path: testInfo.outputPath('search_arrived.png') })

  // --- Backspace flies back ---
  await page.keyboard.press('Backspace'); await settle(page, FLIGHT_WAIT)
  expect.soft(await t(page, 'hud()'), 'back where the search started').toBe(home)
  await page.keyboard.press('Backspace'); await settle(page)
  expect.soft(await t(page, 'hud()'), 'nothing left to go back to').toContain('nothing to fly back to')

  // --- Ctrl/Cmd+F opens it too; Esc closes and nothing moves ---
  await page.keyboard.press('ControlOrMeta+f'); await settle(page)
  expect.soft((await panel(page)).open, 'Ctrl/Cmd+F opens the panel').toBe(true)
  await page.keyboard.type('veg'); await settle(page)
  await page.keyboard.press('Escape'); await settle(page, 200)
  expect.soft((await panel(page)).open, 'Esc closes').toBe(false)
  // A prefix: the transient "nothing to fly back to" may still be showing.
  expect.soft((await t(page, 'hud()')).startsWith(home), 'Esc went nowhere').toBe(true)

  // --- From the overview: pick, leave the orbit, fly, lock again ---
  await page.keyboard.press('Tab'); await settle(page, 800)
  expect.soft(await t(page, 'locked()'), 'overview released the lock').toBe(false)
  await page.keyboard.press('/'); await settle(page)
  expect.soft((await panel(page)).open, '/ works in the overview').toBe(true)
  await page.keyboard.type('deneb'); await settle(page, 500)
  // Look frame: Deneb lit, Vega and Altair dimmed.
  await page.screenshot({ path: testInfo.outputPath('search_overview_dim.png') })
  await page.keyboard.press('Enter'); await settle(page, FLIGHT_WAIT)
  expect.soft(await t(page, 'locked()'), 'back in flight, locked').toBe(true)
  expect.soft(await t(page, 'hud()'), 'landed on Deneb').toBe('node Deneb · 0 links')

  expect.soft(errors, 'no console errors').toEqual([])
})
