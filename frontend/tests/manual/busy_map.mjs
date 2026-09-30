/**
 * A busy, realistic test map for Balance work (branch balance-cluster-separation):
 * ~350 stars over twelve topics of uneven size, grown the way a real map grows —
 * hubs from preferential attachment, a core or two per topic, a few nexuses,
 * links that jump between topics, stars that belong to two topics, and a few
 * loose pairs. Positions are grown too (each star spawned near the star it was
 * linked from) and saved **unbalanced**, so pressing B on it in any build shows
 * that build's Balance.
 *
 * Seeded: every run writes the same map. Plain Node, no server needed.
 *
 *   node tests/manual/busy_map.mjs
 *
 * Writes artifacts/busy_map.json (the payload) and artifacts/busy_map.plm
 * (the same payload in a no-password v2 container, which Ctrl+O opens without
 * asking for a password).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { writeContainer } from '../../src/format/container.js'

const DIR = fileURLToPath(new URL('../../../artifacts', import.meta.url))
mkdirSync(DIR, { recursive: true })

// Topic -> [size, the names its stars draw from]. Past the list, names are made
// by pairing a list word with one of QUALIFIERS, so every star is labelled.
const TOPICS = {
  Work: [
    60,
    'Roadmap, Hiring, Budget, Standup, Retro, Launch, Pricing, Onboarding, Metrics, Churn, Sales, Support, Legal, Vendors, Offsite, Reviews, Promotions, Contracts, Invoices, Security, Compliance, Design, Research, Interviews, Partners, Marketing, Newsletter, Website, Docs, Training, Payroll, OKRs, Board, Investors, Strategy, Competitors, Customers, Feedback, Backlog, Deadlines',
  ],
  Health: [
    48,
    'Sleep, Diet, Stress, Doctor, Dentist, Vitamins, Allergies, Blood tests, Posture, Hydration, Meditation, Therapy, Checkups, Vaccines, Caffeine, Sugar, Protein, Fiber, Eyesight, Hearing, Skin, Back pain, Migraines, Recovery, Breathing, Journaling, Sunlight, Screen time',
  ],
  Cooking: [
    40,
    'Bread, Pasta, Curry, Soup, Stock, Knife skills, Spices, Fermentation, Sourdough, Pickles, Dumplings, Tacos, Risotto, Stir fry, Baking, Pastry, Sauces, Grilling, Braising, Salads, Noodles, Rice, Beans, Tofu, Eggs, Cheese, Coffee, Tea, Desserts, Meal prep',
  ],
  Travel: [
    36,
    'Japan, Portugal, Mexico, Iceland, Norway, Peru, Vietnam, Italy, Morocco, Canada, Flights, Hotels, Packing, Visas, Rail pass, Hiking trips, Road trip, Camping, Museums, Food markets, Beaches, Language apps, Currency, Insurance, Maps, Photos',
  ],
  Finance: [
    32,
    'Savings, Index funds, Pension, Taxes, Mortgage, Rent, Home insurance, Emergency fund, Credit card, Budget app, Bonds, Dividends, Inflation, Net worth, Expenses, Subscriptions, Donations, Side income, Loans, Interest',
  ],
  Reading: [
    28,
    'Novels, Poetry, Essays, Biography, Sci-fi, Fantasy, Mystery, Classics, Book club, Library, Kindle, Highlights, Quotes, Book reviews, Authors, Translations, Short stories, Memoir',
  ],
  Music: [
    24,
    'Guitar, Piano, Chords, Scales, Jazz, Blues, Folk, Songwriting, Recording, Mixing, Concerts, Playlists, Vinyl, Rhythm, Harmony, Melody, Ear training, Theory',
  ],
  Garden: [
    20,
    'Tomatoes, Herbs, Compost, Soil, Seeds, Watering, Pruning, Pests, Roses, Runner beans, Greenhouse, Mulch, Bees, Fruit trees',
  ],
  Programming: [
    16,
    'Python, JavaScript, Git, Testing, Databases, APIs, Linux, Docker, Refactoring, Algorithms, Shaders, Debugging',
  ],
  Family: [
    12,
    'Birthdays, Holidays, Parents, Siblings, Cousins, Old photos, Recipes, Stories, Reunion, Gifts',
  ],
  Fitness: [10, 'Running, Cycling, Swimming, Yoga, Weights, Stretching, Climbing, Rowing'],
  History: [8, 'Rome, Egypt, Vikings, Renaissance, Industry, Empires, Revolutions'],
}
const QUALIFIERS = ['plan', 'notes', 'ideas', 'log', 'goals', 'questions', 'list', 'review']

// Pairs of topics that share more links than chance: a person's interests are
// not independent (cooking and health, work and finance...).
const AFFINITY = [
  ['Cooking', 'Health'],
  ['Work', 'Finance'],
  ['Travel', 'Finance'],
  ['Fitness', 'Health'],
  ['Travel', 'History'],
  ['Reading', 'History'],
  ['Programming', 'Work'],
  ['Garden', 'Cooking'],
  ['Family', 'Cooking'],
  ['Music', 'Reading'],
  ['Family', 'Travel'],
]
// Stars genuinely about two topics.
const BRIDGES = [
  ['Meal budget', 'Cooking', 'Finance'],
  ['Travel fund', 'Travel', 'Finance'],
  ['Work stress', 'Work', 'Health'],
  ['Marathon', 'Fitness', 'Travel'],
  ['Cookbooks', 'Cooking', 'Reading'],
  ['Family tree', 'Family', 'History'],
  ['Audio plugins', 'Music', 'Programming'],
  ['Herb remedies', 'Garden', 'Health'],
  ['Conference trip', 'Work', 'Travel'],
  ['Kids piano', 'Family', 'Music'],
]
const LOOSE_PAIRS = [
  ['Car service', 'Tyres'],
  ['Passport renewal', 'Photo booth'],
  ['Chess openings', 'Endgames'],
]
// Share of all edges that jump between topics (beyond bridges).
const CROSS_SHARE = 0.12

let seed = 20260929
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const pick = (list) => list[Math.floor(rand() * list.length)]

const nodes = []
const edges = []
const byId = new Map()
const degree = new Map()
const keys = new Set()

function addNode(label, near, extra = {}) {
  // Spawned ahead of the star it came from, the way double-click places one:
  // 40-90 units off in a random direction. A new topic starts somewhere in the
  // map's current reach.
  let x, y, z
  if (near) {
    const u = rand() * 2 - 1
    const a = rand() * Math.PI * 2
    const r = 40 + rand() * 50
    const s = Math.sqrt(1 - u * u)
    x = near.x + r * s * Math.cos(a)
    y = near.y + r * u
    z = near.z + r * s * Math.sin(a)
  } else {
    x = (rand() - 0.5) * 700
    y = (rand() - 0.5) * 400
    z = (rand() - 0.5) * 700
  }
  const node = {
    id: `n${nodes.length + 1}`,
    label,
    notes: '',
    links: [],
    x: Math.round(x * 1000) / 1000,
    y: Math.round(y * 1000) / 1000,
    z: Math.round(z * 1000) / 1000,
    cluster_color_id: 0,
    blend: null,
    is_core: false,
    is_nexus: false,
    ...extra,
  }
  nodes.push(node)
  byId.set(node.id, node)
  degree.set(node.id, 0)
  return node
}

function link(a, b) {
  if (a === b) return false
  const key = [a, b].sort().join('|')
  if (keys.has(key)) return false
  keys.add(key)
  edges.push({ id: `e${edges.length + 1}`, from: a, to: b, directed: false, label: '' })
  degree.set(a, degree.get(a) + 1)
  degree.set(b, degree.get(b) + 1)
  return true
}

/** A member picked with probability proportional to degree + 1 (hubs grow). */
function preferential(members) {
  let total = 0
  for (const id of members) total += degree.get(id) + 1
  let r = rand() * total
  for (const id of members) {
    r -= degree.get(id) + 1
    if (r <= 0) return id
  }
  return members[members.length - 1]
}

// Name pools, one per topic, in a stable order.
const pools = new Map()
for (const [topic, [size, words]] of Object.entries(TOPICS)) {
  const base = words.split(', ')
  const names = [...base]
  for (let i = 0; names.length < size - 1; i++)
    names.push(`${base[i % base.length]} ${QUALIFIERS[Math.floor(i / base.length) % QUALIFIERS.length]}`)
  pools.set(topic, names.slice(0, size - 1))
}

// Grow the topics round-robin, one star at a time, the way a map fills in over
// weeks: the topic's own name is its first core, a second core appears in the
// big topics, and every later star links to a member picked by degree.
const members = new Map() // topic -> ids
const cursor = new Map()
for (const topic of Object.keys(TOPICS)) {
  members.set(topic, [addNode(topic, null, { is_core: true }).id])
  cursor.set(topic, 0)
}
let growing = true
while (growing) {
  growing = false
  for (const topic of Object.keys(TOPICS)) {
    const pool = pools.get(topic)
    const i = cursor.get(topic)
    if (i >= pool.length) continue
    growing = true
    cursor.set(topic, i + 1)
    const list = members.get(topic)
    const parent = preferential(list)
    const bigTopic = TOPICS[topic][0] >= 30
    const star = addNode(pool[i], byId.get(parent), {
      is_core: bigTopic && i === Math.floor(pool.length / 2),
    })
    link(parent, star.id)
    if (rand() < 0.3 && list.length > 2) link(star.id, preferential(list))
    list.push(star.id)
  }
}

// A nexus or two in the bigger topics: one joint several stars share.
for (const [topic, list] of members) {
  const count = TOPICS[topic][0] >= 36 ? 2 : TOPICS[topic][0] >= 24 ? 1 : 0
  for (let k = 0; k < count; k++) {
    const hub = byId.get(pick(list))
    const nexus = addNode('', hub, { is_nexus: true })
    const spokes = 3 + Math.floor(rand() * 3)
    for (let s = 0; s < spokes; s++) link(nexus.id, pick(list))
    list.push(nexus.id)
  }
}

// Cross-topic links: most between affine pairs, the rest anywhere.
const inTopic = edges.length
const crossWanted = Math.round((inTopic * CROSS_SHARE) / (1 - CROSS_SHARE))
const topics = Object.keys(TOPICS)
for (let made = 0, guard = 0; made < crossWanted && guard < 10000; guard++) {
  const [a, b] = rand() < 0.7 ? pick(AFFINITY) : [pick(topics), pick(topics)]
  if (a === b) continue
  if (link(preferential(members.get(a)), pick(members.get(b)))) made++
}

for (const [label, a, b] of BRIDGES) {
  const star = addNode(label, byId.get(pick(members.get(a))))
  link(star.id, preferential(members.get(a)))
  link(star.id, pick(members.get(a)))
  link(star.id, preferential(members.get(b)))
  link(star.id, pick(members.get(b)))
}
for (const [a, b] of LOOSE_PAIRS) {
  const first = addNode(a, null)
  link(first.id, addNode(b, first).id)
}

const payload = {
  format: 'atlasmap',
  schema: 1,
  app: '0.1.0',
  nodes,
  edges,
  camera: { position: [0, 150, 1600], rotation: [-0.09, 0, 0] },
}
writeFileSync(`${DIR}/busy_map.json`, JSON.stringify(payload))
writeFileSync(`${DIR}/busy_map.plm`, await writeContainer(payload, ''))
const cross = edges.length - inTopic
console.log(
  `busy_map: ${nodes.length} stars, ${edges.length} links (${cross} added across topics), ` +
    `${nodes.filter((n) => n.is_core).length} cores, ${nodes.filter((n) => n.is_nexus).length} nexuses`,
)
