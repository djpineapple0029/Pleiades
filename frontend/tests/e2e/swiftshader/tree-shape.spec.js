// The layout-shape ring (tree_shape, T), driven through the app's own input
// handlers the way looks.spec.js drives V: hold T, move the mouse onto a
// shape, let go. Checks the pick lands (and balances), the current shape is
// ticked, and that a quick tap or a right-button release while T is held
// changes nothing.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, installGestures, t, settle } from '../helpers/gestures.js'

async function holdT(page, dx, dy) {
  await page.keyboard.down('t')
  await settle(page)
  const wedges = await t(page, 'wedges()')
  await t(page, `look(${dx}, ${dy})`)
  await settle(page)
  const armed = await t(page, 'armed()')
  return { wedges, armed }
}

test('hold T to pick a layout shape', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  await installGestures(page)

  // Down and right: Flat. The ring stays open through a right-button release.
  const flat = await holdT(page, 52, 30)
  expect(flat.wedges, 'starts on Cone').toEqual(['Cone ✓', 'Flat', 'Off'])
  expect(flat.armed).toBe('Flat')
  await t(page, 'rightUp()')
  await settle(page)
  expect(await t(page, 'wedges()'), 'still open after a right-button release').toHaveLength(3)
  await page.keyboard.up('t')
  await settle(page)
  expect(await t(page, 'wedges()'), 'closed on release').toEqual([])
  expect(await t(page, 'hud()')).toContain('layout: flat')

  // A tap with no movement picks nothing: Flat is still the ticked one.
  await page.keyboard.press('t')
  await settle(page)
  const off = await holdT(page, -52, 30)
  expect(off.wedges, 'a tap changes nothing').toEqual(['Cone', 'Flat ✓', 'Off'])

  // Down and left: Off.
  expect(off.armed).toBe('Off')
  await page.keyboard.up('t')
  await settle(page)
  expect(await t(page, 'hud()')).toContain('layout: off (no tree)')
  expect((await holdT(page, 0, 0)).wedges).toEqual(['Cone', 'Flat', 'Off ✓'])
  await page.keyboard.up('t')
  expect(errors).toEqual([])
})
