/**
 * Control for the WrongDocumentError seen in export_e2e Part A.
 *
 * Drives the live app through the *identical* gesture sequence — lock, spawn,
 * right-hold menu, click, Escape — but never presses Ctrl+E. If the same error
 * appears, it belongs to the harness driving pointer lock, not to the export.
 */
import { chromium } from 'playwright-core'

// Uses the Chromium `npx playwright install chromium` already put in
// ~/Library/Caches/ms-playwright — no manual executablePath hunt needed.
const browser = await chromium.launch({ headless: false })
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto('http://127.0.0.1:5001/')
// Chrome refuses pointer lock to a document that is not frontmost, and throws
// WrongDocumentError doing it — which is the whole thing this run is chasing.
await page.bringToFront()
await page.waitForTimeout(2500)
await page.click('#viewport')
await page.waitForFunction(() => document.pointerLockElement !== null, null, { timeout: 5000 })

const dbl = async () => {
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(40)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(120)
}
for (let i = 0; i < 4; i++) {
  await dbl()
  await page.keyboard.down('KeyD')
  await page.waitForTimeout(260)
  await page.keyboard.up('KeyD')
  await page.mouse.move(60, 0)
  await page.waitForTimeout(120)
}
await page.keyboard.down('KeyA')
await page.waitForTimeout(520)
await page.keyboard.up('KeyA')
await page.waitForTimeout(200)
await page.mouse.down({ button: 'right' })
await page.mouse.move(0, -90)
await page.waitForTimeout(80)
await page.mouse.up({ button: 'right' })
await page.waitForTimeout(150)
await page.mouse.move(0, 0)
await page.mouse.down()
await page.mouse.up()
await page.waitForTimeout(200)
await page.keyboard.press('Escape')
await page.waitForTimeout(1500)

console.log('HUD:', await page.textContent('#hud'))
console.log(`page errors WITHOUT Ctrl+E: ${errors.length}`)
for (const e of errors) console.log('  ', e)
await browser.close()
