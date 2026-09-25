// Undo/redo (V2.md F1), driven through the app's own input handlers and
// keyboard chords — no module internals. Positions are checked the way a
// user would: whether the node is back under the crosshair.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, installGestures, t, settle, pickMenu } from '../helpers/gestures.js'

// Delete is the fifth of five wedges, 288° clockwise from straight up.
const DELETE = [-57, -19]

test('undo and redo through the keyboard', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  await installGestures(page)

  // n1 straight ahead, n2 to its right, linked.
  await t(page, 'doubleClick()')
  await settle(page)
  await t(page, 'look(150, 0)')
  await settle(page)
  await t(page, 'doubleClick()')
  await settle(page)
  await t(page, 'look(-150, 0)')
  await settle(page)
  await pickMenu(page, 0, -60) // Connect
  await t(page, 'look(150, 0)')
  await settle(page)
  await t(page, 'click()')
  await settle(page)
  await t(page, 'look(-150, 0)')
  await settle(page)
  expect(await t(page, 'hud()')).toBe('node n1 · 1 links')

  // Delete n1: it and its link go.
  const del = await pickMenu(page, ...DELETE)
  expect(del.armed).toBe('Delete')
  await settle(page)
  expect(await t(page, 'hud()')).toBe('map.atlasmap · unsaved · 1 nodes · 0 edges')

  // Undo: same id, same place, link back.
  await page.keyboard.press('Control+z')
  await settle(page)
  expect(await t(page, 'hud()')).toBe('node n1 · 1 links · undo: delete node n1 (1 link)')

  // Redo deletes it again; a second redo has nothing left.
  await page.keyboard.press('Control+Shift+z')
  await settle(page)
  expect(await t(page, 'hud()')).toBe(
    'map.atlasmap · unsaved · 1 nodes · 0 edges · redo: delete node n1 (1 link)',
  )
  await page.keyboard.press('Control+y')
  await settle(page)
  expect(await t(page, 'hud()')).toContain('nothing to redo')
  await page.keyboard.press('Control+z')
  await settle(page)
  expect(await t(page, 'hud()')).toMatch(/^node n1 · 1 links/)

  // Balance moves n1 out from under the crosshair; undo puts it back.
  await page.keyboard.press('b')
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && (await t(page, 'hud()')).includes('balancing'))
    await page.waitForTimeout(250)
  await settle(page)
  expect(await t(page, 'hud()'), 'balance moved n1 away').not.toMatch(/^node n1/)
  await page.keyboard.press('Control+z')
  await settle(page)
  expect(await t(page, 'hud()')).toBe('node n1 · 1 links · undo: balance')

  // Undo all the way back to an empty map — the fresh, never-saved state
  // counts as clean again.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Control+z')
    await settle(page)
  }
  await page.keyboard.press('Control+z')
  await settle(page)
  expect(await t(page, 'hud()')).toBe('map.atlasmap · 0 nodes · 0 edges · nothing to undo')
  expect(await page.title()).toBe('map.atlasmap — AtlasMap')

  expect(errors).toEqual([])
})
