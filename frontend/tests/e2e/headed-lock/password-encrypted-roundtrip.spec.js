// Ported from tests/_rescued/e2e/e2e_password_encrypted_roundtrip.mjs, written
// 2026-09-14 for the password-system-rework branch.
//
// A real password typed via keyboard through the shadow-hosted field
// (confirms it is NOT reachable via a light-DOM querySelector, the whole
// point of hiding it from password-manager extensions), wrong-password
// rejection and re-prompt, then a correct-password open with the node
// preserved.
//
// Headed on purpose: pointer lock does not work headless.
import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'

test('encrypted save/reopen: shadow-hosted password field, wrong/right password', async ({ page, context }) => {
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto('/')
  await page.bringToFront()
  await page.mouse.click(640, 400)
  await page.waitForTimeout(300)
  await page.mouse.dblclick(640, 400)
  await page.waitForTimeout(200)

  // Ctrl+S: first save. This time set an actual password.
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', key: 's', ctrlKey: true, bubbles: true })))
  await page.waitForTimeout(200)

  // Confirm the password field is a shadow-hosted input, invisible to a plain
  // querySelector('input[type=password]') from outside the module.
  const passwordFieldPierceable = await page.evaluate(() => document.querySelectorAll('input[type=password]').length)
  expect.soft(passwordFieldPierceable, 'password input is not reachable via a light-DOM query (closed shadow root)').toBe(0)

  // Type into filename, tab to password, type a password, tab to confirm, type it again, commit.
  await page.keyboard.type('secret-map')
  await page.keyboard.press('Tab')
  await page.keyboard.type('hunter2')
  await page.keyboard.press('Tab')
  await page.keyboard.type('hunter2')
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')])
  const savedPath = await download.path()
  await page.waitForTimeout(200)
  expect.soft(await page.evaluate(() => document.getElementById('editor').hidden), 'editor closed after committing a real password with Enter from the last field').toBe(true)

  const bytes = readFileSync(savedPath)
  expect.soft(bytes[4] === 2 && bytes[5] === 1, 'saved file is v2, mode 1 (encrypted)').toBe(true)

  // Reopen: wrong password first, then the right one.
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
  expect.soft(await page2.evaluate(() => !document.getElementById('editor').hidden), 'an encrypted file does show the password prompt').toBe(true)

  await page2.keyboard.type('wrong-password')
  await page2.keyboard.press('Enter')
  await page2.waitForTimeout(300)
  const note = await page2.evaluate(() => document.querySelector('.editor-note')?.textContent)
  expect.soft(Boolean(note) && /wrong password|altered/i.test(note ?? ''), 'wrong password re-prompts with an error note').toBe(true)

  await page2.keyboard.type('hunter2')
  await page2.keyboard.press('Enter')
  await page2.waitForTimeout(300)
  expect.soft(await page2.evaluate(() => document.getElementById('editor').hidden), 'correct password opens the file').toBe(true)
  const hud = await page2.evaluate(() => document.getElementById('hud')?.textContent)
  expect.soft(/\b1 nodes\b/.test(hud ?? ''), 'the graph loaded (1 nodes)').toBe(true)

  expect.soft(pageErrors, 'no page errors on the saving tab').toEqual([])
  expect.soft(page2Errors, 'no page errors on the reopening tab').toEqual([])
})
