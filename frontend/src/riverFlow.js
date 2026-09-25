/**
 * Dust rivers: grains that swirl around stars and flow along the links between
 * them. Plain data, no Three.js — `dustRivers.js` draws what this computes.
 *
 * Each grain carries its own state, so it takes a real route through the map:
 * it orbits a star for a while, slings out along one of its links, rides the
 * river to the star at the other end, is caught into that star's swirl, and so
 * on. Follow one with your eye and it wanders the graph at random.
 *
 * - Orbit: every star has a fixed disc plane (hashed from its id) and spin.
 *   Each grain tilts off that plane by its own amount and keeps its own radius,
 *   so a swirl is a thick, lumpy disc rather than a ring. Grains linger longer
 *   around cores and busy stars — that, and cores pulling more grains their way
 *   when one picks a link, is the "gravity".
 * - Leaving: once a grain's dwell runs out it picks a link, then keeps orbiting
 *   to the point on its orbit where it is already heading down that link, and
 *   leaves there on a tangent.
 * - Transit: a Hermite curve from that exit point to the matching entry point
 *   on the far star's orbit, with the orbit tangents as its own, so the hand-off
 *   at each end is smooth. On top of it, a bend the whole river shares (hashed
 *   from the edge id, drifting slowly) and a lane per grain, both zero at the
 *   ends and widest mid-way: the river's banks.
 *
 * Grains live 25-70 s and then fade out and respawn, so the spawn weights —
 * cores and long links get more — shape where dust gathers, not only the walk.
 * Grains on something deleted freeze where they are and fade.
 *
 * `shocks` (from `supernova.js`) push grains near an expanding shell outward;
 * the push dies away by itself.
 */

import { hash32, seededRandom } from './random.js'

export const MAX_GRAINS = 7000
// Grain budget: a floor, a share per star, and one per EDGE_SPACING world
// units of link length.
const BASE_GRAINS = 40
const GRAINS_PER_NODE = 26
const EDGE_SPACING = 1.1
// Orbit radius range, in radii of the star orbited; biased toward the inside.
const ORBIT_MIN = 1.7
const ORBIT_MAX = 5.2
// Speeds, world units per second. Orbits are faster close in (loosely Kepler),
// rivers a touch quicker than the edge motes' 9.
const ORBIT_SPEED = 15
const RIVER_SPEED = 11
// Hermite tangent length, as a share of the chord. About 1 keeps the speed
// through a hand-off roughly continuous.
const TANGENT_SCALE = 0.7
// How far each end tangent is bent from the orbit toward the link (0..1).
const AIM = 0.6
// River shape, as shares of a link's length, capped in world units.
const BEND_SHARE = 0.14
const BEND_MAX = 40
const LANE_SHARE = 0.035
const LANE_MAX = 6
// Heat: 1 within HEAT_FULL radii of a star, 0 beyond HEAT_NONE.
const HEAT_FULL = 1.5
const HEAT_NONE = 8
// Lifetimes and fades, seconds.
const LIFE_MIN = 25
const LIFE_RANGE = 45
const FADE_IN = 1.2
const FADE_OUT = 0.9
// Shock push: speed in world units per second at the shell, and the time
// constant it decays with.
const PUSH_DECAY = 0.8
const PUSH_MAX = 60
// Trails: each grain remembers where it was, TRAIL_POINTS samples at one per
// TRAIL_INTERVAL seconds, so it can be drawn with a curved tail following the
// path it actually took — a swirl leaves an arc, a river a long strand.
export const TRAIL_POINTS = 16
const TRAIL_INTERVAL = 0.1
// Share of grains on an undirected link that run with its current, one way,
// rather than against it. The rest keep it from looking like a conveyor.
const CURRENT = 0.8

const TAU = Math.PI * 2

// Math.hypot is several times slower than this in V8, and it runs per grain.
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z)

// Grain phases.
const DEAD = 0
const ORBIT = 1
const TRANSIT = 2

/** A unit vector and two more square to it and each other, from a hash. */
function frameFromHash(h, out) {
  const r = seededRandom(h)
  const z = 2 * r() - 1
  const a = TAU * r()
  const s = Math.sqrt(1 - z * z)
  const nx = s * Math.cos(a)
  const ny = s * Math.sin(a)
  const nz = z
  // Any vector not parallel to n, crossed with it.
  let ux, uy, uz
  if (Math.abs(nx) < 0.9) {
    ux = 0
    uy = nz
    uz = -ny
  } else {
    ux = -nz
    uy = 0
    uz = nx
  }
  const ul = len3(ux, uy, uz)
  ux /= ul
  uy /= ul
  uz /= ul
  out[0] = ux
  out[1] = uy
  out[2] = uz
  out[3] = ny * uz - nz * uy
  out[4] = nz * ux - nx * uz
  out[5] = nx * uy - ny * ux
  out[6] = nx
  out[7] = ny
  out[8] = nz
  return r
}

/**
 * `graph` is a `createGraph()` model; only `nodes`, `edges`, `revision` and
 * `sizeOf`-derived `radiusOf(id)` are read. Returns the simulation and its
 * output buffers, filled for grains `0..count-1` after every `step`.
 */
export function createRiverFlow(graph, { radiusOf, seed = 0x72697672, max = MAX_GRAINS } = {}) {
  const rand = seededRandom(seed)

  // --- Output ---
  const positions = new Float32Array(max * 3)
  const light = new Float32Array(max)
  const heat = new Float32Array(max)
  // Past positions: a ring of TRAIL_POINTS per grain, all grains sampled on the
  // same tick, `trailHead` the slot the newest sample went into. `trailValid`
  // counts the samples since the grain last (re)spawned, so no tail ever
  // spans a jump.
  const trail = new Float32Array(max * TRAIL_POINTS * 3)
  const trailValid = new Uint8Array(max)
  let trailHead = 0
  let sinceSample = 0

  // --- Per grain ---
  const phase = new Uint8Array(max)
  const at = new Int32Array(max) // node orbited, or node left in transit
  const to = new Int32Array(max) // node heading for, or -1
  const via = new Int32Array(max) // edge heading down or riding, or -1
  const came = new Int32Array(max) // node arrived from, or -1
  const atId = new Array(max).fill(null)
  const toId = new Array(max).fill(null)
  const viaId = new Array(max).fill(null)
  const cameId = new Array(max).fill(null)
  const theta = new Float64Array(max)
  const arc = new Float64Array(max) // radians left before the next decision
  const orbitR = new Float32Array(max) // in radii
  const wobble = new Float32Array(max)
  const lift = new Float32Array(max) // off the disc plane, in radii
  const basis = new Float32Array(max * 6) // U, V of the current orbit
  // Transit: the far star's orbit, ready to be caught into.
  const nextBasis = new Float32Array(max * 6)
  const nextR = new Float32Array(max)
  const nextLift = new Float32Array(max)
  const nextWobble = new Float32Array(max)
  const exitTheta = new Float64Array(max)
  const entryTheta = new Float64Array(max)
  const t = new Float64Array(max)
  // Transit ends, fixed when the grain leaves: exit offset from the star left
  // and its tangent, then the same for the entry into the far star's orbit.
  // Offsets, not points, so the river still follows stars that move.
  const ends = new Float32Array(max * 12)
  const lane = new Float32Array(max * 2)
  const pace = new Float32Array(max) // speed multiplier
  const life = new Float32Array(max)
  const fade = new Float32Array(max)
  const bright = new Float32Array(max)
  const dying = new Uint8Array(max)
  const push = new Float32Array(max * 3)

  // --- Per node / edge, rebuilt when the graph's structure changes ---
  let nodeIds = []
  let nodeObjs = []
  let nodeIndex = new Map()
  let nodeFrame = new Float32Array(0) // U, V, N per node
  let nodeSpin = new Int8Array(0)
  let nodeCore = new Uint8Array(0)
  let nodeDegree = new Int32Array(0)
  let nodeRadius = new Float32Array(0)
  let edgeIds = []
  let edgeFrom = new Int32Array(0)
  let edgeTo = new Int32Array(0)
  let edgeDirected = new Uint8Array(0)
  let edgeIndex = new Map()
  let edgeShape = new Float32Array(0) // bend waves, bend phase, bend angle, drift
  let edgeFlow = new Int8Array(0) // +1: the current runs from -> to, -1: back
  let edgeFrame = new Float32Array(0) // per step: length, e1, e2
  let incidentList = [] // per node: edge indices
  let spawnCumulative = new Float64Array(0) // nodes then edges
  let budget = 0
  let count = 0
  let builtRevision = -1
  let clock = 0

  const scratch = new Float32Array(9)

  function rebuild() {
    builtRevision = graph.revision
    nodeIds = [...graph.nodes.keys()]
    nodeObjs = nodeIds.map((id) => graph.nodes.get(id))
    nodeIndex = new Map(nodeIds.map((id, i) => [id, i]))
    const n = nodeIds.length
    nodeFrame = new Float32Array(n * 9)
    nodeSpin = new Int8Array(n)
    nodeCore = new Uint8Array(n)
    nodeDegree = new Int32Array(n)
    nodeRadius = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const h = hash32(nodeIds[i], 0x5eed0d15)
      const r = frameFromHash(h, scratch)
      nodeFrame.set(scratch, i * 9)
      nodeSpin[i] = r() < 0.5 ? -1 : 1
      nodeCore[i] = nodeObjs[i].is_core ? 1 : 0
    }

    edgeIds = [...graph.edges.keys()]
    const m = edgeIds.length
    edgeFrom = new Int32Array(m)
    edgeTo = new Int32Array(m)
    edgeDirected = new Uint8Array(m)
    edgeIndex = new Map(edgeIds.map((id, i) => [id, i]))
    edgeShape = new Float32Array(m * 4)
    edgeFlow = new Int8Array(m)
    edgeFrame = new Float32Array(m * 7)
    incidentList = nodeIds.map(() => [])
    for (let i = 0; i < m; i++) {
      const edge = graph.edges.get(edgeIds[i])
      const a = nodeIndex.get(edge.from)
      const b = nodeIndex.get(edge.to)
      edgeFrom[i] = a
      edgeTo[i] = b
      edgeDirected[i] = edge.directed ? 1 : 0
      incidentList[a].push(i)
      incidentList[b].push(i)
      nodeDegree[a]++
      nodeDegree[b]++
      const r = seededRandom(hash32(edgeIds[i], 0x0b1e55ed))
      edgeShape[i * 4] = 0.6 + 1.2 * r() // half-waves of bend along the link
      edgeShape[i * 4 + 1] = TAU * r()
      edgeShape[i * 4 + 2] = TAU * r()
      edgeShape[i * 4 + 3] = (r() - 0.5) * 0.12 // slow drift of the bend
      edgeFlow[i] = r() < 0.5 ? 1 : -1
    }

    readRadii()
    let totalLength = 0
    spawnCumulative = new Float64Array(n + m)
    let sum = 0
    for (let i = 0; i < n; i++) {
      sum += 1 + 2 * nodeCore[i] + 0.3 * Math.min(nodeDegree[i], 10)
      spawnCumulative[i] = sum
    }
    for (let i = 0; i < m; i++) {
      const len = distance(edgeFrom[i], edgeTo[i])
      totalLength += len
      sum += (len / 60) * (1 + nodeCore[edgeFrom[i]] + nodeCore[edgeTo[i]])
      spawnCumulative[n + i] = sum
    }
    budget = n === 0 ? 0 : Math.min(max, Math.round(BASE_GRAINS + GRAINS_PER_NODE * n + totalLength / EDGE_SPACING))

    // Re-point every grain at its node and edge's new index; anything whose
    // node or edge is gone freezes and fades.
    for (let g = 0; g < count; g++) {
      if (phase[g] === DEAD) continue
      const a = nodeIndex.get(atId[g])
      const b = toId[g] === null ? -1 : nodeIndex.get(toId[g]) ?? null
      const e = viaId[g] === null ? -1 : edgeIndex.get(viaId[g]) ?? null
      if (a === undefined || b === null || e === null) {
        dying[g] = 2 // frozen: no node to follow any more
        continue
      }
      at[g] = a
      to[g] = b
      via[g] = e
      came[g] = cameId[g] === null ? -1 : nodeIndex.get(cameId[g]) ?? -1
    }
    // A shrunk budget retires the grains past it; a grown one fills in.
    for (let g = budget; g < count; g++) if (phase[g] !== DEAD && !dying[g]) dying[g] = 1
    for (let g = 0; g < budget; g++) if (g >= count || phase[g] === DEAD) spawn(g)
    count = Math.max(count, budget)
  }

  function readRadii() {
    for (let i = 0; i < nodeIds.length; i++) nodeRadius[i] = radiusOf(nodeIds[i])
  }

  function distance(a, b) {
    const p = nodeObjs[a]
    const q = nodeObjs[b]
    return len3(q.x - p.x, q.y - p.y, q.z - p.z)
  }

  /** A fresh orbit basis for grain `g` around node `k`, into `out` at `o`. */
  function makeBasis(k, out, o) {
    const f = k * 9
    const phi = TAU * rand()
    const tilt = (rand() - 0.5) * 0.3
    const c = Math.cos(phi)
    const s = Math.sin(phi)
    const ct = Math.cos(tilt)
    const st = Math.sin(tilt)
    for (let a = 0; a < 3; a++) {
      const u = nodeFrame[f + a]
      const v = nodeFrame[f + 3 + a]
      const nrm = nodeFrame[f + 6 + a]
      const u1 = c * u + s * v
      const v1 = -s * u + c * v
      out[o + a] = u1
      out[o + 3 + a] = ct * v1 + st * nrm
    }
  }

  const randomRadius = () => ORBIT_MIN + (ORBIT_MAX - ORBIT_MIN) * rand() ** 1.6

  function dwell(k) {
    const core = nodeCore[k]
    return (0.3 + 1.1 * rand()) * Math.PI * (core ? 2.4 : 1) * (1 + 0.08 * Math.min(nodeDegree[k], 10))
  }

  /**
   * Angle on grain `g`'s orbit (basis at `b`, `o`) where the orbit is heading
   * most nearly along the unit direction (dx, dy, dz).
   */
  function headingAngle(b, o, spin, dx, dy, dz) {
    const du = dx * b[o] + dy * b[o + 1] + dz * b[o + 2]
    const dv = dx * b[o + 3] + dy * b[o + 4] + dz * b[o + 5]
    return Math.atan2(-spin * du, spin * dv)
  }

  function pickSpawn() {
    const total = spawnCumulative[spawnCumulative.length - 1]
    const x = rand() * total
    let lo = 0
    let hi = spawnCumulative.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (spawnCumulative[mid] > x) hi = mid
      else lo = mid + 1
    }
    return lo
  }

  function spawn(g) {
    dying[g] = 0
    push[g * 3] = push[g * 3 + 1] = push[g * 3 + 2] = 0
    if (g >= budget || nodeIds.length === 0) {
      phase[g] = DEAD
      light[g] = 0
      return
    }
    life[g] = LIFE_MIN + LIFE_RANGE * rand()
    fade[g] = 0
    // Mostly faint, a few bright: the eye picks out the bright ones to follow.
    bright[g] = 0.3 + 0.7 * rand() ** 2
    pace[g] = 0.7 + 0.6 * rand()
    const pick = pickSpawn()
    const n = nodeIds.length
    if (pick < n) {
      enterOrbit(g, pick, -1)
      makeBasis(pick, basis, g * 6)
      orbitR[g] = randomRadius()
      lift[g] = (rand() - 0.5) * 0.3
      wobble[g] = TAU * rand()
      theta[g] = TAU * rand()
    } else {
      const e = pick - n
      const reverse = edgeDirected[e] ? false : rand() < (edgeFlow[e] > 0 ? 1 - CURRENT : CURRENT)
      const a = reverse ? edgeTo[e] : edgeFrom[e]
      const b = reverse ? edgeFrom[e] : edgeTo[e]
      setNode(g, a)
      makeBasis(a, basis, g * 6)
      orbitR[g] = randomRadius()
      lift[g] = (rand() - 0.5) * 0.3
      wobble[g] = TAU * rand()
      startTransit(g, e, b)
      t[g] = rand()
    }
  }

  function setNode(g, k) {
    at[g] = k
    atId[g] = nodeIds[k]
  }

  function enterOrbit(g, k, from) {
    phase[g] = ORBIT
    setNode(g, k)
    came[g] = from
    cameId[g] = from < 0 ? null : nodeIds[from]
    to[g] = -1
    toId[g] = null
    via[g] = -1
    viaId[g] = null
    arc[g] = dwell(k)
  }

  /** Picks a link out of grain `g`'s star and sets it heading for its exit point. */
  function chooseLink(g) {
    const k = at[g]
    const links = incidentList[k]
    let total = 0
    const weights = []
    for (const e of links) {
      const other = edgeFrom[e] === k ? edgeTo[e] : edgeFrom[e]
      // A directed link carries dust one way only.
      // Undirected links still have a current: most grains go the way it runs.
      const downstream = (edgeFlow[e] > 0) === (edgeFrom[e] === k)
      const w = edgeDirected[e]
        ? edgeFrom[e] === k ? 1 + 2 * nodeCore[other] : 0
        : (1 + 2 * nodeCore[other]) * (other === came[g] ? 0.15 : 1) * (downstream ? CURRENT : 1 - CURRENT) * 2
      weights.push(w)
      total += w
    }
    if (total <= 0) {
      arc[g] = dwell(k)
      return
    }
    let x = rand() * total
    let chosen = links[links.length - 1]
    for (let i = 0; i < links.length; i++) {
      x -= weights[i]
      if (x < 0) {
        chosen = links[i]
        break
      }
    }
    const other = edgeFrom[chosen] === k ? edgeTo[chosen] : edgeFrom[chosen]
    via[g] = chosen
    viaId[g] = edgeIds[chosen]
    to[g] = other
    toId[g] = nodeIds[other]
    const p = nodeObjs[k]
    const q = nodeObjs[other]
    const len = len3(q.x - p.x, q.y - p.y, q.z - p.z) || 1
    const spin = nodeSpin[k]
    const target = headingAngle(basis, g * 6, spin, (q.x - p.x) / len, (q.y - p.y) / len, (q.z - p.z) / len)
    exitTheta[g] = target
    arc[g] = (((target - theta[g]) * spin) % TAU + TAU) % TAU
  }

  /** `keepExit`: the grain is already at the exit point `chooseLink` set. */
  function startTransit(g, e, b, keepExit = false) {
    const a = at[g]
    phase[g] = TRANSIT
    via[g] = e
    viaId[g] = edgeIds[e]
    to[g] = b
    toId[g] = nodeIds[b]
    t[g] = 0
    const p = nodeObjs[a]
    const q = nodeObjs[b]
    const len = len3(q.x - p.x, q.y - p.y, q.z - p.z) || 1
    const dx = (q.x - p.x) / len
    const dy = (q.y - p.y) / len
    const dz = (q.z - p.z) / len
    if (!keepExit) exitTheta[g] = headingAngle(basis, g * 6, nodeSpin[a], dx, dy, dz)
    makeBasis(b, nextBasis, g * 6)
    nextR[g] = randomRadius()
    nextLift[g] = (rand() - 0.5) * 0.3
    nextWobble[g] = TAU * rand()
    entryTheta[g] = headingAngle(nextBasis, g * 6, nodeSpin[b], dx, dy, dz)
    const o = g * 12
    orbitPoint(a, basis, g * 6, orbitR[g], lift[g], wobble[g], exitTheta[g])
    ends[o] = orbitOut[0] - p.x
    ends[o + 1] = orbitOut[1] - p.y
    ends[o + 2] = orbitOut[2] - p.z
    aimTangent(o + 3, dx, dy, dz)
    orbitPoint(b, nextBasis, g * 6, nextR[g], nextLift[g], nextWobble[g], entryTheta[g])
    ends[o + 6] = orbitOut[0] - q.x
    ends[o + 7] = orbitOut[1] - q.y
    ends[o + 8] = orbitOut[2] - q.z
    aimTangent(o + 9, dx, dy, dz)
    const s = Math.sqrt(-2 * Math.log(1 - rand())) // Rayleigh: most near the middle
    const w = TAU * rand()
    lane[g * 2] = 0.5 * s * Math.cos(w)
    lane[g * 2 + 1] = 0.5 * s * Math.sin(w)
  }

  /**
   * The orbit tangent in `orbitOut`, bent toward the link's direction and
   * stored at `ends[at]`. Straight off an orbit tilted across the link, the
   * curve would throw a wide loop out into empty space before turning for
   * the far star; bent, it leaves and arrives along the river.
   */
  function aimTangent(at, dx, dy, dz) {
    let x = orbitOut[3] * (1 - AIM) + dx * AIM
    let y = orbitOut[4] * (1 - AIM) + dy * AIM
    let z = orbitOut[5] * (1 - AIM) + dz * AIM
    const l = len3(x, y, z) || 1
    ends[at] = x / l
    ends[at + 1] = y / l
    ends[at + 2] = z / l
  }

  // Orbit point and unit tangent of a grain's orbit around node k at angle th.
  const orbitOut = new Float64Array(6)
  function orbitPoint(k, b, o, r, lft, wob, th) {
    const radius = nodeRadius[k]
    const rr = r * radius * (1 + 0.12 * Math.sin(3 * th + wob))
    const c = Math.cos(th)
    const s = Math.sin(th)
    const f = k * 9
    const node = nodeObjs[k]
    const h = lft * radius
    const spin = nodeSpin[k]
    for (let a = 0; a < 3; a++) {
      orbitOut[a] = rr * (c * b[o + a] + s * b[o + 3 + a]) + h * nodeFrame[f + 6 + a]
      orbitOut[3 + a] = spin * (-s * b[o + a] + c * b[o + 3 + a])
    }
    orbitOut[0] += node.x
    orbitOut[1] += node.y
    orbitOut[2] += node.z
  }

  const heatFrom = (d) => {
    const x = Math.min(1, Math.max(0, (HEAT_NONE - d) / (HEAT_NONE - HEAT_FULL)))
    return x * x
  }

  /**
   * Advances every grain by `dt` seconds and fills the output buffers. `shocks`
   * is a list of `{ x, y, z, radius, width, strength }` shells.
   */
  function step(dt, shocks = []) {
    if (graph.revision !== builtRevision) rebuild()
    readRadii()
    clock += dt
    const decay = Math.exp(-dt / PUSH_DECAY)
    writeEdgeFrames()

    for (let g = 0; g < count; g++) {
      if (phase[g] === DEAD) {
        light[g] = 0
        continue
      }
      const o = g * 3

      let respawned = false
      if (dying[g]) {
        fade[g] -= dt / FADE_OUT
        if (fade[g] <= 0) {
          spawn(g)
          respawned = true
          if (phase[g] === DEAD) continue
        }
      } else {
        fade[g] = Math.min(1, fade[g] + dt / FADE_IN)
        life[g] -= dt
        if (life[g] <= 0) dying[g] = 1
      }

      let x, y, z, near
      if (dying[g] === 2) {
        // Frozen where it was; only the push still moves it.
        x = positions[o] - push[o]
        y = positions[o + 1] - push[o + 1]
        z = positions[o + 2] - push[o + 2]
        near = heat[g]
      } else if (phase[g] === ORBIT) {
        const k = at[g]
        const r = orbitR[g]
        const radius = nodeRadius[k]
        const omega = (ORBIT_SPEED * pace[g] * Math.sqrt(ORBIT_MIN / r)) / (r * radius)
        const turn = omega * dt
        theta[g] += nodeSpin[k] * turn
        arc[g] -= turn
        if (arc[g] <= 0) {
          if (to[g] < 0) chooseLink(g)
          else {
            // At the exit point: snap exactly onto it and leave.
            theta[g] = exitTheta[g]
            startTransit(g, via[g], to[g], true)
          }
        }
        if (phase[g] === ORBIT) {
          orbitPoint(k, basis, g * 6, r, lift[g], wobble[g], theta[g])
          x = orbitOut[0]
          y = orbitOut[1]
          z = orbitOut[2]
          near = heatFrom(r)
        }
      }

      if (phase[g] === TRANSIT && dying[g] !== 2) {
        const a = at[g]
        const b = to[g]
        const pa = nodeObjs[a]
        const pb = nodeObjs[b]
        const eo = g * 12
        const p0x = pa.x + ends[eo], p0y = pa.y + ends[eo + 1], p0z = pa.z + ends[eo + 2]
        const t0x = ends[eo + 3], t0y = ends[eo + 4], t0z = ends[eo + 5]
        const p1x = pb.x + ends[eo + 6], p1y = pb.y + ends[eo + 7], p1z = pb.z + ends[eo + 8]
        const t1x = ends[eo + 9], t1y = ends[eo + 10], t1z = ends[eo + 11]
        const chord = len3(p1x - p0x, p1y - p0y, p1z - p0z) || 1

        let u = t[g]
        const speed = RIVER_SPEED * pace[g] * (0.75 + 0.5 * Math.sin(Math.PI * u))
        u += (dt * speed) / chord
        if (u >= 1) {
          // Caught into the far star's swirl, right where the curve ends.
          const from = a
          copyNextOrbit(g)
          enterOrbit(g, b, from)
          theta[g] = entryTheta[g]
          orbitPoint(b, basis, g * 6, orbitR[g], lift[g], wobble[g], theta[g])
          x = orbitOut[0]
          y = orbitOut[1]
          z = orbitOut[2]
          near = heatFrom(orbitR[g])
        } else {
          t[g] = u
          const u2 = u * u
          const u3 = u2 * u
          const h00 = 2 * u3 - 3 * u2 + 1
          const h10 = u3 - 2 * u2 + u
          const h01 = -2 * u3 + 3 * u2
          const h11 = u3 - u2
          const m = chord * TANGENT_SCALE
          x = h00 * p0x + h10 * m * t0x + h01 * p1x + h11 * m * t1x
          y = h00 * p0y + h10 * m * t0y + h01 * p1y + h11 * m * t1y
          z = h00 * p0z + h10 * m * t0z + h01 * p1z + h11 * m * t1z

          // The river's banks: a bend the whole link shares, and this grain's
          // lane in it, both zero at the ends.
          const e = via[g]
          const f7 = e * 7
          const len = edgeFrame[f7]
          const e1x = edgeFrame[f7 + 1], e1y = edgeFrame[f7 + 2], e1z = edgeFrame[f7 + 3]
          const e2x = edgeFrame[f7 + 4], e2y = edgeFrame[f7 + 5], e2z = edgeFrame[f7 + 6]

          const along = edgeFrom[e] === a ? u : 1 - u // the link's own direction
          const envelope = Math.sin(Math.PI * u)
          const s = e * 4
          const bend =
            Math.min(BEND_SHARE * len, BEND_MAX) *
            Math.sin(Math.PI * edgeShape[s] * along + edgeShape[s + 1] + clock * edgeShape[s + 3])
          const width = Math.min(LANE_SHARE * len, LANE_MAX) * (1 + 0.25 * Math.sin(5 * along + g))
          const ang = edgeShape[s + 2]
          const bx = Math.cos(ang)
          const by = Math.sin(ang)
          const la = bend * bx + width * lane[g * 2]
          const lb = bend * by + width * lane[g * 2 + 1]
          x += envelope * (la * e1x + lb * e2x)
          y += envelope * (la * e1y + lb * e2y)
          z += envelope * (la * e1z + lb * e2z)

          const dA = len3(x - pa.x, y - pa.y, z - pa.z) / nodeRadius[a]
          const dB = len3(x - pb.x, y - pb.y, z - pb.z) / nodeRadius[b]
          near = heatFrom(Math.min(dA, dB))
        }
      }

      // Shock push: an outward shove from any shell passing over the grain.
      push[o] *= decay
      push[o + 1] *= decay
      push[o + 2] *= decay
      for (const shock of shocks) {
        const rx = x + push[o] - shock.x
        const ry = y + push[o + 1] - shock.y
        const rz = z + push[o + 2] - shock.z
        const r = len3(rx, ry, rz)
        if (r < 1e-3) continue
        const off = (r - shock.radius) / shock.width
        if (off > 3 || off < -3) continue
        const shove = (shock.strength * Math.exp(-off * off) * dt) / r
        push[o] += rx * shove
        push[o + 1] += ry * shove
        push[o + 2] += rz * shove
      }
      const pl = len3(push[o], push[o + 1], push[o + 2])
      if (pl > PUSH_MAX) {
        const k = PUSH_MAX / pl
        push[o] *= k
        push[o + 1] *= k
        push[o + 2] *= k
      }

      const nx = x + push[o]
      const ny = y + push[o + 1]
      const nz = z + push[o + 2]
      if (respawned) trailValid[g] = 0
      positions[o] = nx
      positions[o + 1] = ny
      positions[o + 2] = nz
      heat[g] = near
      const f = Math.max(0, fade[g])
      light[g] = bright[g] * f * f * (3 - 2 * f)
    }

    // Trailing grains that have retired need not be drawn.
    while (count > 0 && phase[count - 1] === DEAD) count--

    sinceSample += dt
    if (sinceSample >= TRAIL_INTERVAL) {
      sinceSample %= TRAIL_INTERVAL
      trailHead = (trailHead + 1) % TRAIL_POINTS
      for (let g = 0; g < count; g++) {
        const o = (g * TRAIL_POINTS + trailHead) * 3
        trail[o] = positions[g * 3]
        trail[o + 1] = positions[g * 3 + 1]
        trail[o + 2] = positions[g * 3 + 2]
        if (trailValid[g] < TRAIL_POINTS) trailValid[g]++
      }
    }
  }

  /** Each link's length and two axes square to it, for this step's node positions. */
  function writeEdgeFrames() {
    for (let e = 0; e < edgeIds.length; e++) {
      const na = nodeObjs[edgeFrom[e]]
      const nb = nodeObjs[edgeTo[e]]
      let dx = nb.x - na.x
      let dy = nb.y - na.y
      let dz = nb.z - na.z
      const len = len3(dx, dy, dz) || 1
      dx /= len
      dy /= len
      dz /= len
      let e1x = dy, e1y = -dx, e1z = 0
      if (Math.abs(dz) > 0.9) {
        e1x = 0
        e1y = dz
        e1z = -dy
      }
      const l1 = len3(e1x, e1y, e1z) || 1
      e1x /= l1
      e1y /= l1
      e1z /= l1
      const f = e * 7
      edgeFrame[f] = len
      edgeFrame[f + 1] = e1x
      edgeFrame[f + 2] = e1y
      edgeFrame[f + 3] = e1z
      edgeFrame[f + 4] = dy * e1z - dz * e1y
      edgeFrame[f + 5] = dz * e1x - dx * e1z
      edgeFrame[f + 6] = dx * e1y - dy * e1x
    }
  }

  function copyNextOrbit(g) {
    for (let i = 0; i < 6; i++) basis[g * 6 + i] = nextBasis[g * 6 + i]
    orbitR[g] = nextR[g]
    lift[g] = nextLift[g]
    wobble[g] = nextWobble[g]
  }

  return {
    step,
    positions,
    light,
    heat,
    /**
     * Grain `g`'s past positions, newest first, into `out` (3 per point).
     * Returns how many there are — fewer than TRAIL_POINTS for a fresh grain.
     */
    trailOf(g, out) {
      const n = trailValid[g]
      for (let i = 0; i < n; i++) {
        const slot = (trailHead - i + TRAIL_POINTS) % TRAIL_POINTS
        const o = (g * TRAIL_POINTS + slot) * 3
        out[i * 3] = trail[o]
        out[i * 3 + 1] = trail[o + 1]
        out[i * 3 + 2] = trail[o + 2]
      }
      return n
    },
    trail,
    trailValid,
    get trailHead() {
      return trailHead
    },
    /** Grains to draw: 0..count-1 (dead ones among them have light 0). */
    get count() {
      return count
    },
    /** Test seam: where grain `g` is and which node/edge it is on. */
    grain(g) {
      return {
        phase: phase[g] === ORBIT ? 'orbit' : phase[g] === TRANSIT ? 'transit' : 'dead',
        node: atId[g],
        to: toId[g],
        edge: viaId[g],
        dying: dying[g],
      }
    },
  }
}
