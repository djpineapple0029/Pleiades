/**
 * Lanes (`context/BALANCE2.md`): the links between two colour groups drawn as
 * one bundle instead of a web of separate straight lines. Plain data, no
 * Three.js — `edges.js` draws what this computes.
 *
 * Every link from group A to group B leaves its star, gathers at A's *port*
 * (the point on A's edge facing B), runs across the gap to B's port, and fans
 * out to its star in B. Links between the same two groups share both ports, so
 * however many there are they read as one lane between the two, and the more
 * there are the brighter it is. Each keeps a little of its own star's offset at
 * the port, so a lane is a cable of strands rather than one line.
 *
 * Groups are measured from the stars' current positions, not from the last
 * Balance, so lanes follow a Balance in flight, an edit, or a file straight
 * off disk alike.
 *
 * Left straight: a link inside one group, a link to an unclustered star, a link
 * to a group too small to have a shape (fewer than MIN_GROUP stars), and a link
 * whose star sits well outside its group's ball — a bridge star in the gap
 * between two groups already is the lane.
 */

// A group's ball: this share of its stars lie inside the measured radius, and
// the ball is that distance times RADIUS_PAD. A plain maximum would let one
// straggler set the port for the whole group.
const RADIUS_QUANTILE = 0.85
const RADIUS_PAD = 1.1
// A star further than this many radii from its group's centre is outside the
// group (a bridge) and its links are left straight.
const OUTSIDE = 1.35
const MIN_GROUP = 3
// How far in from the ball's edge the port sits, in radii, and how much of a
// star's sideways offset from the centre line it keeps there.
const PORT_DEPTH = 0.9
const PORT_SPREAD = 0.18
// Points along each lane: fixed, so a lane's geometry only has to be rebuilt
// when the set of lanes changes, not every frame.
export const LANE_POINTS = 21

/**
 * Lane routes for every bundled link: edge id -> Float32Array of LANE_POINTS
 * xyz points, from the edge's `from` star to its `to` star. `nodes` / `edges`
 * are graph.js's id -> object maps.
 */
export function computeLanes(nodes, edges, groups = measureGroups(nodes)) {
  const routes = new Map()
  const inside = (node, group) =>
    Math.hypot(node.x - group.c[0], node.y - group.c[1], node.z - group.c[2]) <= OUTSIDE * group.r

  for (const edge of edges.values()) {
    const from = nodes.get(edge.from)
    const to = nodes.get(edge.to)
    if (!from || !to || from === to) continue
    const a = groups.get(from.cluster_color_id)
    const b = groups.get(to.cluster_color_id)
    if (!a || !b || a === b) continue
    if (a.members.length < MIN_GROUP || b.members.length < MIN_GROUP) continue
    if (!inside(from, a) || !inside(to, b)) continue
    const axis = [b.c[0] - a.c[0], b.c[1] - a.c[1], b.c[2] - a.c[2]]
    const length = Math.hypot(...axis)
    // Overlapping groups (a map balanced before this layout) have no gap to
    // run a lane across.
    if (length < (a.r + b.r) * 0.6) continue
    const u = axis.map((v) => v / length)
    const p = [from.x, from.y, from.z]
    const q = [to.x, to.y, to.z]
    const portA = port(a.c, u, a.r, p)
    const portB = port(
      b.c,
      u.map((v) => -v),
      b.r,
      q,
    )
    routes.set(edge.id, route(p, portA, portB, q))
  }
  return routes
}

/** The port on a group's ball facing `u`, nudged by a share of the star's own sideways offset. */
function port(centre, u, radius, star) {
  const d = [star[0] - centre[0], star[1] - centre[1], star[2] - centre[2]]
  const along = d[0] * u[0] + d[1] * u[1] + d[2] * u[2]
  return [0, 1, 2].map((k) => centre[k] + u[k] * radius * PORT_DEPTH + (d[k] - u[k] * along) * PORT_SPREAD)
}

/**
 * A centripetal Catmull-Rom curve through star, port, port, star, sampled at
 * LANE_POINTS points: a third of them for each piece, the long middle one
 * getting the remainder. Centripetal, so a piece never loops or overshoots
 * however uneven the three lengths are.
 */
function route(p, portA, portB, q) {
  const points = [mirror(p, portA), p, portA, portB, q, mirror(q, portB)]
  const out = new Float32Array(LANE_POINTS * 3)
  const ends = Math.floor((LANE_POINTS - 1) / 3)
  const counts = [ends, LANE_POINTS - 1 - 2 * ends, ends]
  let o = 0
  for (let piece = 0; piece < 3; piece++) {
    const [p0, p1, p2, p3] = points.slice(piece, piece + 4)
    const steps = counts[piece]
    for (let s = 0; s < steps; s++) {
      const point = catmullRom(p0, p1, p2, p3, s / steps)
      out[o++] = point[0]
      out[o++] = point[1]
      out[o++] = point[2]
    }
  }
  out.set(q, o)
  return out
}

/** p reflected through the point `about`, to give an end of the curve a tangent. */
function mirror(p, about) {
  return [2 * p[0] - about[0], 2 * p[1] - about[1], 2 * p[2] - about[2]]
}

function catmullRom(p0, p1, p2, p3, t) {
  const knot = (a, b) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])))
  const t0 = 0
  const t1 = t0 + knot(p0, p1)
  const t2 = t1 + knot(p1, p2)
  const t3 = t2 + knot(p2, p3)
  const x = t1 + (t2 - t1) * t
  const lerp = (a, b, ta, tb) => {
    const w = (x - ta) / (tb - ta)
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w]
  }
  const a1 = lerp(p0, p1, t0, t1)
  const a2 = lerp(p1, p2, t1, t2)
  const a3 = lerp(p2, p3, t2, t3)
  const b1 = lerp(a1, a2, t0, t2)
  const b2 = lerp(a2, a3, t1, t3)
  return lerp(b1, b2, t1, t2)
}

/**
 * Every colour group's centre `c` and ball radius `r`, measured from where its
 * stars are now, with its `members`: colour id -> group. Shared with the
 * nebulae, which sit on the same balls.
 */
export function measureGroups(nodes) {
  const groups = new Map()
  for (const node of nodes.values()) {
    const color = node.cluster_color_id
    if (!color) continue
    let group = groups.get(color)
    if (!group) groups.set(color, (group = { members: [], c: [0, 0, 0], r: 0 }))
    group.members.push(node)
    group.c[0] += node.x
    group.c[1] += node.y
    group.c[2] += node.z
  }
  for (const group of groups.values()) {
    const n = group.members.length
    group.c = group.c.map((v) => v / n)
    const distances = group.members.map((m) =>
      Math.hypot(m.x - group.c[0], m.y - group.c[1], m.z - group.c[2]),
    )
    distances.sort((a, b) => a - b)
    group.r = distances[Math.min(n - 1, Math.floor(RADIUS_QUANTILE * (n - 1)))] * RADIUS_PAD
  }
  return groups
}

// Cross-links as arcs (`context/BALANCE2.md` §8): how far the middle of an arc
// bows out from the straight line, as a share of the line's length.
const ARC_BOW = 0.13

/**
 * One arc per link in `ids` (the backbone's cross-links): edge id ->
 * Float32Array of LANE_POINTS xyz points, a quadratic curve from `from` to
 * `to`. Never bundled — every arc is its own — and each bows away from the
 * map's centre, so the curves read as a different kind of line from the
 * straight branches and don't run along them.
 */
export function computeArcs(nodes, edges, ids) {
  const routes = new Map()
  if (!ids.size) return routes
  const centre = [0, 0, 0]
  for (const node of nodes.values()) {
    centre[0] += node.x / nodes.size
    centre[1] += node.y / nodes.size
    centre[2] += node.z / nodes.size
  }
  for (const id of ids) {
    const edge = edges.get(id)
    const a = edge && nodes.get(edge.from)
    const b = edge && nodes.get(edge.to)
    if (!a || !b) continue
    const p = [a.x, a.y, a.z]
    const q = [b.x, b.y, b.z]
    const chord = [q[0] - p[0], q[1] - p[1], q[2] - p[2]]
    const length = Math.hypot(...chord)
    if (length < 1e-6) continue
    const u = chord.map((v) => v / length)
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]
    // Away from the centre, square to the line; any square direction when the
    // line runs through the centre.
    let out = [mid[0] - centre[0], mid[1] - centre[1], mid[2] - centre[2]]
    const along = out[0] * u[0] + out[1] * u[1] + out[2] * u[2]
    out = out.map((v, k) => v - u[k] * along)
    let size = Math.hypot(...out)
    if (size < 1e-6) {
      out = Math.abs(u[1]) < 0.9 ? [u[2], 0, -u[0]] : [0, -u[2], u[1]]
      size = Math.hypot(...out)
    }
    const control = mid.map((v, k) => v + (out[k] / size) * length * ARC_BOW * 2)
    const arc = new Float32Array(LANE_POINTS * 3)
    for (let i = 0; i < LANE_POINTS; i++) {
      const t = i / (LANE_POINTS - 1)
      const s = 1 - t
      for (let k = 0; k < 3; k++) arc[i * 3 + k] = s * s * p[k] + 2 * s * t * control[k] + t * t * q[k]
    }
    routes.set(id, arc)
  }
  return routes
}
