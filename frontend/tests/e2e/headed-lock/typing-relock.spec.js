// Real pointer lock, real Chrome: renaming in place keeps the lock, and the
// notes sidebar gets it back after Save with no click — the Pointer Lock
// spec lets a page re-lock without a fresh gesture after its own
// exitPointerLock(), and this is the check that Chrome actually honours it.
//
// Headed on purpose: pointer lock does not work headless.
import { test, expect } from '@playwright/test'

const locked = (page) => page.evaluate(() => document.pointerLockElement !== null)

test('rename keeps the lock; notes Save and Esc take it back with no click', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto('/')
  await page.bringToFront()
  await page.mouse.click(640, 400)
  await page.waitForTimeout(300)
  expect.soft(await locked(page), 'locked after click').toBe(true)

  await page.mouse.dblclick(640, 400)
  await page.waitForTimeout(300)

  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  await page.keyboard.type('Vega')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  expect.soft(await locked(page), 'still locked after renaming in place').toBe(true)
  expect
    .soft(await page.evaluate(() => document.getElementById('hud').textContent), 'renamed')
    .toContain('Vega')

  await page.keyboard.press('ControlOrMeta+Enter')
  await page.waitForTimeout(300)
  expect.soft(await locked(page), 'released for the notes cursor').toBe(false)
  await page.keyboard.type('a note')
  await page.click('#notes-sidebar .editor-button--primary')
  await page.waitForTimeout(400)
  expect.soft(await locked(page), 'locked again after Save, no click').toBe(true)
  expect.soft(await page.evaluate(() => document.getElementById('overlay').hidden), 'no key list').toBe(true)

  await page.keyboard.press('ControlOrMeta+Enter')
  await page.waitForTimeout(300)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  expect.soft(await locked(page), 'locked again after Esc-cancel, no click').toBe(true)

  expect.soft(pageErrors, 'no page errors').toEqual([])
})
