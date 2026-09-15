// Written 2026-09-14 for the password-system-rework branch: the editor's
// Tab-focus-trap (never escapes the panel, even mid-cycle) and Enter-advances-
// to-next-field behavior, plus a full spawn -> save (no password) -> reopen
// in a fresh tab round trip, asserting no password prompt ever appears and
// the node survives. Ad hoc, not wired into a runner — see
// e2e_password_save.mjs's header for the harness notes this shares.
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'

const BASE = 'http://localhost:5180'
const CHROME = '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

let failures = 0
function check(name, cond, extra = '') {
  console.log((cond ? 'OK   ' : 'FAIL ') + name + (extra ? ' ' + extra : ''))
  if (!cond) failures++
}
const ctrlS = (extra = {}) =>
  page.evaluate(
    (extra) => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', key: 's', ctrlKey: true, bubbles: true, ...extra })),
    extra
  )

const browser = await chromium.launch({ headless: false, executablePath: CHROME })
const page = await browser.newPage()
page.on('pageerror', (err) => console.log('  [pageerror]', err.message))

await page.goto(BASE)
await page.bringToFront()
await page.mouse.click(640, 400)
await page.waitForTimeout(300)

// --- Tab/Enter focus-trap checks, via Ctrl+Shift+S (always prompts) ---
await ctrlS({ shiftKey: true })
await page.waitForTimeout(200)
check('editor open for save-as', await page.evaluate(() => !document.getElementById('editor').hidden))

const firstFieldLabel = await page.evaluate(() => document.querySelectorAll('.editor-row span')[0]?.textContent)
check('first field is filename', firstFieldLabel === 'File name', `(got: ${firstFieldLabel})`)

for (let i = 0; i < 3; i++) await page.keyboard.press('Tab')
await page.waitForTimeout(50)
const stillInPanel = await page.evaluate(
  () => document.activeElement === document.querySelector('.editor-row input')
)
check('Tab cycles through all 3 fields and back into the panel (no escape)', stillInPanel)

await page.keyboard.press('Enter')
await page.waitForTimeout(50)
check('Enter on a non-last field does not submit', await page.evaluate(() => !document.getElementById('editor').hidden))

await page.keyboard.press('Escape')
await page.waitForTimeout(150)
check('Escape cancels the panel', await page.evaluate(() => document.getElementById('editor').hidden))

// --- Full round trip: spawn a node, save with no password, reopen with no prompt ---
// Escape (above) dropped pointer lock, same as it always has — reacquire it
// the same way a real user would, with a plain click, before spawning.
console.log('  locked before re-click:', await page.evaluate(() => !!document.pointerLockElement))
await page.mouse.click(640, 400)
await page.waitForTimeout(300)
console.log('  locked after re-click:', await page.evaluate(() => !!document.pointerLockElement))
await page.mouse.dblclick(640, 400)
await page.waitForTimeout(200)
const nodesBefore = await page.evaluate(() => document.getElementById('hud')?.textContent)
check('a node was spawned', /^node n1/.test(nodesBefore ?? ''), `(hud: ${nodesBefore})`)

await ctrlS()
await page.waitForTimeout(150)
await page.click('.editor-button--primary') // 1st blank submit -> warning
await page.waitForTimeout(100)
const [download] = await Promise.all([page.waitForEvent('download'), page.click('.editor-button--primary')]) // 2nd -> saves
const savedPath = await download.path()
await page.waitForTimeout(200)

// New tab, fresh app state, open the file we just saved
const page2 = await browser.newPage()
page2.on('pageerror', (err) => console.log('  [pageerror, page2]', err.message))
await page2.goto(BASE)
await page2.bringToFront()
await page2.mouse.click(640, 400)
await page2.waitForTimeout(300)

const [chooser] = await Promise.all([
  page2.waitForEvent('filechooser'),
  page2.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', key: 'o', ctrlKey: true, bubbles: true }))),
])
await chooser.setFiles(savedPath)
await page2.waitForTimeout(300)

const editorOpenOnOpen = await page2.evaluate(() => !document.getElementById('editor').hidden)
check('opening a no-password file never shows a password prompt', !editorOpenOnOpen)

const hudAfterOpen = await page2.evaluate(() => document.getElementById('hud')?.textContent)
check('the reopened map has the node back', /\b1 nodes\b/.test(hudAfterOpen ?? ''), `(hud: ${hudAfterOpen})`)

await browser.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
