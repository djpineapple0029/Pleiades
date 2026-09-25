/**
 * Does the exported viewer actually *draw* a real map?
 *
 * The app-driven export test only managed four bare nodes, which leaves edges,
 * labels, core sizing and cluster colour untested. This splices a rich
 * synthetic payload into the built template exactly the way `files.js` does,
 * then opens the result from file:// and captures frames to look at.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const DIR = fileURLToPath(new URL('../../artifacts', import.meta.url))
mkdirSync(DIR, { recursive: true })
const TEMPLATE = fileURLToPath(new URL('../../../server/static/viewer-template.html', import.meta.url))

// Three clusters, each with a core, labelled nodes, and a couple of named
// connections — the whole visual vocabulary in one map.
const NAMES = [
  ['Physics', 'Momentum', 'Entropy', 'Fields', 'Symmetry', 'Relativity', 'Quanta', 'Spin'],
  ['Language', 'Syntax', 'Morphology', 'Prosody', 'Semantics', 'Deixis', 'Register', 'Corpus'],
  ['Cities', 'Transit', 'Zoning', 'Density', 'Streets', 'Housing', 'Parks', 'Utilities'],
]
const CENTRES = [
  [-320, 60, 0],
  [300, -40, -120],
  [-40, 260, 260],
]

const nodes = []
const edges = []
let e = 0
NAMES.forEach((group, g) => {
  const [cx, cy, cz] = CENTRES[g]
  group.forEach((label, i) => {
    const a = (i / group.length) * Math.PI * 2
    nodes.push({
      id: `n${g}_${i}`,
      label,
      links: [],
      x: cx + Math.cos(a) * 110 + (i % 3) * 14,
      y: cy + Math.sin(a) * 110 - (i % 2) * 20,
      z: cz + Math.sin(a * 1.7) * 90,
      cluster_color_id: g + 1,
      is_core: i === 0,
    })
  })
  // A hub-and-spoke inside the cluster, plus a rim, so edges cross at angles.
  for (let i = 1; i < group.length; i++) {
    edges.push({ id: `e${e++}`, from: `n${g}_0`, to: `n${g}_${i}`, directed: false, label: '' })
  }
  for (let i = 1; i < group.length - 1; i++) {
    edges.push({ id: `e${e++}`, from: `n${g}_${i}`, to: `n${g}_${i + 1}`, directed: false, label: '' })
  }
})
// Named bridges between clusters.
edges.push({ id: `e${e++}`, from: 'n0_0', to: 'n1_0', directed: false, label: 'describes' })
edges.push({ id: `e${e++}`, from: 'n1_0', to: 'n2_0', directed: true, label: 'shapes' })
edges.push({ id: `e${e++}`, from: 'n2_3', to: 'n0_4', directed: false, label: '' })

const payload = { nodes, edges, camera: { position: [0, 0, 900], rotation: [0, 0, 0] } }

const template = readFileSync(TEMPLATE, 'utf8')
if (!template.includes('__ATLASMAP_PAYLOAD__')) throw new Error('template has no payload marker')
const json = JSON.stringify(payload).replaceAll('<', '\\u003c')
const html = template
  .replace('__ATLASMAP_TITLE__', () => 'three fields')
  .replace('__ATLASMAP_PAYLOAD__', () => json)
const file = `${DIR}/rich.html`
writeFileSync(file, html)
console.log(
  `wrote ${file}: ${(Buffer.byteLength(html) / 1024).toFixed(0)} kB, ${nodes.length} nodes, ${edges.length} edges`,
)

const browser = await chromium.launch({ headless: false })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
const errs = []
const external = []
page.on('pageerror', (x) => errs.push(String(x)))
page.on('request', (r) => {
  const u = r.url()
  if (!u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u)
})

await page.goto(`file://${file}`)
// Chrome refuses pointer lock to a document that is not frontmost.
await page.bringToFront()
await page.waitForTimeout(4000) // skybox bake + the 0.45s fit + label rasters
console.log('HUD:', await page.textContent('#hud'))
await page.screenshot({ path: `${DIR}/rich_overview.png` })

// Into flight, then fly toward the map so labels and edges come up close.
await page.keyboard.press('Tab')
await page.waitForTimeout(1200)
// Tab asks for the lock itself; if the window was not focused in time, the
// overlay is up and a click is the documented way back in.
if (!(await page.evaluate(() => document.pointerLockElement !== null))) {
  await page.bringToFront()
  await page.click('#viewport')
  await page.waitForTimeout(1200)
}
console.log('locked:', await page.evaluate(() => document.pointerLockElement !== null))
await page.keyboard.down('KeyW')
await page.waitForTimeout(1700)
await page.keyboard.up('KeyW')
await page.waitForTimeout(900)
await page.screenshot({ path: `${DIR}/rich_flight.png` })
console.log('HUD in flight:', await page.textContent('#hud'))

console.log('page errors:', errs.length, errs.join(' | '))
console.log('external requests:', external.length, external.slice(0, 3).join(', '))
await browser.close()
