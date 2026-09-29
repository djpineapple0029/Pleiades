/**
 * Constellation layout — the Balance rework (`context/BALANCE2.md`). Plain
 * data, no Three.js.
 *
 * The old Balance was one force simulation over every star, with extra forces
 * bolted on to keep colour groups apart. Those forces fought the links: every
 * unit of gap between two groups was a unit longer on each line between them,
 * and no setting gave both clear islands and short lines. This computes the
 * layout in levels instead, so group spacing is *chosen* rather than fought
 * over:
 *
 * 1. Each colour group is laid out on its own, in its own frame, from scratch.
 *    Big groups can be split into sub-groups first (`inner: 'subgroups'`) or
 *    ringed round their cores (`inner: 'rings'`).
 * 2. Each group's radius is measured from that layout.
 * 3. The groups themselves are laid out as single bodies of that radius:
 *    groups that share more links sit nearer, none can overlap, and the
 *    `arrangement` shapes the whole (free 3D, a shell, a disc).
 * 4. Each group is turned so the stars with links out of it face the groups
 *    they link to — short lines, and the lines between two groups run across
 *    the gap between them rather than through a third.
 * 5. Bridge stars, which belong about equally to two groups, go in the gap
 *    between those two, on the way from one to the other.
 *
 * Always from scratch, and seeded: one graph gives one layout, whatever the
 * stars' current positions (only the map's centre is kept, so the camera
 * doesn't lose it).
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceCenter,
  forceRadial,
  forceX,
  forceY,
  forceZ,
} from 'd3-force-3d'
import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import { seededRandom } from './random.js'

// Resting length of a link between two base-size stars, and the charge and
// its range inside a group — the old Balance's values, which read well inside
// one group; it was only between groups that they failed.
export const LINK_DISTANCE = 60
const CHARGE = -70
const CHARGE_RANGE = 350
const CHARGE_THETA = 1.3
// A nexus's links rest shorter and it pushes less, so its stars gather round it.
const NEXUS_LINK_SCALE = 0.6
const NEXUS_CHARGE_SCALE = 0.5
// Edge repulsion inside a group (see `forceEdgeRepel`).
const EDGE_REPEL_STRENGTH = -40
const EDGE_REPEL_RANGE = 220
const EDGE_REPEL_MIN = 4

// Ticks for one group's own layout, run to rest offline — not animated, so
// this is cost, not settle time.
const GROUP_TICKS = 300
// Laid out alone, a group has nothing pressing on it from outside — in the
// old one-simulation Balance its neighbours did that — so charge and edge
// repulsion blow it up to several times the size it needs (a 12-star group
// came out 216 units in radius). A pull toward the group's own centre, the
// share of the offset closed per tick at full heat, stands in for them. It
// ramps in with group size, from nothing at GRAVITY_FROM stars to full at
// GRAVITY_FULL: a pair or a triangle doesn't bloat, and pulling it in would
// only squeeze its links short of their rest length.
const GROUP_GRAVITY = 0.2
const GRAVITY_FROM = 3
const GRAVITY_FULL = 10
// Ticks for the layout of the groups themselves (few bodies, cheap).
const ARRANGE_TICKS = 500

// Empty space between two groups' balls: two and a half links, plus a share
// of their mean radius so big groups get more room. Wide on purpose: the
// links between groups are drawn as lanes (`lanes.js`), so distance no longer
// costs a web of long lines — at one link's gap the groups still ran together
// from the overview. Both can be overridden per call (`gap`, `gapRatio`) while
// prototypes are compared.
const GAP_BASE = LINK_DISTANCE * 2.5
const GAP_RATIO = 0.6
// Inside a split group, sub-groups sit this much closer than groups do.
const SUBGROUP_GAP_SCALE = 0.45
// A group this size or larger is split into sub-groups under `inner: 'subgroups'`.
const SUBGROUP_MIN = 20

// A star is a bridge when its links into another group are at least this share
// of its links into its own, and at least BRIDGE_MIN_LINKS of them.
const BRIDGE_RATIO = 0.75
const BRIDGE_MIN_LINKS = 2

// `inner: 'rings'`: distance between rings, per step of links from a core.
const RING_STEP = LINK_DISTANCE * 0.85

const SEED = 0xc0457e11

/**
 * Lays out the whole map.
 *
 * `nodes` / `edges` are the id -> object maps `graph.js` holds; each node's
 * `cluster_color_id` is the partition (Balance reclusters first). `collideOf(id)`
 * is a star's collision radius, `baseCollide` a base-size star's.
 *
 * Returns `{ positions, groups, bridges }`: positions is id -> [x, y, z];
 * groups lists each top-level group's `{ color, ids, centre, radius }`, and
 * bridges each bridge star's `{ id, from, to }` colours — for drawing lanes.
 */
export function computeConstellation(
  nodes,
  edges,
  { collideOf, baseCollide, arrangement = 'free', inner = 'force', gap = GAP_BASE, gapRatio = GAP_RATIO },
) {
  const positions = new Map()
  if (nodes.size === 0) return { positions, groups: [], bridges: [] }

  const adjacency = new Map()
  for (const id of nodes.keys()) adjacency.set(id, [])
  const links = []
  for (const edge of edges.values()) {
    if (edge.from === edge.to || !nodes.has(edge.from) || !nodes.has(edge.to)) continue
    adjacency.get(edge.from).push(edge.to)
    adjacency.get(edge.to).push(edge.from)
    links.push([edge.from, edge.to])
  }
  const colorOf = (id) => nodes.get(id).cluster_color_id || 0

  // Bridge stars leave their group's own layout and go between the two groups.
  const bridges = []
  const bridgeOf = new Map()
  const memberCount = new Map()
  for (const node of nodes.values()) {
    const color = colorOf(node.id)
    if (color) memberCount.set(color, (memberCount.get(color) ?? 0) + 1)
  }
  for (const node of nodes.values()) {
    const own = colorOf(node.id)
    if (!own || memberCount.get(own) <= 2) continue
    const tally = new Map()
    for (const other of adjacency.get(node.id)) {
      const color = colorOf(other)
      if (color) tally.set(color, (tally.get(color) ?? 0) + 1)
    }
    const home = tally.get(own) ?? 0
    let best = 0
    let bestCount = 0
    for (const [color, count] of tally) {
      if (color === own) continue
      if (count > bestCount || (count === bestCount && color < best)) {
        best = color
        bestCount = count
      }
    }
    if (bestCount >= BRIDGE_MIN_LINKS && bestCount >= BRIDGE_RATIO * home) {
      bridges.push({ id: node.id, from: own, to: best })
      bridgeOf.set(node.id, best)
      memberCount.set(own, memberCount.get(own) - 1)
    }
  }

  // Units: one per colour group (bridges left out), and one per unclustered star.
  const unitOf = new Map()
  const units = []
  for (const node of nodes.values()) {
    if (bridgeOf.has(node.id)) continue
    const color = colorOf(node.id)
    const key = color ? `c${color}` : `n${node.id}`
    let unit = unitOf.get(key)
    if (!unit) {
      unit = { key, color, ids: [] }
      unitOf.set(key, unit)
      units.push(unit)
    }
    unit.ids.push(node.id)
  }
  const unitById = new Map()
  for (const unit of units) for (const id of unit.ids) unitById.set(id, unit)
  // A bridge counts toward the pull between its two groups, as one more link.
  const bridgeWeights = bridges.map(({ from, to }) => [unitOf.get(`c${from}`), unitOf.get(`c${to}`)])

  const ctx = { nodes, adjacency, collideOf, baseCollide, inner, gap, gapRatio }
  for (const unit of units) {
    unit.local = layoutGroup(unit.ids, ctx, 0)
    unit.radius = radiusOf(unit.local, collideOf)
  }

  const gapScale = 1
  const placed = arrange(units, links, unitById, bridgeWeights, { arrangement, gapScale, ctx })

  // Bridges: in the gap between their two groups, fanned round the line
  // between them when several share it.
  const lanes = new Map()
  for (const bridge of bridges) {
    const key = `${bridge.from}:${bridge.to}`
    if (!lanes.has(key)) lanes.set(key, [])
    lanes.get(key).push(bridge.id)
  }
  for (const [key, ids] of lanes) {
    const [from, to] = key.split(':').map(Number)
    const a = unitOf.get(`c${from}`)
    const b = unitOf.get(`c${to}`)
    const axis = sub(b.centre, a.centre)
    const length = Math.hypot(...axis) || 1
    const u = axis.map((v) => v / length)
    const surfaceA = a.radius
    const surfaceB = Math.max(surfaceA, length - b.radius)
    const along = (surfaceA + surfaceB) / 2
    const [p, q] = perpendiculars(u)
    const spread = baseCollide * 2.5 * Math.sqrt(ids.length - 1)
    ids.forEach((id, i) => {
      const angle = (i / ids.length) * Math.PI * 2
      const r = ids.length > 1 ? spread : 0
      positions.set(
        id,
        [0, 1, 2].map(
          (k) => a.centre[k] + u[k] * along + (p[k] * Math.cos(angle) + q[k] * Math.sin(angle)) * r,
        ),
      )
    })
  }
  for (const [id, position] of placed) positions.set(id, position)

  // Keep the map where it was, so the camera doesn't lose it.
  const before = centroid([...nodes.values()].map((node) => [node.x, node.y, node.z]))
  const after = centroid([...positions.values()])
  const shift = sub(before, after)
  for (const position of positions.values()) for (let k = 0; k < 3; k++) position[k] += shift[k]
  for (const unit of units) if (unit.centre) for (let k = 0; k < 3; k++) unit.centre[k] += shift[k]

  return {
    positions,
    groups: units
      .filter((unit) => unit.color)
      .map((unit) => ({ color: unit.color, ids: unit.ids, centre: unit.centre, radius: unit.radius })),
    bridges,
  }
}

/**
 * One group's layout in its own frame, centred on the origin: id -> [x, y, z].
 * Under `inner: 'subgroups'` a big group is split with Louvain on its own
 * links and laid out the same way the map is, one level down.
 */
function layoutGroup(ids, ctx, depth) {
  if (ids.length === 1) return new Map([[ids[0], [0, 0, 0]]])
  const set = new Set(ids)
  const links = []
  for (const id of ids)
    for (const other of ctx.adjacency.get(id)) if (other > id && set.has(other)) links.push([id, other])
  // `other > id` keeps one of each pair; ids are strings, compared as such.
  if (ctx.inner === 'subgroups' && depth === 0 && ids.length >= SUBGROUP_MIN) {
    const parts = subgroups(ids, links)
    if (parts.length > 1) {
      const units = parts.map((part, i) => ({ key: `s${i}`, color: i + 1, ids: part }))
      const unitById = new Map()
      for (const unit of units) for (const id of unit.ids) unitById.set(id, unit)
      for (const unit of units) {
        unit.local = layoutGroup(unit.ids, ctx, depth + 1)
        unit.radius = radiusOf(unit.local, ctx.collideOf)
      }
      const placed = arrange(units, links, unitById, [], {
        arrangement: 'free',
        gapScale: SUBGROUP_GAP_SCALE,
        ctx,
      })
      return recentre(placed)
    }
  }
  return relaxGroup(ids, links, ctx, ctx.inner === 'rings')
}

/** Louvain on one group's own links; parts smaller than 3 join the part they link to most. */
function subgroups(ids, links) {
  const graph = new Graph({ type: 'undirected' })
  for (const id of ids) graph.addNode(id)
  for (const [a, b] of links) graph.mergeEdge(a, b)
  if (graph.size === 0) return [ids]
  const community = louvain(graph, { rng: seededRandom(SEED), resolution: 1 })
  const parts = new Map()
  for (const id of ids) {
    const c = community[id]
    if (!parts.has(c)) parts.set(c, [])
    parts.get(c).push(id)
  }
  const big = [...parts.values()].filter((part) => part.length >= 3)
  if (big.length < 2) return [ids]
  const home = new Map()
  big.forEach((part, i) => part.forEach((id) => home.set(id, i)))
  const neighbours = new Map(ids.map((id) => [id, []]))
  for (const [a, b] of links) {
    neighbours.get(a).push(b)
    neighbours.get(b).push(a)
  }
  for (const part of parts.values()) {
    if (part.length >= 3) continue
    for (const id of part) {
      const tally = new Map()
      for (const other of neighbours.get(id))
        if (home.has(other)) tally.set(home.get(other), (tally.get(home.get(other)) ?? 0) + 1)
      let best = 0
      let bestCount = -1
      for (const [i, count] of tally) if (count > bestCount) [best, bestCount] = [i, count]
      big[best].push(id)
    }
  }
  return big
}

/**
 * A force layout of one group's stars on their own links, to rest. With
 * `rings`, each star is also held on a sphere round the group's centre whose
 * radius is its link distance from the nearest core (the best-linked star if
 * the group has no core): cores in the middle, everything else in shells.
 */
function relaxGroup(ids, links, ctx, rings) {
  const random = seededRandom(SEED ^ ids.length)
  const bodies = ids.map((id) => {
    const node = ctx.nodes.get(id)
    const nexus = node.is_nexus === true
    return { id, collide: ctx.collideOf(id), nexus, charge: nexus ? CHARGE * NEXUS_CHARGE_SCALE : CHARGE }
  })
  const byId = new Map(bodies.map((body) => [body.id, body]))
  const degree = new Map(ids.map((id) => [id, 0]))
  for (const [a, b] of links) {
    degree.set(a, degree.get(a) + 1)
    degree.set(b, degree.get(b) + 1)
  }
  const linkData = links.map(([a, b]) => {
    const from = byId.get(a)
    const to = byId.get(b)
    const rest = LINK_DISTANCE + from.collide + to.collide - 2 * ctx.baseCollide
    return {
      source: a,
      target: b,
      distance: from.nexus || to.nexus ? rest * NEXUS_LINK_SCALE : rest,
      strength: 1 / Math.min(degree.get(a), degree.get(b)),
    }
  })

  const simulation = forceSimulation([], 3).randomSource(random).stop()
  simulation.nodes(bodies)
  simulation
    .force(
      'link',
      forceLink(linkData)
        .id((body) => body.id)
        .distance((link) => link.distance)
        .strength((link) => link.strength),
    )
    .force(
      'charge',
      forceManyBody()
        .strength((body) => body.charge)
        .distanceMax(CHARGE_RANGE)
        .theta(CHARGE_THETA),
    )
    .force(
      'collide',
      forceCollide((body) => body.collide),
    )
    .force(
      'edgeRepel',
      forceEdgeRepel(
        links.map(([a, b]) => [byId.get(a), byId.get(b)]),
        random,
      ),
    )

  if (rings) {
    const depth = ringDepths(ids, links, ctx.nodes, degree)
    simulation.force('rings', forceRadial((body) => depth.get(body.id) * RING_STEP).strength(0.6))
  } else {
    const gravity =
      GROUP_GRAVITY * Math.min(1, Math.max(0, (ids.length - GRAVITY_FROM) / (GRAVITY_FULL - GRAVITY_FROM)))
    simulation
      .force('gx', forceX(0).strength(gravity))
      .force('gy', forceY(0).strength(gravity))
      .force('gz', forceZ(0).strength(gravity))
  }
  simulation.alpha(1).alphaDecay(1 - Math.pow(0.001, 1 / GROUP_TICKS))
  for (let i = 0; i < GROUP_TICKS; i++) simulation.tick()
  return recentre(new Map(bodies.map((body) => [body.id, [body.x, body.y, body.z]])))
}

/** Links from the nearest core, breadth-first; a star the walk never reaches sits one ring past the last. */
function ringDepths(ids, links, nodes, degree) {
  const neighbours = new Map(ids.map((id) => [id, []]))
  for (const [a, b] of links) {
    neighbours.get(a).push(b)
    neighbours.get(b).push(a)
  }
  let roots = ids.filter((id) => nodes.get(id).is_core)
  if (!roots.length) roots = [ids.reduce((best, id) => (degree.get(id) > degree.get(best) ? id : best))]
  const depth = new Map(roots.map((id) => [id, 0]))
  const queue = [...roots]
  while (queue.length) {
    const id = queue.shift()
    for (const other of neighbours.get(id)) {
      if (depth.has(other)) continue
      depth.set(other, depth.get(id) + 1)
      queue.push(other)
    }
  }
  const deepest = Math.max(...depth.values())
  for (const id of ids) if (!depth.has(id)) depth.set(id, deepest + 1)
  return depth
}

/**
 * `arrange` for callers outside this file (`treeLayout.js`): places `units`
 * — `{ key, ids, local: id -> [x, y, z], radius }`, each laid out in its own
 * frame — as balls with gaps between them, turned to face the units they link
 * to. `links` are [id, id] pairs. Returns id -> [x, y, z] and sets
 * `unit.centre`.
 */
export function arrangeUnits(
  units,
  links,
  { arrangement = 'free', gap = GAP_BASE, gapRatio = GAP_RATIO } = {},
) {
  const unitById = new Map()
  for (const unit of units) for (const id of unit.ids) unitById.set(id, unit)
  return arrange(units, links, unitById, [], { arrangement, gapScale: 1, ctx: { gap, gapRatio } })
}

/**
 * Lays out units (groups or sub-groups, each already laid out in its own frame
 * with a measured `radius`) as single bodies, turns each to face the units it
 * links to, and returns every star's position: id -> [x, y, z]. Sets
 * `unit.centre`.
 */
function arrange(units, links, unitById, extraWeights, { arrangement, gapScale, ctx }) {
  // How many links each pair of units shares.
  const weights = new Map()
  const addWeight = (a, b) => {
    if (a === b) return
    const [x, y] = a.key < b.key ? [a, b] : [b, a]
    const key = `${x.key}|${y.key}`
    const entry = weights.get(key) ?? { a: x, b: y, w: 0 }
    entry.w++
    weights.set(key, entry)
  }
  for (const [a, b] of links) {
    const ua = unitById.get(a)
    const ub = unitById.get(b)
    if (ua && ub) addWeight(ua, ub)
  }
  for (const [a, b] of extraWeights) if (a && b) addWeight(a, b)

  const gapOf = (a, b) => (ctx.gap + (ctx.gapRatio * (a.radius + b.radius)) / 2) * gapScale
  // Big groups first, so the phyllotaxis start puts them near the middle.
  const order = [...units].sort((a, b) => b.ids.length - a.ids.length || (a.key < b.key ? -1 : 1))
  const bodies = order.map((unit) => ({ unit, radius: unit.radius }))
  const bodyOf = new Map(bodies.map((body) => [body.unit, body]))
  const maxWeight = Math.max(1, ...[...weights.values()].map((entry) => entry.w))
  const linkData = [...weights.values()].map(({ a, b, w }) => ({
    source: bodyOf.get(a),
    target: bodyOf.get(b),
    distance: a.radius + b.radius + gapOf(a, b),
    // More shared links, a stronger pull; one link still counts for something.
    strength: 0.15 + 0.85 * Math.sqrt(w / maxWeight),
  }))

  if (bodies.length > 1) {
    const meanGap = ctx.gap * gapScale
    const simulation = forceSimulation([], 3).randomSource(seededRandom(SEED)).stop()
    simulation.nodes(bodies)
    simulation
      .force(
        'link',
        forceLink(linkData)
          .distance((link) => link.distance)
          .strength((link) => link.strength),
      )
      .force('collide', forceCollide((body) => body.radius + meanGap / 2).iterations(4))
      // A gentle push that grows with a unit's size spreads unlinked groups
      // out instead of letting them pile into one side.
      .force(
        'charge',
        forceManyBody().strength((body) => -10 * Math.sqrt(body.unit.ids.length)),
      )
      .force('center', forceCenter(0, 0, 0))
    // Pull toward the middle so a loose group doesn't drift off on its own.
    simulation.force('gather', forceRadial(0).strength(0.1))
    if (arrangement === 'disc') simulation.force('flat', forceY(0).strength(0.4))
    // A sheet: every centre in the y = 0 plane, for units that are flat in it
    // themselves (the tree Balance's discs), so the whole map is one plane.
    if (arrangement === 'sheet') simulation.force('flat', forceY(0).strength(1))
    if (arrangement === 'shell') {
      // A sphere with room for every ball, at about 55% of its surface covered.
      let area = 0
      for (const body of bodies) area += (body.radius + meanGap / 2) ** 2
      const shell = Math.sqrt(area / (4 * 0.55))
      simulation.force('gather', forceRadial(shell).strength(0.3))
    }
    simulation.alpha(1).alphaDecay(1 - Math.pow(0.001, 1 / ARRANGE_TICKS))
    for (let i = 0; i < ARRANGE_TICKS; i++) simulation.tick()
    if (arrangement === 'sheet') for (const body of bodies) body.y = 0
    // Collision ran against a padded radius; one last exact pass makes sure no
    // two balls are closer than their gap, whatever the forces left.
    separate(bodies, gapOf)
  } else {
    Object.assign(bodies[0], { x: 0, y: 0, z: 0 })
  }
  for (const body of bodies) body.unit.centre = [body.x, body.y, body.z]

  // Turn each unit so its stars that link out face the units they link to.
  const outward = new Map() // id -> [dx, dy, dz, links]
  for (const [a, b] of links) {
    const ua = unitById.get(a)
    const ub = unitById.get(b)
    if (!ua || !ub || ua === ub) continue
    towards(outward, a, ua.centre, ub.centre)
    towards(outward, b, ub.centre, ua.centre)
  }
  const placed = new Map()
  for (const unit of units) {
    const rotation = facing(unit, outward, arrangement === 'sheet')
    for (const id of unit.ids) {
      const p = rotate(rotation, unit.local.get(id))
      placed.set(id, [unit.centre[0] + p[0], unit.centre[1] + p[1], unit.centre[2] + p[2]])
    }
  }
  return placed
}

/** Pushes any two balls closer than their radii plus gap apart, a few passes. */
function separate(bodies, gapOf) {
  for (let pass = 0; pass < 50; pass++) {
    let moved = false
    for (let i = 0; i < bodies.length; i++)
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]
        const b = bodies[j]
        const need = a.radius + b.radius + gapOf(a.unit, b.unit)
        let dx = b.x - a.x
        let dy = b.y - a.y
        let dz = b.z - a.z
        let d = Math.hypot(dx, dy, dz)
        if (d >= need) continue
        if (d < 1e-6) [dx, dy, dz, d] = [1, 0, 0, 1]
        const push = (need - d) / d
        const shareA = b.unit.ids.length / (a.unit.ids.length + b.unit.ids.length)
        a.x -= dx * push * shareA
        a.y -= dy * push * shareA
        a.z -= dz * push * shareA
        b.x += dx * push * (1 - shareA)
        b.y += dy * push * (1 - shareA)
        b.z += dz * push * (1 - shareA)
        moved = true
      }
    if (!moved) return
  }
}

function towards(outward, id, from, to) {
  const d = sub(to, from)
  const length = Math.hypot(...d) || 1
  const entry = outward.get(id) ?? [0, 0, 0, 0]
  entry[0] += d[0] / length
  entry[1] += d[1] / length
  entry[2] += d[2] / length
  entry[3]++
  outward.set(id, entry)
}

/**
 * The rotation that best turns each outward-linking star's offset toward the
 * direction of the units it links to (Horn's quaternion method: the top
 * eigenvector of a 4×4 built from the weighted cross-covariance, found by
 * power iteration). Identity when nothing in the unit links out.
 */
function facing(unit, outward, flat = false) {
  const S = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  let total = 0
  for (const id of unit.ids) {
    const out = outward.get(id)
    if (!out) continue
    const p = unit.local.get(id)
    const reach = Math.hypot(...p)
    const dir = Math.hypot(out[0], out[1], out[2])
    if (reach < 1e-6 || dir < 1e-6) continue
    const q = [0, 1, 2].map((k) => (out[k] / dir) * reach)
    const w = out[3]
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += w * p[r] * q[c]
    total += w
  }
  if (!total) return [1, 0, 0, 0]
  // Flat: only a turn about y, so a unit lying in the sheet stays in it. The
  // best angle has a closed form: θ = atan2(Σ w (pz qx − px qz), Σ w (px qx + pz qz)).
  if (flat) {
    const theta = Math.atan2(S[2][0] - S[0][2], S[0][0] + S[2][2])
    return [Math.cos(theta / 2), 0, Math.sin(theta / 2), 0]
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ]
  // Shift so every eigenvalue is positive; power iteration then finds the largest.
  let shift = 0
  for (const row of N) for (const v of row) shift += Math.abs(v)
  for (let i = 0; i < 4; i++) N[i][i] += shift
  let v = [1, 0.1, 0.2, 0.3]
  for (let iteration = 0; iteration < 200; iteration++) {
    const next = N.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2] + row[3] * v[3])
    const length = Math.hypot(...next) || 1
    v = next.map((x) => x / length)
  }
  return v
}

/** Rotates p by the unit quaternion [w, x, y, z]. */
function rotate([w, x, y, z], p) {
  const [px, py, pz] = p
  return [
    (1 - 2 * (y * y + z * z)) * px + 2 * (x * y - w * z) * py + 2 * (x * z + w * y) * pz,
    2 * (x * y + w * z) * px + (1 - 2 * (x * x + z * z)) * py + 2 * (y * z - w * x) * pz,
    2 * (x * z - w * y) * px + 2 * (y * z + w * x) * py + (1 - 2 * (x * x + y * y)) * pz,
  ]
}

/** Ball radius of a laid-out group: its furthest star plus that star's shell. */
function radiusOf(local, collideOf) {
  let radius = 0
  for (const [id, p] of local) radius = Math.max(radius, Math.hypot(...p) + collideOf(id))
  return radius
}

function recentre(local) {
  const c = centroid([...local.values()])
  for (const p of local.values()) for (let k = 0; k < 3; k++) p[k] -= c[k]
  return local
}

function centroid(points) {
  const c = [0, 0, 0]
  for (const p of points) for (let k = 0; k < 3; k++) c[k] += p[k]
  const n = points.length || 1
  return c.map((v) => v / n)
}

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/** Two unit vectors perpendicular to u and to each other. */
function perpendiculars(u) {
  const helper = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const p = cross(u, helper)
  const lp = Math.hypot(...p) || 1
  const pn = p.map((v) => v / lp)
  return [pn, cross(u, pn)]
}

/**
 * Repulsion between edges: a phantom at each edge's midpoint runs through a
 * real forceManyBody, and its push lands on both endpoints, so two lines
 * running close together move apart bodily. Moved here from the old
 * physics.js unchanged in effect; it is what opens up a small, densely linked
 * group that is all one colour.
 */
function forceEdgeRepel(segments, random) {
  const phantoms = segments.map((_, index) => ({ index, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }))
  const many = forceManyBody()
    .strength(EDGE_REPEL_STRENGTH)
    .distanceMin(EDGE_REPEL_MIN)
    .distanceMax(EDGE_REPEL_RANGE)
    .theta(CHARGE_THETA)
  many.initialize(phantoms, random, 3)

  function force(alpha) {
    const n = segments.length
    if (n < 2) return
    for (let i = 0; i < n; i++) {
      const [a, b] = segments[i]
      const p = phantoms[i]
      p.x = (a.x + b.x) * 0.5
      p.y = (a.y + b.y) * 0.5
      p.z = (a.z + b.z) * 0.5
      p.vx = p.vy = p.vz = 0
    }
    many(alpha)
    for (let i = 0; i < n; i++) {
      const [a, b] = segments[i]
      const { vx, vy, vz } = phantoms[i]
      a.vx += vx
      a.vy += vy
      a.vz += vz
      b.vx += vx
      b.vy += vy
      b.vz += vz
    }
  }
  force.initialize = () => {}
  return force
}
