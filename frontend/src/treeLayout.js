/**
 * Tree Balance (`context/BALANCE2.md` §8): the map laid out along its
 * backbone (`backbone.js`), the way a mind map is — each core a central topic
 * with its branches round it — instead of by physics over every link. Plain
 * data, no Three.js.
 *
 * Each tree is laid out on its own, then the trees are placed apart as balls
 * the way colour groups are (`constellation.arrangeUnits`: trees that share
 * more cross-links sit nearer, each turned to face the ones it links to).
 * Two shapes, being compared:
 * - `disc`: a flat radial tree (`orbit.radialTree`), the orbit view's layout.
 * - `cone`: a cone tree (Robertson et al. 1991) — a star's children spread
 *   round a cone opening away from its parent, so the tree uses depth.
 */

import { forceSimulation, forceCollide, forceX, forceY, forceZ } from 'd3-force-3d'
import { computeBackbone } from './backbone.js'
import { arrangeUnits, LINK_DISTANCE } from './constellation.js'
import { radialTree } from './orbit.js'
import { seededRandom } from './random.js'

// Ring spacing of a disc tree.
const DISC_RING = LINK_DISTANCE * 1.8
// Cone tree: distance from a star to its children, growing with the size of
// the child's own branch so a big branch gets room to open; and how wide a
// cone opens, per child, up to CONE_MAX.
const CONE_STEP = LINK_DISTANCE * 1.4
const CONE_GROW = 0.45
const CONE_MAX = 1.05 // radians, about 60°
// Gaps between trees, as for colour groups but tighter: trees are big.
const TREE_GAP = LINK_DISTANCE * 1.5
const TREE_GAP_RATIO = 0.3
// A last collision pass inside a cone tree, which can put two branches' stars
// on top of each other.
const SEPARATE_TICKS = 80

/**
 * Positions for every star: `{ positions: id -> [x, y, z], backbone }`.
 * `collideOf(id)` is a star's collision radius.
 */
export function computeTreeLayout(nodes, edges, { collideOf, shape = 'disc' }) {
  const backbone = computeBackbone(nodes, edges)
  const colour = (id) => nodes.get(id).cluster_color_id || 0
  // A branch's colour group together round its parent.
  for (const list of backbone.children.values()) list.sort((a, b) => colour(a) - colour(b))

  const units = backbone.roots.map((root) => {
    const ids = [root]
    for (let head = 0; head < ids.length; head++) ids.push(...backbone.children.get(ids[head]))
    const local =
      shape === 'cone'
        ? coneTree(root, backbone.children, collideOf)
        : discTree(root, backbone.children, collideOf)
    let radius = 0
    for (const [id, p] of local) radius = Math.max(radius, Math.hypot(...p) + collideOf(id))
    return { key: `t${root}`, color: colour(root), ids, local, radius }
  })

  const links = []
  for (const edge of edges.values())
    if (edge.from !== edge.to && nodes.has(edge.from) && nodes.has(edge.to)) links.push([edge.from, edge.to])
  // Disc trees lie flat in one sheet (each turned within it to face its
  // partners), so the map reads like one mind-map page; placed freely, each
  // was a plate at its own angle, and many were seen edge-on.
  const positions = arrangeUnits(units, links, {
    gap: TREE_GAP,
    gapRatio: TREE_GAP_RATIO,
    arrangement: shape === 'disc' ? 'sheet' : 'free',
  })

  // Keep the map where it was, so the camera doesn't lose it.
  const centroid = (points) => {
    const c = [0, 0, 0]
    for (const p of points) for (let k = 0; k < 3; k++) c[k] += p[k] / points.length
    return c
  }
  const before = centroid([...nodes.values()].map((node) => [node.x, node.y, node.z]))
  const after = centroid([...positions.values()])
  for (const p of positions.values()) for (let k = 0; k < 3; k++) p[k] += before[k] - after[k]
  return { positions, backbone }
}

function discTree(root, children, collideOf) {
  const { flat } = radialTree(root, children, collideOf, { ringStep: DISC_RING })
  const local = new Map()
  // In the x-z plane: the sheet the trees are arranged in (see above).
  for (const [id, [x, y]] of flat) local.set(id, [x, 0, y])
  return local
}

function coneTree(root, children, collideOf) {
  const weight = new Map()
  const weigh = (id) => {
    let w = 1
    for (const child of children.get(id)) w += weigh(child)
    weight.set(id, w)
    return w
  }
  weigh(root)
  const local = new Map([[root, [0, 0, 0]]])
  const random = seededRandom(root.length * 7919 + weight.get(root))
  const reach = (id) => CONE_STEP * (1 + CONE_GROW * Math.log2(weight.get(id)))

  const lay = (id, axis) => {
    const kids = children.get(id)
    if (!kids.length) return
    const at = local.get(id)
    let dirs
    if (!axis) {
      dirs = fibonacci(kids.length)
    } else if (kids.length === 1) {
      dirs = [axis]
    } else {
      const open = Math.min(CONE_MAX, 0.3 + 0.09 * kids.length)
      const [p, q] = perpendiculars(axis)
      const turn = random() * Math.PI * 2
      dirs = kids.map((_, i) => {
        const phi = turn + (2 * Math.PI * i) / kids.length
        return [0, 1, 2].map(
          (k) => Math.cos(open) * axis[k] + Math.sin(open) * (Math.cos(phi) * p[k] + Math.sin(phi) * q[k]),
        )
      })
    }
    kids.forEach((child, i) => {
      const d = reach(child)
      local.set(
        child,
        [0, 1, 2].map((k) => at[k] + dirs[i][k] * d),
      )
      lay(child, dirs[i])
    })
  }
  lay(root, null)

  // Two branches can cross; push overlapping stars apart, each held near
  // where the cone put it.
  const bodies = [...local].map(([id, [x, y, z]]) => ({
    id,
    x,
    y,
    z,
    tx: x,
    ty: y,
    tz: z,
    r: collideOf(id) * 1.6,
  }))
  if (bodies.length > 1) {
    const simulation = forceSimulation([], 3).randomSource(seededRandom(11)).stop()
    simulation.nodes(bodies)
    simulation
      .force('collide', forceCollide((b) => b.r).iterations(2))
      .force('x', forceX((b) => b.tx).strength(0.08))
      .force('y', forceY((b) => b.ty).strength(0.08))
      .force('z', forceZ((b) => b.tz).strength(0.08))
    simulation.alpha(0.6)
    for (let i = 0; i < SEPARATE_TICKS; i++) simulation.tick()
    for (const b of bodies) local.set(b.id, [b.x, b.y, b.z])
  }
  const c = local.get(root).slice()
  for (const p of local.values()) for (let k = 0; k < 3; k++) p[k] -= c[k]
  return local
}

function fibonacci(n) {
  const points = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n
    const r = Math.sqrt(1 - y * y)
    points.push([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r])
  }
  return points
}

function perpendiculars(u) {
  const helper = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const p = cross(u, helper)
  const lp = Math.hypot(...p) || 1
  const pn = p.map((v) => v / lp)
  return [pn, cross(u, pn)]
}
