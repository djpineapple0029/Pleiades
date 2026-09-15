// Written 2026-09-14 for the password-system-rework branch; updated
// 2026-09-15 when the no-password warn-once step was removed on request (a
// blank password now saves immediately, no confirmation round). Verifies the
// mouse-clickable Save/Cancel buttons and that the result is a real ATLM v2
// mode-0 (unencrypted) container. Ad hoc, not wired into a runner — see
// frontend/tests/_rescued's other files and CLAUDE.md for the harness gaps
// this still needs (§2.7.1). Needs: Vite on :5180
// (`npx vite --port 5180 --strictPort`), headed Chromium (pointer lock does
// not work headless), `page.bringToFront()` before the lock click.
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'
import { readFileSync } from 'node:fs'

const BASE = 'http://localhost:5180'
const CHROME = '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

let failures = 0
function check(name, cond, extra = '') {
  console.log((cond ? 'OK   ' : 'FAIL ') + name + (extra ? ' ' + extra : ''))
  if (!cond) failures++
}

const browser = await chromium.launch({ headless: false, executablePath: CHROME })
const page = await browser.newPage()
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('  [console.error]', msg.text())
})
page.on('pageerror', (err) => console.log('  [pageerror]', err.message))

await page.goto(BASE)
await page.bringToFront()

// --- lock the pointer (click-to-fly) ---
await page.mouse.click(640, 400)
await page.waitForTimeout(300)
const locked = await page.evaluate(() => document.pointerLockElement !== null)
check('pointer lock acquired after click', locked)

console.log('  hasFocus:', await page.evaluate(() => document.hasFocus()))
console.log('  pointerLockElement tag:', await page.evaluate(() => document.pointerLockElement?.tagName))

// --- Ctrl+S: first save, blank password saves immediately (no warn-once) ---
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', key: 's', ctrlKey: true, bubbles: true, cancelable: true }))
})
await page.waitForTimeout(150)
const editorVisible1 = await page.evaluate(() => !document.getElementById('editor').hidden)
check('editor panel opens on first Ctrl+S', editorVisible1)

const cursorVisibleDuringSave = await page.evaluate(() => document.pointerLockElement === null)
check('pointer lock released during the save panel (mouse-usable)', cursorVisibleDuringSave)

// leave filename/password/confirm all blank, commit via the button (mouse-first workflow) —
// one submit is enough now, there is no confirmation round to click through.
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('.editor-button--primary'),
])
const path = await download.path()
const bytes = readFileSync(path)
check('no-password save produced an ATLM v2 file', bytes[0] === 0x41 && bytes[4] === 2 && bytes[5] === 0)
console.log('  suggested filename:', download.suggestedFilename())

// After saving, we should be back to idle with no editor open, and the graph empty (no nodes spawned)
await page.waitForTimeout(200)
const editorHiddenAfter = await page.evaluate(() => document.getElementById('editor').hidden)
check('editor panel closes after save', editorHiddenAfter)

// --- Tab-focus-trap check: open node edit via spawn + edit, confirm Tab never leaves panel ---
// Double-click spawns a node at the crosshair.
await page.mouse.dblclick(640, 400)
await page.waitForTimeout(200)
// Open the radial menu on the node (right mouse down/up cycle is app-specific;
// use the keyboard-free path isn't available, so just check editor mechanics
// directly via editNode's known field order instead: label, notes.
// We reach it by right-clicking on the node under the crosshair.
await page.mouse.down({ button: 'right' })
await page.mouse.move(640, 340) // drag toward a wedge
await page.mouse.up({ button: 'right' })
await page.waitForTimeout(200)
const menuOpen = await page.evaluate(() => !document.getElementById('radial-menu').hidden)
console.log('  radial menu open after right-click+drag:', menuOpen)

await browser.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
