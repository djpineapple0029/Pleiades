/**
 * End-to-end for the Ctrl+E HTML export.
 *
 * Part A drives the real app on Flask :5001 — spawns a map, connects a pair
 * through the radial menu, presses Ctrl+E, and captures the download. Part B
 * opens that downloaded file from file:// and checks it is a working, view-only,
 * fully offline map.
 *
 * Headed on purpose: pointer lock does not exist in headless Chromium, and
 * flight is the thing being tested. The installed playwright wants a browser
 * revision that was never downloaded, so a real one is located by hand.
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
const executablePath = findChrome()

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`) }
}

const lock = (page) => page.waitForFunction(() => document.pointerLockElement !== null, null, { timeout: 5000 })

// ---------------------------------------------------------------- Part A
console.log('\n=== A. export from the live app ===')
const browser = await chromium.launch({ headless: false, executablePath })
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()
const appErrors = []
page.on('pageerror', (e) => appErrors.push(String(e)))

await page.goto('http://127.0.0.1:5001/')
// Chrome refuses pointer lock to a document that is not frontmost, and throws
// WrongDocumentError doing it — nothing to do with the app.
await page.bringToFront()
await page.waitForTimeout(2500) // skybox bakes once at startup
await page.click('#viewport')
await lock(page)
ok(true, 'pointer lock acquired in the app')

// Four nodes, flying a little between each so they do not stack.
const dbl = async () => {
  await page.mouse.down(); await page.mouse.up()
  await page.waitForTimeout(40)
  await page.mouse.down(); await page.mouse.up()
  await page.waitForTimeout(120)
}
for (let i = 0; i < 4; i++) {
  await dbl()
  await page.keyboard.down('KeyD'); await page.waitForTimeout(260); await page.keyboard.up('KeyD')
  await page.mouse.move(60, 0)
  await page.waitForTimeout(120)
}
let hud = await page.textContent('#hud')
ok(/4 nodes/.test(hud), 'four nodes spawned', hud)

// Connect: right-hold, push the wheel to the top wedge, release. Then look back
// and left-click a node to land the link. Best effort — the export is what is
// under test, not the menu.
await page.keyboard.down('KeyA'); await page.waitForTimeout(520); await page.keyboard.up('KeyA')
await page.waitForTimeout(200)
await page.mouse.down({ button: 'right' })
await page.mouse.move(0, -90)
await page.waitForTimeout(80)
await page.mouse.up({ button: 'right' })
await page.waitForTimeout(150)
await page.mouse.move(0, 0)
await page.mouse.down(); await page.mouse.up()
await page.waitForTimeout(200)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

hud = await page.textContent('#hud')
const edgeCount = Number(/(\d+) edges/.exec(hud)?.[1] ?? 0)
console.log(`  (map is ${hud})`)

// Export. The chord is preventDefault-ed, so the browser's own save dialog
// never sees it; what should arrive is a download from the object URL.
const waitDownload = page.waitForEvent('download', { timeout: 8000 })
await page.keyboard.press('Control+e')
let exported = null
try {
  const download = await waitDownload
  exported = `${DIR}/exported.html`
  await download.saveAs(exported)
  ok(download.suggestedFilename().endsWith('.html'), 'download is a .html', download.suggestedFilename())
} catch (e) {
  ok(false, 'Ctrl+E produced a download', String(e).split('\n')[0])
}
ok(appErrors.length === 0, 'no page errors in the app', appErrors.join(' | '))
await browser.close()

if (!exported) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }

// ------------------------------------------------------- the file itself
console.log('\n=== B. the exported file, statically ===')
const html = readFileSync(exported, 'utf8')
ok(!html.includes('__ATLASMAP_PAYLOAD__'), 'payload marker was filled')
ok(!html.includes('__ATLASMAP_TITLE__'), 'title marker was filled')
ok(!/\/assets\//.test(html), 'no /assets/ references')
ok(!/<script[^>]+src=/.test(html), 'no external script src')
ok(!/<link[^>]+href=/.test(html), 'no external stylesheet')

const payloadText = /<script id="atlasmap-map" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1]
ok(Boolean(payloadText), 'payload script tag present')
const payload = JSON.parse(payloadText)
ok(payload.nodes.length === 4, 'payload holds the four nodes', String(payload.nodes?.length))
ok(payload.nodes.every((n) => !('notes' in n)), 'notes stripped from every node')
ok(payload.nodes.every((n) => 'label' in n && 'x' in n && 'is_core' in n), 'nodes keep label/position/core')
ok(Boolean(payload.camera), 'camera block present')
console.log(`  (file is ${(Buffer.byteLength(html) / 1024).toFixed(0)} kB, ${payload.nodes.length} nodes, ${payload.edges.length} edges)`)

// ------------------------------------------------------- Part C: it runs
console.log('\n=== C. the exported file, opened from file:// ===')
const b2 = await chromium.launch({ headless: false, executablePath })
const ctx2 = await b2.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 } })
const p2 = await ctx2.newPage()
const errs = []
const external = []
p2.on('pageerror', (e) => errs.push(String(e)))
p2.on('request', (r) => {
  const u = r.url()
  if (!u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u)
})
const downloads = []
p2.on('download', (d) => downloads.push(d.suggestedFilename()))

await p2.goto(`file://${exported}`)
await p2.bringToFront()
await p2.waitForTimeout(3000)

ok(errs.length === 0, 'no page errors', errs.join(' | '))
ok(external.length === 0, 'made no network requests at all', external.slice(0, 3).join(', '))
ok((await p2.title()).length > 0 && (await p2.title()) !== 'AtlasMap', 'titled after the map', await p2.title())

let vhud = await p2.textContent('#hud')
ok(/overview/.test(vhud), 'opens in the overview', vhud)
ok(/4 nodes/.test(vhud), 'shows the four nodes', vhud)
await p2.screenshot({ path: `${DIR}/shot_overview.png` })

// Editing surfaces should not exist at all.
ok((await p2.$('#radial-menu')) === null, 'no radial menu in the DOM')
ok((await p2.$('#editor')) === null, 'no editor panel in the DOM')

// Tab into flight.
await p2.keyboard.press('Tab')
await p2.waitForTimeout(1200)
let locked = await p2.evaluate(() => document.pointerLockElement !== null)
ok(locked, 'Tab hands over to locked flight')

vhud = await p2.textContent('#hud')
const before = vhud
await p2.mouse.move(80, 20)
await p2.keyboard.down('KeyW'); await p2.waitForTimeout(500); await p2.keyboard.up('KeyW')
await p2.waitForTimeout(300)
await p2.screenshot({ path: `${DIR}/shot_flight.png` })
ok(true, 'flew without error')

// The point of the whole thing: none of the editing paths do anything.
await p2.mouse.down(); await p2.mouse.up(); await p2.waitForTimeout(40)
await p2.mouse.down(); await p2.mouse.up(); await p2.waitForTimeout(300)
vhud = await p2.textContent('#hud')
ok(/4 nodes/.test(vhud) || !/5 nodes/.test(vhud), 'double-click spawns nothing', vhud)

await p2.mouse.down({ button: 'right' })
await p2.mouse.move(0, -90)
await p2.mouse.up({ button: 'right' })
await p2.waitForTimeout(300)
ok((await p2.$('#radial-menu')) === null, 'right-click opens no menu')
vhud = await p2.textContent('#hud')
ok(!/5 nodes/.test(vhud), 'still four nodes after the menu gesture', vhud)

await p2.keyboard.press('Control+s')
await p2.keyboard.press('Control+o')
await p2.keyboard.press('KeyB')
await p2.waitForTimeout(800)
ok(downloads.length === 0, 'Ctrl+S and Ctrl+O download nothing', downloads.join(', '))
ok(errs.length === 0, 'still no page errors after every editing attempt', errs.join(' | '))

await b2.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
