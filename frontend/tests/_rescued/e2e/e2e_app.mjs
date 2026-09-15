/**
 * The whole app, driven through its own input handlers: spawn a chain, link it
 * with the radial menu, mark a node core from the menu's bottom wedge, and see
 * the pick radius grow under the real crosshair; name a node through the Edit
 * wedge and see its label drawn under it. Pointer lock is faked the way
 * session 1 did it — chrome-headless-shell cannot take a real one.
 */
import { chromium } from '/Users/dempseypalmer/.npm/_npx/6bcb61ec6d5aea22/node_modules/playwright/index.mjs'

const BASE = process.env.BASE ?? 'http://localhost:5180'
const SHOTS = new URL('.', import.meta.url).pathname
let ok = 0, fails = 0
const check = (name, cond, extra = '') =>
  cond ? (ok++, console.log(`  pass  ${name}`)) : (fails++, console.log(`  FAIL  ${name} ${extra}`))

const browser = await chromium.launch({
  executablePath: '/Users/dempseypalmer/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('ReadPixels')) errors.push(`${m.type()}: ${m.text()}`) })
await page.goto(`${BASE}/`)
await page.waitForTimeout(1500)

await page.evaluate(() => {
  const canvas = document.getElementById('viewport')
  // Switchable rather than always-on, so Tab into the overview really does
  // release the lock and Tab back really does ask for it again.
  let locked = true
  Object.defineProperty(document, 'pointerLockElement', { get: () => (locked ? canvas : null), configurable: true })
  canvas.requestPointerLock = () => { locked = true; document.dispatchEvent(new Event('pointerlockchange')) }
  document.exitPointerLock = () => { locked = false; document.dispatchEvent(new Event('pointerlockchange')) }
  document.dispatchEvent(new Event('pointerlockchange'))
  const fire = (type, init) => canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
  window.__t = {
    hud: () => document.getElementById('hud').textContent,
    locked: () => locked,
    overlay: () => !document.getElementById('overlay').hidden,
    crosshair: () => !document.getElementById('crosshair').hidden,
    look: (dx, dy) => document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: dx, movementY: dy })),
    doubleClick: () => { fire('mousedown', { button: 0, buttons: 1 }); fire('mouseup', { button: 0 }); fire('mousedown', { button: 0, buttons: 1 }); fire('mouseup', { button: 0 }) },
    click: () => { fire('mousedown', { button: 0, buttons: 1 }); fire('mouseup', { button: 0 }) },
    rightDown: () => fire('mousedown', { button: 2, buttons: 2 }),
    rightUp: () => fire('mouseup', { button: 2 }),
    wedges: () => [...document.querySelectorAll('#radial-menu .wedge text')].map((t) => t.textContent),
    armed: () => document.querySelector('#radial-menu .wedge.armed text')?.textContent ?? null,
  }
})
const t = (expr) => page.evaluate(`window.__t.${expr}`)
// SwiftShader draws the stars on the CPU and a frame can take longer than any
// fixed wait, so wait for frames: after three, the app's loop has raycast the
// crosshair and rewritten the HUD at least once since the last input.
const frames = (n = 3) => page.evaluate((n) => new Promise((done) => {
  const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : done())
  step(n)
}), n)
const settle = async (ms = 0) => { await frames(); if (ms) await page.waitForTimeout(ms); await frames() }
const pickMenu = async (dx, dy) => {
  await t('rightDown()'); await settle()
  const labels = await t('wedges()')
  await t(`look(${dx}, ${dy})`); await settle()
  const armed = await t('armed()')
  await t('rightUp()'); await settle()
  return { labels, armed }
}

check('crosshair up under faked lock', await page.evaluate(() => !document.getElementById('crosshair').hidden))

// Three nodes, each 0.3 rad to the right of the last.
await t('doubleClick()'); await settle()
await t('look(150, 0)'); await settle()
await t('doubleClick()'); await settle()
await t('look(150, 0)'); await settle()
await t('doubleClick()'); await settle()
check('three nodes spawned', (await t('hud()')).startsWith('node n3'), await t('hud()'))

// n1 -> n2 -> n3 via the menu's top wedge.
await t('look(-300, 0)'); await settle()
check('aimed at n1', (await t('hud()')).startsWith('node n1'), await t('hud()'))
const connectMenu = await pickMenu(0, -60)
check('node menu has four wedges with Mark core at the bottom', JSON.stringify(connectMenu.labels) === JSON.stringify(['Connect', 'Edit', 'Mark core', 'Delete']), JSON.stringify(connectMenu.labels))
check('up arms Connect', connectMenu.armed === 'Connect', connectMenu.armed)
await t('look(150, 0)'); await settle()
await t('click()'); await settle()
await pickMenu(0, -60)
await t('look(150, 0)'); await settle()
await t('click()'); await settle()
check('chain linked', (await t('hud()')).startsWith('node n3 · 1 links'), await t('hud()'))

// Aim at n1, then a little above it: off a plain node, onto a core one.
await t('look(-300, 0)'); await settle()
check('back on n1, not core', (await t('hud()')) === 'node n1 · 1 links', await t('hud()'))
const UP = -70 // 0.14 rad: ~12.6 units at 90, outside 5.75, inside 15
await t(`look(0, ${UP})`); await settle()
const offBefore = await t('hud()')
check('above plain n1 is empty space', offBefore === '3 nodes · 2 edges', offBefore)
await t(`look(0, ${-UP})`); await settle()
await page.screenshot({ path: `${SHOTS}/app_before.png` })

const coreMenu = await pickMenu(0, 60)
check('down arms Mark core', coreMenu.armed === 'Mark core', coreMenu.armed)
check('menu closed after release', await page.evaluate(() => document.getElementById('radial-menu').hidden))
check('HUD marks n1 core', (await t('hud()')) === 'node n1 · 1 links · core', await t('hud()'))
await settle(700) // easing
await page.screenshot({ path: `${SHOTS}/app_after.png` })
await t(`look(0, ${UP})`); await settle()
check('same offset now lands on the grown core', (await t('hud()')) === 'node n1 · 1 links · core', await t('hud()'))
await t(`look(0, ${-UP})`); await settle()

const unmark = await pickMenu(0, 60)
check('core node offers Unmark core', unmark.labels[2] === 'Unmark core' && unmark.armed === 'Unmark core', JSON.stringify(unmark))
check('HUD drops core', (await t('hud()')) === 'node n1 · 1 links', await t('hud()'))
await settle(700)
await t(`look(0, ${UP})`); await settle()
check('shrunk back: offset misses again', (await t('hud()')) === '3 nodes · 2 edges', await t('hud()'))
await t(`look(0, ${-UP})`); await settle()

// Name n1 through the Edit wedge: its label appears under it, in the hover
// colour, since the crosshair is on it.
const W = 1280, H = 720
// Label pixels in the band under the targeted star, below its hover ring.
const labelPixels = async () => {
  const png = await page.screenshot({ clip: { x: W / 2 - 120, y: H / 2 + 54, width: 240, height: 30 } })
  return page.evaluate(async (data) => {
    const img = new Image()
    await new Promise((done) => { img.onload = done; img.src = `data:image/png;base64,${data}` })
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(0, 0, c.width, c.height).data
    let amber = 0
    for (let i = 0; i < px.length; i += 4) if (px[i] > 190 && px[i + 1] > 140 && px[i + 1] < 215 && px[i + 2] < 150) amber++
    return amber
  }, png.toString('base64'))
}
check('no label before naming', (await labelPixels()) < 5)
const editMenu = await pickMenu(60, 0)
check('right arms Edit', editMenu.armed === 'Edit', editMenu.armed)
await settle()
check('editor open with the label field focused', await page.evaluate(() => !document.getElementById('editor').hidden && document.activeElement?.tagName === 'INPUT'))
await page.keyboard.type('Alpha')
await page.keyboard.press('Enter')
await settle(300)
check('HUD uses the new label', (await t('hud()')) === 'node Alpha · 1 links', await t('hud()'))
const amber = await labelPixels()
check('label drawn under the targeted node, in the hover colour', amber > 30, amber)
await page.screenshot({ path: `${SHOTS}/app_label.png` })

// Balance with a core in the graph, then everything still picks.
await pickMenu(0, 60)
await page.keyboard.press('b')
await settle()
const started = (await t('hud()')).includes('balancing')
const deadline = Date.now() + 60000
while (Date.now() < deadline && (await t('hud()')).includes('balancing')) await page.waitForTimeout(250)
await settle()
const hudAfterBalance = await t('hud()')
check('balance runs with a core node and finishes', started && !hudAfterBalance.includes('balancing'), hudAfterBalance)
await page.screenshot({ path: `${SHOTS}/app_balanced.png` })

// Tab into the overview and back, through the real key handler.
await page.keyboard.press('Tab')
await settle()
check('Tab releases pointer lock', (await t('locked()')) === false)
check('overview HUD, with the way out in it', (await t('hud()')).startsWith('overview · 3 nodes · 2 edges · Tab to fly'), await t('hud()'))
check('no click-to-fly overlay over the overview', (await t('overlay()')) === false)
check('no crosshair in the overview', (await t('crosshair()')) === false)
await settle(700) // the flight out to the fitted view
await page.screenshot({ path: `${SHOTS}/app_overview.png` })
check('B still balances from the overview', await page.evaluate(async () => {
  const before = document.getElementById('hud').textContent
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', key: 'b', bubbles: true }))
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  return document.getElementById('hud').textContent !== before && document.getElementById('hud').textContent.includes('balancing')
}))
const overviewDeadline = Date.now() + 60000
while (Date.now() < overviewDeadline && (await t('hud()')).includes('balancing')) await page.waitForTimeout(250)

await page.keyboard.press('Tab')
await settle()
check('Tab takes the lock back', (await t('locked()')) === true)
check('crosshair back', (await t('crosshair()')) === true)
check('overlay stays down', (await t('overlay()')) === false)
check('HUD back off the overview', !(await t('hud()')).startsWith('overview'), await t('hud()'))

check('no console errors or warnings', errors.length === 0, JSON.stringify(errors))

console.log(`\n${ok} passed, ${fails} failed`)
await browser.close()
process.exit(fails ? 1 : 0)
