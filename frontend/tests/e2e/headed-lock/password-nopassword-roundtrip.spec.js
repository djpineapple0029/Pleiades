// Ported from tests/_rescued/e2e/e2e_password_nopassword_roundtrip.mjs,
// written 2026-09-14 for the password-system-rework branch.
//
// The editor's Tab-focus-trap (never escapes the panel, even mid-cycle) and
// Enter-advances-to-next-field behavior, plus a full spawn -> save (no
// password) -> reopen in a fresh tab round trip, asserting no password
// prompt ever appears and the node survives.
//
// Headed on purpose: pointer lock does not work headless.
import { test, expect } from '@playwright/test'

const ctrlS = (page, extra = {}) =>
  page.evaluate(
    (extra) => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', key: 's', ctrlKey: true, bubbles: true, ...extra })),
    extra,
  )

test('editor focus trap, and a no-password save/reopen round trip', async ({ page, context }) => {
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto('/')
  await page.bringToFront()
  await page.mouse.click(640, 400)
  await page.waitForTimeout(300)

  // --- Tab/Enter focus-trap checks, via Ctrl+Shift+S (always prompts) ---
  await ctrlS(page, { shiftKey: true })
  await page.waitForTimeout(200)
  expect.soft(await page.evaluate(() => !document.getElementById('editor').hidden), 'editor open for save-as').toBe(true)

  const firstFieldLabel = await page.evaluate(() => document.querySelectorAll('.editor-row span')[0]?.textContent)
  expect.soft(firstFieldLabel, 'first field is filename').toBe('File name')

  for (let i = 0; i < 3; i++) await page.keyboard.press('Tab')
  await page.waitForTimeout(50)
  expect.soft(
    await page.evaluate(() => document.activeElement === document.querySelector('.editor-row input')),
    'Tab cycles through all 3 fields and back into the panel (no escape)',
  ).toBe(true)

  await page.keyboard.press('Enter')
  await page.waitForTimeout(50)
  expect.soft(await page.evaluate(() => !document.getElementById('editor').hidden), 'Enter on a non-last field does not submit').toBe(true)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  expect.soft(await page.evaluate(() => document.getElementById('editor').hidden), 'Escape cancels the panel').toBe(true)

  // --- Full round trip: spawn a node, save with no password, reopen with no prompt ---
  // Escape (above) dropped pointer lock, same as it always has — reacquire it
  // the same way a real user would, with a plain click, before spawning.
  await page.mouse.click(640, 400)
  await page.waitForTimeout(300)
  await page.mouse.dblclick(640, 400)
  await page.waitForTimeout(200)
  const nodesBefore = await page.evaluate(() => document.getElementById('hud')?.textContent)
  expect.soft(/^node n1/.test(nodesBefore ?? ''), 'a node was spawned').toBe(true)

  await ctrlS(page)
  await page.waitForTimeout(150)
  await page.click('.editor-button--primary') // 1st blank submit -> warning
  await page.waitForTimeout(100)
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.editor-button--primary')]) // 2nd -> saves
  const savedPath = await download.path()
  await page.waitForTimeout(200)

  // New tab, fresh app state, open the file we just saved
  const page2 = await context.newPage()
  const page2Errors = []
  page2.on('pageerror', (e) => page2Errors.push(String(e)))
  await page2.goto('/')
  await page2.bringToFront()
  await page2.mouse.click(640, 400)
  await page2.waitForTimeout(300)

  const [chooser] = await Promise.all([
    page2.waitForEvent('filechooser'),
    page2.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', key: 'o', ctrlKey: true, bubbles: true }))),
  ])
  await chooser.setFiles(savedPath)
  await page2.waitForTimeout(300)

  expect.soft(await page2.evaluate(() => document.getElementById('editor').hidden), 'opening a no-password file never shows a password prompt').toBe(true)

  const hudAfterOpen = await page2.evaluate(() => document.getElementById('hud')?.textContent)
  expect.soft(/\b1 nodes\b/.test(hudAfterOpen ?? ''), 'the reopened map has the node back').toBe(true)

  expect.soft(pageErrors, 'no page errors on the saving tab').toEqual([])
  expect.soft(page2Errors, 'no page errors on the reopening tab').toEqual([])
})
