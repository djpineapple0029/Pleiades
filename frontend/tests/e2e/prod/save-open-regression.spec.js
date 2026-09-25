// Ported from tests/_rescued/e2e_headed/save_open_regression.mjs.
//
// Regression for files.js against the real built app served by Flask: build
// a map, Ctrl+S through the password panel, check the bytes that come back
// are a real .atlasmap, then Ctrl+O the same file back in and check the
// graph returns.
//
// Headed on purpose: pointer lock does not exist in headless Chromium, and
// flight is the thing being tested.
import { test, expect } from '@playwright/test'

test('save through the password panel, then open the same file back in', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))

  await page.goto('/')
  await page.bringToFront()
  await page.waitForTimeout(2500) // skybox bakes once at startup
  await page.click('#viewport')
  await page.waitForFunction(() => document.pointerLockElement !== null, null, { timeout: 5000 })

  for (let i = 0; i < 3; i++) {
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(40)
    await page.mouse.down()
    await page.mouse.up()
    await page.waitForTimeout(120)
    await page.keyboard.down('KeyD')
    await page.waitForTimeout(280)
    await page.keyboard.up('KeyD')
    await page.waitForTimeout(100)
  }
  expect.soft(/3 nodes/.test(await page.textContent('#hud')), 'three nodes to save').toBe(true)

  // ---- save
  const waitSave = page.waitForEvent('download', { timeout: 10000 })
  await page.keyboard.press('Control+s')
  await page.waitForSelector('#editor .editor-panel input', { timeout: 5000 })
  const fields = await page.$$('#editor .editor-panel input')
  expect.soft(fields.length, 'save panel has filename + password + confirm').toBe(3)
  await fields[0].fill('regress')
  await fields[1].fill('correct horse')
  await fields[2].fill('correct horse')
  await fields[2].press('Enter')

  let saved = null
  try {
    const download = await waitSave
    saved = await download.path()
    expect.soft(download.suggestedFilename(), 'downloaded regress.atlasmap').toBe('regress.atlasmap')
  } catch (e) {
    expect.soft(false, `Ctrl+S produced a download: ${String(e).split('\n')[0]}`).toBe(true)
  }

  if (saved) {
    const { readFileSync } = await import('node:fs')
    const bytes = readFileSync(saved)
    expect.soft(bytes.subarray(0, 4).toString('latin1'), 'file carries the ATLM magic').toBe('ATLM')
    expect.soft(bytes[4], 'format version byte is 1 or 2').toBeGreaterThanOrEqual(1)
    expect.soft(bytes.length, 'file has a payload').toBeGreaterThan(100)
  }

  await page.waitForTimeout(600)
  expect
    .soft(/downloaded regress\.atlasmap/.test(await page.textContent('#hud')), 'HUD reports the save')
    .toBe(true)

  // ---- open it straight back
  if (saved) {
    const chooser = page.waitForEvent('filechooser', { timeout: 8000 })
    await page.keyboard.press('Control+o')
    try {
      await (await chooser).setFiles(saved)
    } catch (e) {
      expect.soft(false, `Ctrl+O opened the file picker: ${String(e).split('\n')[0]}`).toBe(true)
    }
    await page.waitForSelector('#editor .editor-panel input', { timeout: 5000 })
    const pw = await page.$$('#editor .editor-panel input')
    expect.soft(pw.length, 'open panel asks only for a password').toBe(1)
    await pw[0].fill('correct horse')
    await pw[0].press('Enter')
    await page.waitForTimeout(1500)

    const hud = await page.textContent('#hud')
    expect.soft(/opened regress\.atlasmap/.test(hud), 'HUD reports the open').toBe(true)
    expect.soft(/3 nodes/.test(hud), 'the three nodes came back').toBe(true)
  }

  expect.soft(pageErrors, 'no page errors').toEqual([])
})
