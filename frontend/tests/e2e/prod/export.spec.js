// Ported from tests/_rescued/e2e_headed/export_e2e.mjs.
//
// End-to-end for the Ctrl+E HTML export. Part A drives the real app on the
// built Flask server — spawns a map, connects a pair through the radial
// menu, presses Ctrl+E, and captures the download. Part B statically
// inspects that downloaded file. Part C opens it from file:// and checks it
// is a working, view-only, fully offline map.
//
// Headed on purpose: pointer lock does not exist in headless Chromium, and
// flight is the thing being tested.
import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'

const lock = (page) =>
  page.waitForFunction(() => document.pointerLockElement !== null, null, { timeout: 5000 })

test('Ctrl+E export: builds, downloads, and runs fully offline', async ({ page, context }, testInfo) => {
  // ---------------------------------------------------------------- Part A
  const appErrors = []
  page.on('pageerror', (e) => appErrors.push(String(e)))

  await page.goto('/')
  // Chrome refuses pointer lock to a document that is not frontmost, and
  // throws WrongDocumentError doing it — nothing to do with the app.
  await page.bringToFront()
  await page.waitForTimeout(2500) // skybox bakes once at startup
  await page.click('#viewport')
  await lock(page)

  // Four nodes, flying a little between each so they do not stack.
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
  let hud = await page.textContent('#hud')
  expect.soft(/4 nodes/.test(hud), 'four nodes spawned').toBe(true)

  // Connect: right-hold, push the wheel to the top wedge, release. Then look
  // back and left-click a node to land the link. Best effort — the export is
  // what is under test, not the menu.
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
  await page.waitForTimeout(200)

  // Export. The chord is preventDefault-ed, so the browser's own save dialog
  // never sees it; what should arrive is a download from the object URL.
  const waitDownload = page.waitForEvent('download', { timeout: 8000 })
  await page.keyboard.press('Control+e')
  let exported = null
  try {
    const download = await waitDownload
    exported = testInfo.outputPath('exported.html')
    await download.saveAs(exported)
    expect.soft(download.suggestedFilename().endsWith('.html'), 'download is a .html').toBe(true)
  } catch (e) {
    expect.soft(false, `Ctrl+E produced a download: ${String(e).split('\n')[0]}`).toBe(true)
  }
  expect.soft(appErrors, 'no page errors in the app').toEqual([])

  if (!exported) return

  // ------------------------------------------------------- the file itself
  const html = readFileSync(exported, 'utf8')
  expect.soft(html.includes('__ATLASMAP_PAYLOAD__'), 'payload marker was filled').toBe(false)
  expect.soft(html.includes('__ATLASMAP_TITLE__'), 'title marker was filled').toBe(false)
  expect.soft(/\/assets\//.test(html), 'no /assets/ references').toBe(false)
  expect.soft(/<script[^>]+src=/.test(html), 'no external script src').toBe(false)
  expect.soft(/<link[^>]+href=/.test(html), 'no external stylesheet').toBe(false)

  const payloadText = /<script id="atlasmap-map" type="application\/json">([\s\S]*?)<\/script>/.exec(
    html,
  )?.[1]
  expect.soft(Boolean(payloadText), 'payload script tag present').toBe(true)
  const payload = JSON.parse(payloadText)
  expect.soft(payload.nodes.length, 'payload holds the four nodes').toBe(4)
  expect
    .soft(
      payload.nodes.every((n) => !('notes' in n)),
      'notes stripped from every node',
    )
    .toBe(true)
  expect
    .soft(
      payload.nodes.every((n) => 'label' in n && 'x' in n && 'is_core' in n),
      'nodes keep label/position/core',
    )
    .toBe(true)
  expect.soft(Boolean(payload.camera), 'camera block present').toBe(true)

  // ------------------------------------------------------- Part C: it runs
  const p2 = await context.newPage()
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

  expect.soft(errs, 'no page errors').toEqual([])
  expect.soft(external.length, 'made no network requests at all').toBe(0)
  const title = await p2.title()
  expect.soft(title.length > 0 && title !== 'AtlasMap', 'titled after the map').toBe(true)

  let vhud = await p2.textContent('#hud')
  expect.soft(/overview/.test(vhud), 'opens in the overview').toBe(true)
  expect.soft(/4 nodes/.test(vhud), 'shows the four nodes').toBe(true)
  await p2.screenshot({ path: testInfo.outputPath('shot_overview.png') })

  // Editing surfaces should not exist at all.
  expect.soft(await p2.$('#radial-menu'), 'no radial menu in the DOM').toBeNull()
  expect.soft(await p2.$('#editor'), 'no editor panel in the DOM').toBeNull()

  // Tab into flight.
  await p2.keyboard.press('Tab')
  await p2.waitForTimeout(1200)
  const locked = await p2.evaluate(() => document.pointerLockElement !== null)
  expect.soft(locked, 'Tab hands over to locked flight').toBe(true)

  await p2.mouse.move(80, 20)
  await p2.keyboard.down('KeyW')
  await p2.waitForTimeout(500)
  await p2.keyboard.up('KeyW')
  await p2.waitForTimeout(300)
  await p2.screenshot({ path: testInfo.outputPath('shot_flight.png') })

  // The point of the whole thing: none of the editing paths do anything.
  await p2.mouse.down()
  await p2.mouse.up()
  await p2.waitForTimeout(40)
  await p2.mouse.down()
  await p2.mouse.up()
  await p2.waitForTimeout(300)
  vhud = await p2.textContent('#hud')
  expect.soft(/4 nodes/.test(vhud) || !/5 nodes/.test(vhud), 'double-click spawns nothing').toBe(true)

  await p2.mouse.down({ button: 'right' })
  await p2.mouse.move(0, -90)
  await p2.mouse.up({ button: 'right' })
  await p2.waitForTimeout(300)
  expect.soft(await p2.$('#radial-menu'), 'right-click opens no menu').toBeNull()
  vhud = await p2.textContent('#hud')
  expect.soft(/5 nodes/.test(vhud), 'still four nodes after the menu gesture').toBe(false)

  await p2.keyboard.press('Control+s')
  await p2.keyboard.press('Control+o')
  await p2.keyboard.press('KeyB')
  await p2.waitForTimeout(800)
  expect.soft(downloads, 'Ctrl+S and Ctrl+O download nothing').toEqual([])
  expect.soft(errs, 'still no page errors after every editing attempt').toEqual([])
})
