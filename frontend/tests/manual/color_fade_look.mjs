/**
 * Look frames for the Balance colour fade (balance-color-fade branch).
 *
 * Builds a ~130-node map of six topics, each with a core, plus nodes that sit
 * between two topics; runs a real Balance on it (graph.js + physics.js, in a
 * page on the headless-harness Vite at :5180, so it is the app's own code);
 * then renders the same layout twice in the *built* viewer — once with flat
 * cluster colours (blends stripped, which is how master draws it) and once
 * with the fade — and saves overview frames to artifacts/.
 *
 * Needs `npm run build` first (it reads server/static/viewer-template.html)
 * and Vite on :5180 (`npx vite --port 5180 --strictPort`). Headless only.
 *
 *   node tests/manual/color_fade_look.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const DIR = fileURLToPath(new URL('../../../artifacts', import.meta.url))
mkdirSync(DIR, { recursive: true })
const TEMPLATE = fileURLToPath(new URL('../../../server/static/viewer-template.html', import.meta.url))

const TOPICS = {
  Physics: ['Momentum', 'Entropy', 'Fields', 'Symmetry', 'Relativity', 'Quanta', 'Spin', 'Gravity', 'Optics', 'Thermodynamics', 'Particles', 'Waves', 'Energy', 'Mass', 'Charge', 'Magnetism', 'Friction', 'Inertia', 'Plasma'],
  Philosophy: ['Ethics', 'Logic', 'Metaphysics', 'Epistemology', 'Kant', 'Hume', 'Plato', 'Stoicism', 'Virtue', 'Free will', 'Mind', 'Truth', 'Causation', 'Aesthetics', 'Descartes', 'Nietzsche', 'Duty', 'Being', 'Doubt'],
  Language: ['Syntax', 'Morphology', 'Prosody', 'Semantics', 'Deixis', 'Register', 'Corpus', 'Phonology', 'Grammar', 'Dialect', 'Etymology', 'Pragmatics', 'Metaphor', 'Tense', 'Lexicon', 'Idiom', 'Script', 'Accent', 'Rhetoric'],
  Cities: ['Transit', 'Zoning', 'Density', 'Streets', 'Housing', 'Parks', 'Utilities', 'Suburbs', 'Traffic', 'Bridges', 'Markets', 'Districts', 'Rail', 'Sewers', 'Skyline', 'Plazas', 'Tenements', 'Harbour', 'Walls'],
  Biology: ['Cells', 'Genes', 'Evolution', 'Proteins', 'Ecology', 'Species', 'Enzymes', 'Neurons', 'Mitosis', 'DNA', 'Fungi', 'Bacteria', 'Symbiosis', 'Immunity', 'Hormones', 'Photosynthesis', 'Habitat', 'Fossils', 'Mutation'],
  Music: ['Harmony', 'Rhythm', 'Melody', 'Timbre', 'Counterpoint', 'Scales', 'Tempo', 'Chords', 'Jazz', 'Fugue', 'Opera', 'Blues', 'Improvisation', 'Notation', 'Cadence', 'Dynamics', 'Orchestra', 'Tuning', 'Motif'],
}
// Nodes genuinely about two topics — the ones a hard partition colours wrong.
const BRIDGES = [
  ['Philosophy of science', 'Physics', 'Philosophy'],
  ['Philosophy of language', 'Philosophy', 'Language'],
  ['Acoustics', 'Physics', 'Music'],
  ['Song lyrics', 'Music', 'Language'],
  ['Urban ecology', 'Cities', 'Biology'],
  ['Biophysics', 'Biology', 'Physics'],
  ['Place names', 'Language', 'Cities'],
  ['Philosophy of mind', 'Philosophy', 'Biology'],
]

/** A small seeded rng, so every run builds the same map. */
let seed = 7
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

const nodes = []
const edges = []
let e = 0
const idOf = new Map()
const link = (a, b) => edges.push({ id: `e${e++}`, from: a, to: b, directed: false, label: '' })
const names = Object.keys(TOPICS)
names.forEach((topic, t) => {
  const core = `n${t}_0`
  idOf.set(topic, core)
  const members = [topic, ...TOPICS[topic]]
  members.forEach((label, i) => {
    nodes.push({
      id: `n${t}_${i}`, label, notes: '', links: [],
      x: (rand() - 0.5) * 600, y: (rand() - 0.5) * 600, z: (rand() - 0.5) * 600,
      cluster_color_id: 0, is_core: i === 0,
    })
  })
  // Core to a handful of members, and a loose web among the rest.
  for (let i = 1; i < members.length; i++) {
    if (i <= 6) link(core, `n${t}_${i}`)
    else link(`n${t}_${1 + Math.floor(rand() * (i - 1))}`, `n${t}_${i}`)
    if (rand() < 0.35) link(`n${t}_${i}`, `n${t}_${1 + Math.floor(rand() * (members.length - 1))}`)
  }
})
BRIDGES.forEach(([label, a, b], i) => {
  const id = `b${i}`
  nodes.push({ id, label, notes: '', links: [], x: (rand() - 0.5) * 600, y: (rand() - 0.5) * 600, z: (rand() - 0.5) * 600, cluster_color_id: 0, is_core: false })
  const ta = names.indexOf(a), tb = names.indexOf(b)
  link(id, `n${ta}_${1 + Math.floor(rand() * 5)}`)
  link(id, `n${ta}_${7 + Math.floor(rand() * 5)}`)
  link(id, `n${tb}_${1 + Math.floor(rand() * 5)}`)
  link(id, `n${tb}_${7 + Math.floor(rand() * 5)}`)
})
// Drop any accidental self-loop or repeat, which the graph would refuse anyway.
const seen = new Set()
const cleanEdges = edges.filter(({ from, to }) => {
  const key = [from, to].sort().join('|')
  if (from === to || seen.has(key)) return false
  seen.add(key)
  return true
})

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
const errs = []
page.on('pageerror', (x) => errs.push(String(x)))

// --- Balance, with the app's own graph and physics -------------------------------
await page.goto('http://localhost:5180/')
await page.waitForTimeout(1000)
const balanced = await page.evaluate(async (input) => {
  const { createGraph } = await import('/src/graph.js')
  const { createPhysics } = await import('/src/physics.js')
  const graph = createGraph()
  graph.load(input)
  const physics = createPhysics(graph, { syncNodes() {}, updateEdgePositions() {} })
  physics.start()
  let guard = 0
  while (physics.isRunning && guard++ < 20000) physics.update()
  return { payload: graph.toPayload(), clusters: graph.clusterCount }
}, { nodes, edges: cleanEdges })
console.log(`balanced: ${nodes.length} nodes, ${cleanEdges.length} edges, ${balanced.clusters} clusters`)
writeFileSync(`${DIR}/color_balanced.json`, JSON.stringify(balanced.payload))

// --- Render both versions in the built viewer ------------------------------------
const template = readFileSync(TEMPLATE, 'utf8')
if (!template.includes('__ATLASMAP_PAYLOAD__')) throw new Error('template has no payload marker')
const variants = {
  flat: balanced.payload.nodes.map((node) => ({ ...node, blend: null })),
  fade: balanced.payload.nodes,
}
for (const [name, variantNodes] of Object.entries(variants)) {
  const payload = { nodes: variantNodes, edges: balanced.payload.edges, camera: { position: [0, 0, 1400], rotation: [0, 0, 0] } }
  const json = JSON.stringify(payload).replaceAll('<', '\\u003c')
  const html = template.replace('__ATLASMAP_TITLE__', () => `colour ${name}`).replace('__ATLASMAP_PAYLOAD__', () => json)
  const file = `${DIR}/color_${name}.html`
  writeFileSync(file, html)
  await page.goto(`file://${file}`)
  await page.waitForTimeout(4500) // skybox bake, the fit fly-out, label rasters
  await page.screenshot({ path: `${DIR}/color_${name}_overview.png` })
  // Closer: wheel in on the overview's orbit camera.
  await page.mouse.move(640, 400)
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(80) }
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${DIR}/color_${name}_close.png` })
  console.log(`wrote color_${name}_overview.png and color_${name}_close.png`)
}

console.log('page errors:', errs.length, errs.join(' | '))
await browser.close()
