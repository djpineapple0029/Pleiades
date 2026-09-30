// Looks (src/looks.js), driven through the app's own input handlers: hold V,
// move the mouse onto a look, let go. Checks the switch lands, is remembered
// across a reload, and that a quick tap or a right-button release while V is
// held changes nothing.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, installGestures, t, settle } from '../helpers/gestures.js'

const lookNow = (page) => page.evaluate(() => document.documentElement.dataset.look)

async function holdV(page, dx, dy) {
  await page.keyboard.down('v')
  await settle(page)
  const wedges = await t(page, 'wedges()')
  await t(page, `look(${dx}, ${dy})`)
  await settle(page)
  const armed = await t(page, 'armed()')
  return { wedges, armed }
}

test('hold V to pick a look', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  await installGestures(page)
  expect(await lookNow(page), 'starts in Deep Space').toBe('deep-space')

  // Right: Deep Sea. The ring stays open through a right-button release.
  const sea = await holdV(page, 60, 0)
  expect(sea.wedges).toEqual(['Deep Space ✓', 'Deep Sea', 'Cyberspace', 'Minimal', 'Shallow Space'])
  expect(sea.armed).toBe('Deep Sea')
  await t(page, 'rightUp()')
  await settle(page)
  expect(await t(page, 'wedges()'), 'still open after a right-button release').toHaveLength(5)
  await page.keyboard.up('v')
  await settle(page, 500) // the dip to black and back
  expect(await lookNow(page)).toBe('deep-sea')
  expect(await t(page, 'wedges()'), 'closed on release').toEqual([])
  expect(await t(page, 'hud()')).toContain('look: Deep Sea')

  // A tap with no movement picks nothing.
  await page.keyboard.press('v')
  await settle(page, 500)
  expect(await lookNow(page), 'a tap changes nothing').toBe('deep-sea')

  // Down and right: Cyberspace, with its scanlines over the view.
  const cyber = await holdV(page, 35, 49)
  expect(cyber.armed).toBe('Cyberspace')
  await page.keyboard.up('v')
  await settle(page, 500)
  expect(await lookNow(page)).toBe('cyberspace')
  expect(
    await page.evaluate(() => getComputedStyle(document.getElementById('look-scan')).display),
    'scanlines on',
  ).toBe('block')

  // Down and left: Minimal, then remembered across a reload.
  const minimal = await holdV(page, -35, 49)
  expect(minimal.wedges[2], 'the current look is ticked').toBe('Cyberspace ✓')
  expect(minimal.armed).toBe('Minimal')
  await page.keyboard.up('v')
  await settle(page, 500)
  expect(await lookNow(page)).toBe('minimal')
  expect(
    await page.evaluate(() => getComputedStyle(document.getElementById('look-scan')).display),
    'scanlines off again',
  ).toBe('none')

  await page.reload()
  await page.waitForTimeout(1500)
  expect(await lookNow(page), 'remembered in this browser').toBe('minimal')
  expect(errors).toEqual([])
})
