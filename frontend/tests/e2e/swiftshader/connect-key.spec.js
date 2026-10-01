// C connects two stars without the radial menu: C on one, C on the other.
// C anywhere else mid-link cancels, like the path key.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, installGestures, t, settle } from '../helpers/gestures.js'

test('C on one star, then C on another, links them', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  await installGestures(page)

  // n1 ahead, n2 to its right, n3 further right; none linked.
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

  // C on n1 starts a link; the HUD says how to finish it.
  await page.keyboard.press('c')
  await settle(page)
  expect
    .soft(await t(page, 'shown()'), 'connecting from n1')
    .toBe('click or C on a star to link it · right-click cancels · from n1')

  // C on n2 makes it.
  await t(page, 'look(150, 0)')
  await settle(page)
  await page.keyboard.press('c')
  await settle(page)
  expect.soft(await t(page, 'hud()'), 'n1 — n2 linked').toBe('node n2 · 1 links')
  expect.soft(await t(page, 'shown()'), 'and the link mode is over').toBe('')

  // C on n2 again, then C on empty space: cancelled, nothing new.
  await page.keyboard.press('c')
  await settle(page)
  await t(page, 'look(0, -80)')
  await settle(page)
  await page.keyboard.press('c')
  await settle(page)
  expect.soft(await t(page, 'shown()'), 'C off a star cancels').toBe('')
  expect.soft(await t(page, 'hud()'), 'still one link').toContain('3 nodes · 1 edges')

  // C on a star mid-link to itself cancels too.
  await t(page, 'look(0, 80)')
  await settle(page)
  await page.keyboard.press('c')
  await settle(page)
  await page.keyboard.press('c')
  await settle(page)
  expect.soft(await t(page, 'shown()'), 'C on the same star cancels').toBe('')
  expect.soft(await t(page, 'hud()'), 'n2 still has its one link').toBe('node n2 · 1 links')

  // Undo takes the C-made link back like any other.
  await page.keyboard.press('Control+z')
  await settle(page)
  expect.soft(await t(page, 'hud()'), 'undo removes the link').toBe('node n2 · 0 links')
  expect.soft(errors, 'no console errors or warnings').toEqual([])
})
