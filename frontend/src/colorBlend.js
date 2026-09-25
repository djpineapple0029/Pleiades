/**
 * Colour fade — plain data, no Three.js and no graphology.
 *
 * A cluster colour on its own is a hard partition: every node in a group wears
 * the same flat hue and the border between two groups is a line, however much
 * the nodes either side of it are really about both. This softens that into a
 * fade, from three signals layered in turn:
 *
 *   1. **Cores.** A core node is the head of its topic, so its group's colour is
 *      strongest around it: pure on the core, carried a few hops out (across a
 *      border too), and resisting the blending below in proportion.
 *   2. **Borders.** A few passes of neighbour smoothing. A node whose
 *      neighbours all wear its colour is untouched; one linked into two groups
 *      comes out as a mix of both.
 *   3. **Space.** Each group's centroid gives off its colour with a Gaussian
 *      fall-off, and every node takes a little of that field, so neighbouring
 *      regions of the layout shade into each other.
 *
 * Mixing is in OKLab, carrying each colour's intended chroma alongside
 * (`palette.js`, `inkToMix`/`mixToSrgb`), so a fade stays pastel instead of
 * greying out. Run by `graph.reblend()` once a Balance ends, on settled
 * positions; the result is stored on each node as `blend` and never computed
 * on load, the same way `cluster_color_id` is authoritative.
 */

import { clusterInk, inkToMix, mixToSrgb } from './palette.js'

// Tuned to "medium" on a 128-node, six-topic map (tests/manual/
// color_fade_look.mjs): about half the stars visibly off their flat cluster
// colour, the nodes between two topics most of all, and every core still
// plainly its group's colour.
//
// How far a core's colour reaches, in hops, and how much of it survives each
// one. Weight is relative to a node's own colour, which counts 1.
const CORE_HOPS = 3
const CORE_WEIGHT = 1.5
const CORE_FALLOFF = 0.5
// Border smoothing: passes, and the share of the neighbours' mean a node takes
// per pass. Divided by (1 + core anchor), so a node near a core holds its colour.
const SMOOTH_PASSES = 4
const SMOOTH_MIX = 0.5
// The spatial field: how much of it a node takes (again divided by 1 + anchor),
// and its width as a multiple of the mean group radius. Neighbouring groups'
// centres sit two to three radii apart after a Balance, so a width of one
// radius gave them almost no weight at all; 2.5 lets them reach across.
const SPATIAL_MIX = 0.45
const SPATIAL_SIGMA = 2.5

const round3 = (v) => Math.round(v * 1000) / 1000

/**
 * Every clustered node's faded colour, as a Map of id -> sRGB `[r, g, b]` on
 * 0..1, rounded to three places so it saves compactly. Unclustered nodes
 * (colour id 0) are left out: they keep the plain star tint.
 *
 * `nodes`, `incident` and `edges` are `graph.js`'s maps. Deterministic for a
 * given graph and layout.
 */
export function computeBlend(nodes, incident, edges) {
  const lab = new Map() // id -> [L, a, b, chroma], the node's colour as it is built up
  const inkLab = new Map() // colour id -> its palette ink, same form
  for (const node of nodes.values()) {
    const colorId = node.cluster_color_id
    if (!colorId) continue
    if (!inkLab.has(colorId)) inkLab.set(colorId, inkToMix(clusterInk(colorId)))
    lab.set(node.id, [...inkLab.get(colorId)])
  }
  const blends = new Map()
  if (lab.size === 0) return blends

  const neighbours = (id) => {
    const out = []
    for (const edgeId of incident.get(id) ?? []) {
      const edge = edges.get(edgeId)
      const other = edge.from === id ? edge.to : edge.from
      if (other !== id && lab.has(other)) out.push(other)
    }
    return out
  }

  // 1. Cores. One BFS per core, since two cores' colours both count where they
  // overlap; a core only reaches a few hops, so this stays cheap.
  const anchor = new Map() // id -> total core weight received
  const pull = new Map() // id -> weighted sum of core inks received
  for (const node of nodes.values()) {
    if (!node.is_core || !lab.has(node.id)) continue
    const ink = inkLab.get(node.cluster_color_id)
    const seen = new Set([node.id])
    let frontier = [node.id]
    for (let hop = 0; hop <= CORE_HOPS && frontier.length; hop++) {
      // The core itself takes a hop-0 weight, which anchors it firmly.
      const weight = CORE_WEIGHT * CORE_FALLOFF ** hop
      const next = []
      for (const id of frontier) {
        anchor.set(id, (anchor.get(id) ?? 0) + weight)
        const sum = pull.get(id) ?? [0, 0, 0, 0]
        for (let i = 0; i < 4; i++) sum[i] += ink[i] * weight
        pull.set(id, sum)
        for (const other of neighbours(id)) {
          if (seen.has(other)) continue
          seen.add(other)
          next.push(other)
        }
      }
      frontier = next
    }
  }
  for (const [id, sum] of pull) {
    const own = lab.get(id)
    const total = 1 + anchor.get(id)
    lab.set(id, own.map((v, i) => (v + sum[i]) / total))
  }
  const holdOf = (id) => 1 + (anchor.get(id) ?? 0)

  // 2. Borders. Every pass reads the previous one's colours, never its own.
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next = new Map()
    for (const [id, own] of lab) {
      const around = neighbours(id)
      if (!around.length) {
        next.set(id, own)
        continue
      }
      const mean = [0, 0, 0, 0]
      for (const other of around) {
        const c = lab.get(other)
        for (let i = 0; i < 4; i++) mean[i] += c[i] / around.length
      }
      const mix = SMOOTH_MIX / holdOf(id)
      next.set(id, own.map((v, i) => v + (mean[i] - v) * mix))
    }
    for (const [id, c] of next) lab.set(id, c)
  }

  // 3. Space. Centroid and RMS radius per group, then a Gaussian field over them.
  const groups = new Map() // colour id -> { x, y, z, n, r }
  for (const node of nodes.values()) {
    if (!lab.has(node.id)) continue
    let group = groups.get(node.cluster_color_id)
    if (!group) groups.set(node.cluster_color_id, (group = { x: 0, y: 0, z: 0, n: 0, r: 0 }))
    group.x += node.x
    group.y += node.y
    group.z += node.z
    group.n++
  }
  for (const group of groups.values()) {
    group.x /= group.n
    group.y /= group.n
    group.z /= group.n
  }
  for (const node of nodes.values()) {
    const group = groups.get(node.cluster_color_id)
    if (!group || !lab.has(node.id)) continue
    group.r += (node.x - group.x) ** 2 + (node.y - group.y) ** 2 + (node.z - group.z) ** 2
  }
  let radiusSum = 0
  for (const group of groups.values()) radiusSum += Math.sqrt(group.r / group.n)
  const sigma = SPATIAL_SIGMA * (radiusSum / groups.size)
  // One group, or every node stacked on one point: there is nothing to fade
  // between, and a zero-width Gaussian would divide by zero.
  if (groups.size > 1 && sigma > 1e-6) {
    const entries = [...groups].map(([colorId, g]) => ({ ...g, ink: inkLab.get(colorId) }))
    for (const node of nodes.values()) {
      const own = lab.get(node.id)
      if (!own) continue
      const field = [0, 0, 0, 0]
      let total = 0
      for (const g of entries) {
        const d2 = (node.x - g.x) ** 2 + (node.y - g.y) ** 2 + (node.z - g.z) ** 2
        const w = Math.exp(-d2 / (sigma * sigma))
        total += w
        for (let i = 0; i < 4; i++) field[i] += g.ink[i] * w
      }
      if (total < 1e-12) continue
      const mix = SPATIAL_MIX / holdOf(node.id)
      lab.set(node.id, own.map((v, i) => v + (field[i] / total - v) * mix))
    }
  }

  for (const [id, c] of lab) blends.set(id, mixToSrgb(c).map(round3))
  return blends
}
