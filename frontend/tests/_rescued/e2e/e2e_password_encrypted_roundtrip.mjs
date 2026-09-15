// Written 2026-09-14 for the password-system-rework branch: a real password
// typed via keyboard through the shadow-hosted field (confirms it is NOT
// reachable via a light-DOM `querySelector`, the whole point of hiding it
// from password-manager extensions), wrong-password rejection and re-prompt,
// then a correct-password open with the node preserved. Ad hoc, not wired
// into a runner — see e2e_password_save.mjs's header for shared harness notes.
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'

const BASE = 'http://localhost:5180'
const CHROME = '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

let failures = 0
function check(name, cond, extra = '') {
  console.log((cond ? 'OK   ' : 'FAIL ') + name + (extra ? ' ' + extra : ''))
  if (!cond) failures++
}

const browser = await chromium.launch({ headless: false, executablePath: CHROME })
const page = await browser.newPage()
page.on('pageerror', (err) => console.log('  [pageerror]', err.message))
await page.goto(BASE)
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
check('password input is not reachable via a light-DOM query (closed shadow root)', passwordFieldPierceable === 0)

// Type into filename, tab to password, type a password, tab to confirm, type it again, commit.
await page.keyboard.type('secret-map')
await page.keyboard.press('Tab')
await page.keyboard.type('hunter2')
await page.keyboard.press('Tab')
await page.keyboard.type('hunter2')
const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')])
const savedPath = await download.path()
await page.waitForTimeout(200)
check('editor closed after committing a real password with Enter from the last field', await page.evaluate(() => document.getElementById('editor').hidden))

const fs = await import('node:fs')
const bytes = fs.readFileSync(savedPath)
check('saved file is v2, mode 1 (encrypted)', bytes[4] === 2 && bytes[5] === 1)

// Reopen: wrong password first, then the right one.
const page2 = await browser.newPage()
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
check('an encrypted file does show the password prompt', await page2.evaluate(() => !document.getElementById('editor').hidden))

await page2.keyboard.type('wrong-password')
await page2.keyboard.press('Enter')
await page2.waitForTimeout(300)
const note = await page2.evaluate(() => document.querySelector('.editor-note')?.textContent)
check('wrong password re-prompts with an error note', !!note && /wrong password|altered/i.test(note), `(got: ${note})`)

await page2.keyboard.type('hunter2')
await page2.keyboard.press('Enter')
await page2.waitForTimeout(300)
check('correct password opens the file', await page2.evaluate(() => document.getElementById('editor').hidden))
const hud = await page2.evaluate(() => document.getElementById('hud')?.textContent)
check('the graph loaded (1 nodes)', /\b1 nodes\b/.test(hud ?? ''), `(hud: ${hud})`)

await browser.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
