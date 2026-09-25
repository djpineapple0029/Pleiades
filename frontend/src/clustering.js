/**
 * Clustering (`atlasmap-build-plan.md`, session 9) — plain data, no Three.js.
 *
 * Louvain gives community *membership* with arbitrary, unstable ids: the same
 * graph partitioned twice can name the same community 3 one run and 7 the next,
 * and a re-balance would then reshuffle every colour on screen. So what is
 * stored on a node is a **colour id, not a community id** (`cluster_color_id`),
 * and each run matches its new communities against the colours the nodes are
 * already wearing, by how many nodes they share. A community that is mostly
 * last run's blue one stays blue; only a genuinely new or split-off community
 * takes a colour nobody claimed.
 *
 * Colour id 0 means "no cluster": a node on its own, and every node in a map
 * that has never been balanced. It is not a palette entry — the star keeps the
 * plain tint it gets from its id (see `graphView.js`), so an unbalanced map
 * looks exactly as it did before clustering existed.
 */

import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import { seededRandom } from './random.js'
import { PALETTE_SIZE, LATE_IDS, hueOf } from './palette.js'

// Louvain traverses the graph in a random order, so a fixed seed is what makes
// one graph give one partition. A fresh generator per run, or successive runs
// over an unchanged graph would drift apart.
const LOUVAIN_SEED = 0x51ac7e5
// Louvain's own resolution. Above 1 splits into more, smaller communities;
// 1 is modularity as Blondel et al. define it and is what reads as "the
// obvious groups" on the maps this was tried on.
const RESOLUTION = 1
// A community this size or larger earns a colour. A single node is not a
// community in any useful sense, and colouring every loose node would turn a
// sparse map into confetti.
const MIN_CLUSTER_SIZE = 2
// A new group's colour is drawn at random, but from the hues at least this far
// round the wheel from every colour already claimed, when any are left — two
// random picks landing on neighbouring hues would read as one group.
const MIN_HUE_GAP = 40

// The palette that turns a colour id into an actual colour lives in
// `palette.js`, which imports nothing — so drawing a cluster's colour does not
// pull Louvain in behind it. That split is what keeps `graphology` out of the
// exported viewer, which reads cluster colours but never re-partitions.

/**
 * Partitions the graph and assigns each node a colour id.
 *
 * `nodes` is the id -> node map and `edges` id -> edge, as `graph.js` holds
 * them. Each node's **current** `cluster_color_id` is the previous run this
 * matches against, so calling this twice over an unchanged graph is a no-op.
 * Returns `{ colors, count }` — a Map of id -> colour id covering every node,
 * and how many communities earned a colour.
 *
 * `rng` only picks the colours of groups that have none yet. It is not the
 * Louvain seed, which stays fixed so one graph always gives one partition.
 */
export function computeClusters(nodes, edges, { rng = Math.random } = {}) {
  const colors = new Map()
  for (const id of nodes.keys()) colors.set(id, 0)
  if (nodes.size === 0) return { colors, count: 0 }

  // Undirected whatever the edges say: a connection means these two belong
  // together, the same reading `sizing.js` takes of `directed`.
  const graph = new Graph({ type: 'undirected' })
  for (const id of nodes.keys()) graph.addNode(id)
  for (const edge of edges.values()) {
    if (edge.from === edge.to) continue
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue
    // mergeEdge, not addEdge: a repeat would throw on a simple graph.
    graph.mergeEdge(edge.from, edge.to)
  }
  // Modularity is undefined with nothing to partition, and every node is its
  // own community anyway — all of them below MIN_CLUSTER_SIZE.
  if (graph.size === 0) return { colors, count: 0 }

  const communities = louvain(graph, {
    rng: seededRandom(LOUVAIN_SEED),
    resolution: RESOLUTION,
  })

  const members = new Map() // community id -> node ids
  for (const id of nodes.keys()) {
    const community = communities[id]
    if (community === undefined) continue
    let list = members.get(community)
    if (!list) members.set(community, (list = []))
    list.push(id)
  }
  const groups = [...members.values()].filter((list) => list.length >= MIN_CLUSTER_SIZE)

  // Every (group, existing colour) pair one of the group's nodes already
  // wears, strongest claim first. Sorting by shared count before share means a
  // community that split keeps its colour on the larger piece and the smaller
  // piece is the one that has to take a new one.
  const claims = []
  groups.forEach((list, index) => {
    const tally = new Map()
    for (const id of list) {
      const worn = nodes.get(id).cluster_color_id
      if (worn > 0) tally.set(worn, (tally.get(worn) ?? 0) + 1)
    }
    for (const [color, count] of tally) claims.push({ index, color, count, size: list.length })
  })
  claims.sort(
    (a, b) =>
      b.count - a.count ||
      b.count / b.size - a.count / a.size ||
      a.color - b.color ||
      a.index - b.index
  )

  const colorOf = new Map() // group index -> colour id
  const taken = new Set()
  for (const claim of claims) {
    if (colorOf.has(claim.index) || taken.has(claim.color)) continue
    colorOf.set(claim.index, claim.color)
    taken.add(claim.color)
  }
  // New and split-off groups draw a random colour nobody claimed (see
  // `pickColor`), so no two maps start on the same pair of hues. Only these
  // are random: a group that kept its colour above keeps it for good.
  for (let index = 0; index < groups.length; index++) {
    if (colorOf.has(index)) continue
    const color = pickColor(taken, rng)
    colorOf.set(index, color)
    taken.add(color)
  }

  groups.forEach((list, index) => {
    const color = colorOf.get(index)
    for (const id of list) colors.set(id, color)
  })
  return { colors, count: groups.length }
}

/**
 * A random colour id not in `taken`. Among the free palette hues that are not
 * late, it picks at random from those at least MIN_HUE_GAP from every taken
 * hue; when none are that far (a map with many groups), from the ones furthest
 * from their nearest taken hue, so the new group still gets the most distinct
 * colour left. Then the late, blue-ish ones (`palette.js`); and once the
 * palette is used up, the lowest id past it, which wraps onto a shared hue.
 */
function pickColor(taken, rng) {
  const free = []
  for (let id = 1; id <= PALETTE_SIZE; id++) if (!taken.has(id)) free.push(id)
  const early = free.filter((id) => !LATE_IDS.has(id))
  const pool = early.length ? early : free
  if (!pool.length) {
    let id = PALETTE_SIZE + 1
    while (taken.has(id)) id++
    return id
  }
  const takenHues = [...taken].map(hueOf)
  const gapOf = (id) => {
    let nearest = 180
    for (const hue of takenHues) {
      const gap = Math.abs(hueOf(id) - hue) % 360
      nearest = Math.min(nearest, gap, 360 - gap)
    }
    return nearest
  }
  const gaps = pool.map(gapOf)
  const widest = Math.max(...gaps)
  // Within a few degrees of the widest counts as a tie, so the pick still varies.
  const floor = widest >= MIN_HUE_GAP ? MIN_HUE_GAP : widest - 5
  const choices = pool.filter((_, i) => gaps[i] >= floor)
  return choices[Math.floor(rng() * choices.length)]
}
