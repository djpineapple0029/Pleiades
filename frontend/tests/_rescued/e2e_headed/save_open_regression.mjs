/**
 * Regression for `files.js`, which was rewritten wholesale to add the HTML
 * export. Save and open are the only persistence the app has, and nothing in
 * the export suite touches them.
 *
 * Full round trip against the real Flask crypto endpoints: build a map, Ctrl+S
 * through the password panel, check the bytes that come back are a real
 * `.atlasmap`, then Ctrl+O the same file back in and check the graph returns.
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const DIR = '/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/5432f80e-6e72-4451-9445-fa57a40f9a47/scratchpad'
const require = createRequire('/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/5a026c05-ec34-4eca-a30b-6b84a52f43a3/scratchpad/')
const { chromium } = require('playwright')

function findChrome() {
  const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
  for (const dir of readdirSync(cache).filter((n) => n.startsWith('chromium-')).sort().reverse()) {
    const base = `${cache}/${dir}/chrome-mac-arm64`
    if (!existsSync(base)) continue
    for (const app of readdirSync(base).filter((n) => n.endsWith('.app'))) {
      const macos = `${base}/${app}/Contents/MacOS`
      if (existsSync(macos)) for (const bin of readdirSync(macos)) return `${macos}/${bin}`
    }
  }
  throw new Error('no chromium found')
}

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`) }
}

const browser = await chromium.launch({ headless: false, executablePath: findChrome() })
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto('http://127.0.0.1:5001/')
await page.bringToFront()
await page.waitForTimeout(2500)
await page.click('#viewport')
await page.waitForFunction(() => document.pointerLockElement !== null, null, { timeout: 5000 })

for (let i = 0; i < 3; i++) {
  await page.mouse.down(); await page.mouse.up()
  await page.waitForTimeout(40)
  await page.mouse.down(); await page.mouse.up()
  await page.waitForTimeout(120)
  await page.keyboard.down('KeyD'); await page.waitForTimeout(280); await page.keyboard.up('KeyD')
  await page.waitForTimeout(100)
}
ok(/3 nodes/.test(await page.textContent('#hud')), 'three nodes to save', await page.textContent('#hud'))

// ---- save
const waitSave = page.waitForEvent('download', { timeout: 10000 })
await page.keyboard.press('Control+s')
await page.waitForSelector('#editor .editor-panel input', { timeout: 5000 })
ok(true, 'Ctrl+S opened the password panel')
const fields = await page.$$('#editor .editor-panel input')
ok(fields.length === 3, 'save panel has filename + password + confirm', String(fields.length))
await fields[0].fill('regress')
await fields[1].fill('correct horse')
await fields[2].fill('correct horse')
await fields[2].press('Enter')

let saved = null
try {
  const download = await waitSave
  saved = `${DIR}/regress.atlasmap`
  await download.saveAs(saved)
  ok(download.suggestedFilename() === 'regress.atlasmap', 'downloaded regress.atlasmap', download.suggestedFilename())
} catch (e) {
  ok(false, 'Ctrl+S produced a download', String(e).split('\n')[0])
}

if (saved) {
  const bytes = readFileSync(saved)
  ok(bytes.subarray(0, 4).toString('latin1') === 'ATLM', 'file carries the ATLM magic', bytes.subarray(0, 4).toString('hex'))
  ok(bytes[4] === 1, 'format version byte is 1', String(bytes[4]))
  ok(bytes.length > 100, 'file has a payload', `${bytes.length} bytes`)
  console.log(`  (saved ${bytes.length} bytes)`)
}

await page.waitForTimeout(600)
ok(/saved regress\.atlasmap/.test(await page.textContent('#hud')), 'HUD reports the save', await page.textContent('#hud'))

// ---- open it straight back
if (saved) {
  const chooser = page.waitForEvent('filechooser', { timeout: 8000 })
  await page.keyboard.press('Control+o')
  try {
    await (await chooser).setFiles(saved)
    ok(true, 'Ctrl+O opened the file picker')
  } catch (e) {
    ok(false, 'Ctrl+O opened the file picker', String(e).split('\n')[0])
  }
  await page.waitForSelector('#editor .editor-panel input', { timeout: 5000 })
  const pw = await page.$$('#editor .editor-panel input')
  ok(pw.length === 1, 'open panel asks only for a password', String(pw.length))
  await pw[0].fill('correct horse')
  await pw[0].press('Enter')
  await page.waitForTimeout(1500)

  const hud = await page.textContent('#hud')
  ok(/opened regress\.atlasmap/.test(hud), 'HUD reports the open', hud)
  ok(/3 nodes/.test(hud), 'the three nodes came back', hud)
}

ok(errors.length === 0, 'no page errors', errors.join(' | '))
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
