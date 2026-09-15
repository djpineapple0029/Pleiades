// Ported from tests/_rescued/e2e/e2e_password_save.mjs, written 2026-09-14 for
// the password-system-rework branch.
//
// Verifies the mouse-clickable Save/Cancel buttons and that a blank-password
// save produces a real ATLM v2 mode-0 (unencrypted) container — the
// no-password warn-once step was removed on request (a blank password now
// saves immediately, no confirmation round).
//
// Headed on purpose: pointer lock does not work headless.
import { test, expect } from '@playwright/test'

test('no-password save: clickable buttons, real ATLM v2 mode-0 file', async ({ page }) => {
  const consoleErrors = []
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto('/')
  await page.bringToFront()

  // --- lock the pointer (click-to-fly) ---
  await page.mouse.click(640, 400)
  await page.waitForTimeout(300)
  expect.soft(await page.evaluate(() => document.pointerLockElement !== null), 'pointer lock acquired after click').toBe(true)

  // --- Ctrl+S: first save, blank password saves immediately (no warn-once) ---
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(150)
  expect.soft(await page.evaluate(() => !document.getElementById('editor').hidden), 'editor panel opens on first Ctrl+S').toBe(true)
  expect.soft(await page.evaluate(() => document.pointerLockElement === null), 'pointer lock released during the save panel (mouse-usable)').toBe(true)

  // Leave filename/password/confirm all blank, commit via the button
  // (mouse-first workflow) — one submit is enough, no confirmation round.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('.editor-button--primary'),
  ])
  const path = await download.path()
  const { readFileSync } = await import('node:fs')
  const bytes = readFileSync(path)
  expect.soft(bytes[0] === 0x41 && bytes[4] === 2 && bytes[5] === 0, 'no-password save produced an ATLM v2 file').toBe(true)

  await page.waitForTimeout(200)
  expect.soft(await page.evaluate(() => document.getElementById('editor').hidden), 'editor panel closes after save').toBe(true)

  // --- Tab-focus-trap check: spawn + edit, confirm the radial menu opens ---
  await page.mouse.dblclick(640, 400)
  await page.waitForTimeout(200)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(640, 340)
  await page.mouse.up({ button: 'right' })
  await page.waitForTimeout(200)
  expect.soft(await page.evaluate(() => !document.getElementById('radial-menu').hidden), 'radial menu opens after right-click+drag').toBe(true)

  expect.soft(consoleErrors, 'no console.error output').toEqual([])
  expect.soft(pageErrors, 'no page errors').toEqual([])
})
