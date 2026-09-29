/**
 * Orbit view (`context/BALANCE2.md`, prototype round 2): the whole map laid out
 * round one star, flat, facing the camera. Plain data, no Three.js.
 *
 * A radial tree. The star stays where it is; every star one link away sits on
 * a ring round it, two links away on the next ring out, and so on. Each star
 * on the first ring owns a wedge of the circle as wide as the share of the map
 * reached through it, and the stars reached through it are placed inside that
 * wedge, ring by ring — so branches never cross each other, and "how do I get
 * from here to there" is read by following one line straight outward. Stars
 * the walk never reaches go on a last, outer ring.
 *
 * Flat on purpose: a first version put the rings on spheres, which from any
 * one place reads as a ball with lines crossing through it. In the plane the
 * camera looks at, the whole tree is one picture.
 *
 * On the first ring, stars of one colour group sit next to each other.
 */

// Distance between rings, world units: a little over two links.
const RING_STEP = 140
// Room each star wants along its ring, in multiples of its collision radius;
// a crowded ring grows past RING_STEP rather than packing stars together.
const ROOM = 3.4
// Passes of the spacing sweep along each ring (see `computeOrbit`).
const SPREAD_PASSES = 80

/**
 * Positions for every star, laid out round `centreId` in the plane spanned by
 * the unit vectors `right` and `up` (the camera's): id -> [x, y, z].
 * `neighbours(id)` yields the ids linked to `id` (graph.js's own).
 */
export function computeOrbit(nodes, neighbours, centreId, { collideOf, right = [1, 0, 0], up = [0, 1, 0] }) {
  const positions = new Map()
  const centre = nodes.get(centreId)
  if (!centre) return positions
  const origin = [centre.x, centre.y, centre.z]

  // The breadth-first tree: each star's parent is the first star on the ring
  // inside it that reaches it, children in the order they were found.
  const depth = new Map([[centreId, 0]])
  const children = new Map([[centreId, []]])
  const queue = [centreId]
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]
    for (const other of neighbours(id)) {
      if (!nodes.has(other) || depth.has(other)) continue
      depth.set(other, depth.get(id) + 1)
      children.get(id).push(other)
      children.set(other, [])
      queue.push(other)
    }
  }
  // Keep a group together on the first ring, and within a branch.
  const colour = (id) => nodes.get(id).cluster_color_id || 0
  for (const list of children.values()) list.sort((a, b) => colour(a) - colour(b))

  const weight = new Map()
  const weigh = (id) => {
    let w = 1
    for (const child of children.get(id)) w += weigh(child)
    weight.set(id, w)
    return w
  }
  weigh(centreId)

  // Ring radii: RING_STEP apart, wider where a ring holds more than fits.
  const perRing = []
  for (const [id, d] of depth) {
    if (d === 0) continue
    perRing[d] = (perRing[d] ?? 0) + ROOM * collideOf(id)
  }
  const unreached = [...nodes.keys()].filter((id) => !depth.has(id))
  const radii = [0]
  for (let d = 1; d < perRing.length; d++)
    radii[d] = Math.max(radii[d - 1] + RING_STEP, (perRing[d] ?? 0) / (2 * Math.PI))

  const angles = new Map()
  const place = (id, angle, radius) => {
    const c = Math.cos(angle) * radius
    const s = Math.sin(angle) * radius
    positions.set(
      id,
      [0, 1, 2].map((k) => origin[k] + right[k] * c + up[k] * s),
    )
  }
  positions.set(centreId, origin)
  // Each subtree gets a wedge as wide as its share; a star sits in the middle of its own.
  const lay = (id, from, to) => {
    const kids = children.get(id)
    const total = kids.reduce((sum, child) => sum + weight.get(child), 0)
    let at = from
    for (const child of kids) {
      const span = ((to - from) * weight.get(child)) / total
      angles.set(child, at + span / 2)
      lay(child, at, at + span)
      at += span
    }
  }
  // Start at the top, going clockwise as seen from the camera.
  lay(centreId, Math.PI / 2, Math.PI / 2 - 2 * Math.PI)

  // Wedges follow branch size, so a run of leaves gets a sliver each and
  // lands in a pile. Spread each ring so neighbours are at least their room
  // apart, keeping their order round it.
  const rings = []
  for (const [id, angle] of angles) {
    const d = depth.get(id)
    ;(rings[d] ??= []).push({ id, angle })
  }
  rings.forEach((ring, d) => {
    if (!ring) return
    ring.sort((a, b) => a.angle - b.angle)
    const gap = (i) =>
      (ROOM * (collideOf(ring[i].id) + collideOf(ring[(i + 1) % ring.length].id))) / 2 / radii[d]
    for (let pass = 0; ring.length > 1 && pass < SPREAD_PASSES; pass++) {
      let moved = false
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        const between = i === ring.length - 1 ? b.angle + 2 * Math.PI - a.angle : b.angle - a.angle
        const short = gap(i) - between
        if (short <= 1e-6) continue
        a.angle -= short / 2
        b.angle += short / 2
        moved = true
      }
      if (!moved) break
    }
    for (const { id, angle } of ring) place(id, angle, radii[d])
  })

  if (unreached.length) {
    let room = 0
    for (const id of unreached) room += ROOM * collideOf(id)
    const outer = Math.max(radii[radii.length - 1] + RING_STEP * 1.5, room / (2 * Math.PI))
    unreached
      .sort((a, b) => colour(a) - colour(b))
      .forEach((id, i) => place(id, Math.PI / 2 - (2 * Math.PI * (i + 0.5)) / unreached.length, outer))
  }
  return positions
}
