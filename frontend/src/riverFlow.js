/**
 * Dust rivers: grains that swirl around stars and flow along the links between
 * them. Plain data, no Three.js — `dustRivers.js` draws what this describes.
 *
 * Each grain takes a real route through the map: it orbits a star for a while,
 * slings out along one of its links, rides the river to the star at the other
 * end, is caught into that star's swirl, and so on. Follow one with your eye
 * and it wanders the graph at random.
 *
 * Nothing here moves a grain frame by frame. A grain is always in one
 * *segment* — an orbit of a star, or a transit down a link — written down as a
 * handful of numbers and a start and end time, and where the grain is at any
 * moment is a formula of those numbers, the stars' current positions, and the
 * time. The GPU evaluates that formula for every grain every frame
 * (`dustRivers.js`, GRAIN_GLSL); the CPU only writes a grain's next segment
 * when its current one ends, a few grains a frame. A grain's tail is the same
 * formula at earlier times, so it needs no history, and it follows its star
 * when the star is moved because it is always worked out from where the star
 * is now. `positionAt` is the same formula in JS, for freezing grains on a
 * delete and for the tests; it and the GLSL must stay step for step the same
 * (`dustParity.spec.js` checks them against each other).
 *
 * - Orbit: every star has a fixed disc plane (hashed from its id) and spin.
 *   Each grain tilts off that plane by its own amount and keeps its own radius,
 *   so a swirl is a thick, lumpy disc rather than a ring. Grains linger longer
 *   around cores and busy stars — that, and cores pulling more grains their way
 *   when one picks a link, is the "gravity".
 * - Leaving: when a grain is caught into an orbit it picks how long to dwell
 *   and which link it will leave by, and orbits on to the point where it is
 *   already heading down that link; the orbit segment ends exactly there.
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
 * Shocks (from `supernova.js`) push grains near an expanding shell outward;
 * the push, too, is a formula of the shell's age (`shockPush`).
 */

import { hash32, seededRandom } from './random.js'
import { SHOCK_EASE, SHOCK_LIFE, SHOCK_PUSH, SHOCK_REACH } from './shockwave.js'

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
export const TANGENT_SCALE = 0.7
// How far each end tangent is bent from the orbit toward the link (0..1).
export const AIM = 0.6
// A transit runs at 1 - TRANSIT_EASE at its ends and 1 + TRANSIT_EASE
// mid-way, times its average speed: it slings out and slows to be caught.
export const TRANSIT_EASE = 0.25
// River shape, as shares of a link's length, capped in world units.
export const BEND_SHARE = 0.14
export const BEND_MAX = 40
export const LANE_SHARE = 0.035
export const LANE_MAX = 6
// Heat: 1 within HEAT_FULL radii of a star, 0 beyond HEAT_NONE.
export const HEAT_FULL = 1.5
export const HEAT_NONE = 8
// Lifetimes and fades, seconds.
const LIFE_MIN = 25
const LIFE_RANGE = 45
export const FADE_IN = 1.2
export const FADE_OUT = 0.9
// Shock push: the time constant it dies away with, and the most it moves a
// grain, world units.
export const PUSH_DECAY = 0.8
export const PUSH_MAX = 60
// Shells the dust feels at once, and how long one is kept after the supernova
// lets it go, so its push can die away rather than snap back.
export const MAX_SHOCKS = 4
const SHOCK_KEEP = SHOCK_LIFE + 6 * PUSH_DECAY
// Tails: TRAIL_POINTS points back from the grain, TRAIL_STEP seconds apart —
// a swirl leaves an arc, a river a long strand.
export const TRAIL_POINTS = 16
export const TRAIL_STEP = 0.1
// Share of grains on an undirected link that run with its current, one way,
// rather than against it. The rest keep it from looking like a conveyor.
const CURRENT = 0.8
// Times are kept relative to an epoch that moves up every EPOCH_SPAN seconds,
// so they stay small enough for a float32 to hold to well under a frame.
const EPOCH_SPAN = 600

// --- Layout of the data `dustRivers.js` uploads as float RGBA textures ---
// Every table is TEX_WIDTH texels (4 floats) wide.
export const TEX_WIDTH = 1024
// Per grain, GRAIN_TEXELS texels, so 64 grains fill a row exactly and none
// spans two: a header (spawn time, death time, brightness), then the current
// segment at SEG_NOW and the one before it at SEG_BEFORE, SEG_TEXELS each.
export const GRAIN_TEXELS = 16
export const SEG_NOW = 1
export const SEG_BEFORE = 7
const SEG_TEXELS = 6
// Per star: STAR_TEXELS in the star table (x, y, z, drawn radius), written
// every step, and FRAME_TEXELS in the frame table (U + spin, V, N), written
// when the map changes. Per edge, EDGE_TEXELS (from, to, bend waves, bend
// phase; bend angle, bend drift).
export const FRAME_TEXELS = 3
export const EDGE_TEXELS = 2
// Segment kinds, the first float of a segment.
export const NONE = 0
export const ORBIT = 1
export const TRANSIT = 2
export const FROZEN = 3
// Float offsets inside a segment. An orbit uses A (star, phi, tilt, r) and A2
// (lift, wobble, theta at t0, signed angular speed); a transit uses A and A2
// for the star it left (A2's theta: where it left) and B and B2 for the star
// it's bound for (B2's theta: where it's caught), plus its edge and lane. A
// frozen grain keeps x, y, z and heat in A.
const KIND = 0
const T0 = 1
const T1 = 2
const EDGE = 3
const A = 4
const A2 = 8
const B = 12
const B2 = 16
const LANE = 20
// Header floats.
const SPAWN = 0
const DEATH = 1
const BRIGHT = 2
const NEVER = 1e9

const TAU = Math.PI * 2

// Math.hypot is several times slower than this in V8, and it runs per grain.
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z)

const rowsFor = (texels) => Math.max(1, Math.ceil(texels / TEX_WIDTH))
/** A table of `texels` texels, padded to whole TEX_WIDTH rows. */
const table = (texels) => new Float32Array(rowsFor(texels) * TEX_WIDTH * 4)

const clamp01 = (x) => Math.min(1, Math.max(0, x))
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

// Grain phases, as the route sees it.
const DEAD = 0
const ORBITING = 1
const RIDING = 2

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
 * `sizeOf`-derived `radiusOf(id)` are read.
 */
export function createRiverFlow(graph, { radiusOf, seed = 0x72697672, max = MAX_GRAINS } = {}) {
  const rand = seededRandom(seed)

  // --- What the GPU reads ---
  const records = table(max * GRAIN_TEXELS)
  let stars = table(0)
  let frames = table(0)
  let edges = table(0)
  // Bumped when the frame or edge tables change (or are reallocated).
  let tablesVersion = 0
  // Grains whose record changed in the last step; all of them if `allDirty`.
  const dirty = new Int32Array(max)
  const isDirty = new Uint8Array(max)
  let dirtyCount = 0
  let allDirty = true
  // Live shells: x, y, z, star radius; then birth time (epoch-relative).
  const shockData = new Float32Array(MAX_SHOCKS * 8)
  let shocks = []

  // --- Sampled on demand (`sample`), for tests and debugging ---
  const positions = new Float32Array(max * 3)
  const light = new Float32Array(max)
  const heat = new Float32Array(max)

  // --- Per grain, the route: where it is, and where it has chosen to go ---
  const phase = new Uint8Array(max)
  const frozen = new Uint8Array(max)
  const at = new Int32Array(max) // node orbited, or node left in transit
  const to = new Int32Array(max) // node heading for, or -1
  const via = new Int32Array(max) // edge heading down or riding, or -1
  const came = new Int32Array(max) // node arrived from, or -1
  const atId = new Array(max).fill(null)
  const toId = new Array(max).fill(null)
  const viaId = new Array(max).fill(null)
  const cameId = new Array(max).fill(null)
  const pace = new Float32Array(max) // speed multiplier

  // --- Per node / edge, rebuilt when the graph's structure changes ---
  let nodeIds = []
  let nodeObjs = []
  let nodeIndex = new Map()
  let nodeSpin = new Int8Array(0)
  let nodeCore = new Uint8Array(0)
  let nodeDegree = new Int32Array(0)
  let edgeIds = []
  let edgeFrom = new Int32Array(0)
  let edgeTo = new Int32Array(0)
  let edgeDirected = new Uint8Array(0)
  let edgeIndex = new Map()
  let edgeShape = new Float32Array(0) // bend waves, bend phase, bend angle, drift
  let edgeFlow = new Int8Array(0) // +1: the current runs from -> to, -1: back
  let incidentList = [] // per node: edge indices
  let spawnCumulative = new Float64Array(0) // nodes then edges
  let budget = 0
  let count = 0
  let builtRevision = -1
  // Seconds since creation, and the epoch record times are relative to.
  let clock = 0
  let epoch = 0

  const scratch = new Float32Array(9)
  const basisOut = new Float64Array(6)
  const orbitOut = new Float64Array(6)
  const orbitOut2 = new Float64Array(6)
  const pointOut = new Float64Array(4)
  const pushOut = new Float64Array(3)

  const now = () => clock - epoch
  const headOf = (g) => g * GRAIN_TEXELS * 4
  const segOf = (g, seg) => (g * GRAIN_TEXELS + seg) * 4

  function markDirty(g) {
    if (isDirty[g]) return
    isDirty[g] = 1
    dirty[dirtyCount++] = g
  }

  function rebuild() {
    builtRevision = graph.revision
    const t = now()
    const newIds = [...graph.nodes.keys()]
    const newIndex = new Map(newIds.map((id, i) => [id, i]))
    const newEdgeIds = [...graph.edges.keys()]
    const newEdgeIndex = new Map(newEdgeIds.map((id, i) => [id, i]))

    // With the old tables still in place: freeze every grain whose route runs
    // over something gone, where it is right now, and cut every tail that
    // reaches back onto something gone.
    const starGone = new Uint8Array(nodeIds.length)
    for (let i = 0; i < nodeIds.length; i++) starGone[i] = newIndex.has(nodeIds[i]) ? 0 : 1
    const edgeGone = new Uint8Array(edgeIds.length)
    for (let i = 0; i < edgeIds.length; i++) edgeGone[i] = newEdgeIndex.has(edgeIds[i]) ? 0 : 1
    for (let g = 0; g < count; g++) {
      if (phase[g] === DEAD) continue
      const s = segOf(g, SEG_NOW)
      if (records[s + KIND] !== FROZEN) {
        const lost =
          !newIndex.has(atId[g]) ||
          (toId[g] !== null && !newIndex.has(toId[g])) ||
          (viaId[g] !== null && !newEdgeIndex.has(viaId[g]))
        if (lost) freeze(g, t)
      }
      const p = segOf(g, SEG_BEFORE)
      if (records[p + KIND] !== NONE && records[p + KIND] !== FROZEN && segmentLost(p, starGone, edgeGone)) {
        records[p + KIND] = NONE
        markDirty(g)
      }
    }
    // Old index -> new, for re-pointing the records.
    const starMap = Int32Array.from(nodeIds, (id) => newIndex.get(id) ?? -1)
    const edgeMap = Int32Array.from(edgeIds, (id) => newEdgeIndex.get(id) ?? -1)

    nodeIds = newIds
    nodeObjs = nodeIds.map((id) => graph.nodes.get(id))
    nodeIndex = newIndex
    const n = nodeIds.length
    nodeSpin = new Int8Array(n)
    nodeCore = new Uint8Array(n)
    nodeDegree = new Int32Array(n)
    if (stars.length < n * 4) stars = table(n)
    if (frames.length < n * FRAME_TEXELS * 4) frames = table(n * FRAME_TEXELS)
    for (let i = 0; i < n; i++) {
      const h = hash32(nodeIds[i], 0x5eed0d15)
      const r = frameFromHash(h, scratch)
      nodeSpin[i] = r() < 0.5 ? -1 : 1
      nodeCore[i] = nodeObjs[i].is_core ? 1 : 0
      const f = i * FRAME_TEXELS * 4
      frames[f] = scratch[0]
      frames[f + 1] = scratch[1]
      frames[f + 2] = scratch[2]
      frames[f + 3] = nodeSpin[i]
      frames[f + 4] = scratch[3]
      frames[f + 5] = scratch[4]
      frames[f + 6] = scratch[5]
      frames[f + 7] = nodeCore[i]
      frames[f + 8] = scratch[6]
      frames[f + 9] = scratch[7]
      frames[f + 10] = scratch[8]
      frames[f + 11] = 0
    }

    edgeIds = newEdgeIds
    const m = edgeIds.length
    edgeFrom = new Int32Array(m)
    edgeTo = new Int32Array(m)
    edgeDirected = new Uint8Array(m)
    edgeIndex = newEdgeIndex
    edgeShape = new Float32Array(m * 4)
    edgeFlow = new Int8Array(m)
    if (edges.length < m * EDGE_TEXELS * 4) edges = table(m * EDGE_TEXELS)
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
    writeEdges()
    writeStars()
    tablesVersion++

    // Re-point every record at its stars' and edges' new indices.
    for (let g = 0; g < count; g++) {
      for (const seg of [SEG_NOW, SEG_BEFORE]) {
        const s = segOf(g, seg)
        const kind = records[s + KIND]
        if (kind === ORBIT || kind === TRANSIT) records[s + A] = starMap[records[s + A]]
        if (kind === TRANSIT) {
          records[s + B] = starMap[records[s + B]]
          records[s + EDGE] = edgeMap[records[s + EDGE]]
        }
      }
      if (phase[g] === DEAD || frozen[g]) continue
      at[g] = nodeIndex.get(atId[g])
      to[g] = toId[g] === null ? -1 : nodeIndex.get(toId[g])
      via[g] = viaId[g] === null ? -1 : edgeIndex.get(viaId[g])
      came[g] = cameId[g] === null ? -1 : (nodeIndex.get(cameId[g]) ?? -1)
    }

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
    budget =
      n === 0 ? 0 : Math.min(max, Math.round(BASE_GRAINS + GRAINS_PER_NODE * n + totalLength / EDGE_SPACING))

    // A shrunk budget retires the grains past it; a grown one fills in.
    for (let g = budget; g < count; g++) {
      if (phase[g] === DEAD) continue
      const h = headOf(g)
      if (records[h + DEATH] > t) {
        records[h + DEATH] = t
        markDirty(g)
      }
    }
    for (let g = 0; g < budget; g++) if (g >= count || phase[g] === DEAD) spawn(g, t)
    count = Math.max(count, budget)
    allDirty = true
  }

  /** Whether segment `s`, still in the old indices, runs over anything gone. */
  function segmentLost(s, starGone, edgeGone) {
    if (starGone[records[s + A]]) return true
    if (records[s + KIND] !== TRANSIT) return false
    return starGone[records[s + B]] === 1 || edgeGone[records[s + EDGE]] === 1
  }

  /** Grain `g` stops where it is at time `t` and fades; its tail goes. */
  function freeze(g, t) {
    positionAt(g, t, pointOut)
    const s = segOf(g, SEG_NOW)
    records[s + KIND] = FROZEN
    records[s + T0] = t
    records[s + T1] = NEVER
    records[s + A] = pointOut[0]
    records[s + A + 1] = pointOut[1]
    records[s + A + 2] = pointOut[2]
    records[s + A + 3] = pointOut[3]
    records[segOf(g, SEG_BEFORE) + KIND] = NONE
    const h = headOf(g)
    records[h + DEATH] = Math.min(records[h + DEATH], t)
    frozen[g] = 1
    markDirty(g)
  }

  function writeStars() {
    for (let i = 0; i < nodeObjs.length; i++) {
      const node = nodeObjs[i]
      const o = i * 4
      stars[o] = node.x
      stars[o + 1] = node.y
      stars[o + 2] = node.z
      stars[o + 3] = radiusOf(nodeIds[i])
    }
  }

  function writeEdges() {
    for (let i = 0; i < edgeIds.length; i++) {
      const o = i * EDGE_TEXELS * 4
      edges[o] = edgeFrom[i]
      edges[o + 1] = edgeTo[i]
      edges[o + 2] = edgeShape[i * 4]
      // The drift is applied to epoch-relative time; this keeps the bend where
      // it was when the epoch moves.
      edges[o + 3] = (edgeShape[i * 4 + 1] + epoch * edgeShape[i * 4 + 3]) % TAU
      edges[o + 4] = edgeShape[i * 4 + 2]
      edges[o + 5] = edgeShape[i * 4 + 3]
      edges[o + 6] = 0
      edges[o + 7] = 0
    }
  }

  function distance(a, b) {
    const p = nodeObjs[a]
    const q = nodeObjs[b]
    return len3(q.x - p.x, q.y - p.y, q.z - p.z)
  }

  /** Orbit basis U, V (into `basisOut`) of star `k` turned by `phi` and tilted by `tilt`. */
  function basisOf(k, phi, tilt) {
    const f = k * FRAME_TEXELS * 4
    const c = Math.cos(phi)
    const s = Math.sin(phi)
    const ct = Math.cos(tilt)
    const st = Math.sin(tilt)
    for (let a = 0; a < 3; a++) {
      const u = frames[f + a]
      const v = frames[f + 4 + a]
      const n = frames[f + 8 + a]
      basisOut[a] = c * u + s * v
      basisOut[3 + a] = ct * (-s * u + c * v) + st * n
    }
  }

  const randomRadius = () => ORBIT_MIN + (ORBIT_MAX - ORBIT_MIN) * rand() ** 1.6

  function dwell(k) {
    const core = nodeCore[k]
    return (0.3 + 1.1 * rand()) * Math.PI * (core ? 2.4 : 1) * (1 + 0.08 * Math.min(nodeDegree[k], 10))
  }

  /**
   * Angle on an orbit of star `k` (basis from `phi`, `tilt`) where the orbit is
   * heading most nearly along the unit direction (dx, dy, dz).
   */
  function headingAngle(k, phi, tilt, dx, dy, dz) {
    basisOf(k, phi, tilt)
    const spin = nodeSpin[k]
    const du = dx * basisOut[0] + dy * basisOut[1] + dz * basisOut[2]
    const dv = dx * basisOut[3] + dy * basisOut[4] + dz * basisOut[5]
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

  function spawn(g, t) {
    markDirty(g)
    frozen[g] = 0
    const h = headOf(g)
    records[segOf(g, SEG_BEFORE) + KIND] = NONE
    if (g >= budget || nodeIds.length === 0) {
      phase[g] = DEAD
      records[segOf(g, SEG_NOW) + KIND] = NONE
      records[h + SPAWN] = 0
      records[h + DEATH] = -NEVER
      records[h + BRIGHT] = 0
      return
    }
    records[h + SPAWN] = t
    records[h + DEATH] = t + LIFE_MIN + LIFE_RANGE * rand()
    // Mostly faint, a few bright: the eye picks out the bright ones to follow.
    records[h + BRIGHT] = 0.3 + 0.7 * rand() ** 2
    pace[g] = 0.7 + 0.6 * rand()
    const pick = pickSpawn()
    const n = nodeIds.length
    const phi = TAU * rand()
    const tilt = (rand() - 0.5) * 0.3
    const r = randomRadius()
    const lift = (rand() - 0.5) * 0.3
    const wob = TAU * rand()
    if (pick < n) {
      startOrbit(g, pick, -1, t, phi, tilt, r, lift, wob, TAU * rand())
    } else {
      const e = pick - n
      const reverse = edgeDirected[e] ? false : rand() < (edgeFlow[e] > 0 ? 1 - CURRENT : CURRENT)
      const a = reverse ? edgeTo[e] : edgeFrom[e]
      const b = reverse ? edgeFrom[e] : edgeTo[e]
      setNode(g, a)
      came[g] = -1
      cameId[g] = null
      startTransit(g, e, b, t, a, phi, tilt, r, lift, wob, NaN)
      // Already partway down the river.
      const s = segOf(g, SEG_NOW)
      const shift = rand() * (records[s + T1] - records[s + T0])
      records[s + T0] -= shift
      records[s + T1] -= shift
    }
  }

  function setNode(g, k) {
    at[g] = k
    atId[g] = nodeIds[k]
  }

  /**
   * Grain `g` is caught into an orbit of star `k` at time `t0` and angle
   * `theta`, having come from star `from` (or -1). It picks how long to dwell
   * and the link it will leave by, and the orbit runs until it's heading
   * down that link.
   */
  function startOrbit(g, k, from, t0, phi, tilt, r, lift, wob, theta) {
    phase[g] = ORBITING
    setNode(g, k)
    came[g] = from
    cameId[g] = from < 0 ? null : nodeIds[from]
    const spin = nodeSpin[k]
    const speed = (ORBIT_SPEED * pace[g] * Math.sqrt(ORBIT_MIN / r)) / (r * stars[k * 4 + 3])
    let arc = dwell(k)
    const e = chooseLink(g)
    if (e >= 0) {
      const other = to[g]
      const p = nodeObjs[k]
      const q = nodeObjs[other]
      const len = len3(q.x - p.x, q.y - p.y, q.z - p.z) || 1
      const target = headingAngle(k, phi, tilt, (q.x - p.x) / len, (q.y - p.y) / len, (q.z - p.z) / len)
      const end = theta + spin * arc
      arc += ((((target - end) * spin) % TAU) + TAU) % TAU
    }
    const s = segOf(g, SEG_NOW)
    records[s + KIND] = ORBIT
    records[s + T0] = t0
    records[s + T1] = t0 + arc / speed
    records[s + EDGE] = -1
    records[s + A] = k
    records[s + A + 1] = phi
    records[s + A + 2] = tilt
    records[s + A + 3] = r
    records[s + A2] = lift
    records[s + A2 + 1] = wob
    records[s + A2 + 2] = theta
    records[s + A2 + 3] = spin * speed
    markDirty(g)
  }

  /** Picks a link out of grain `g`'s star; sets `to`/`via` and returns it, or -1. */
  function chooseLink(g) {
    const k = at[g]
    to[g] = -1
    toId[g] = null
    via[g] = -1
    viaId[g] = null
    const links = incidentList[k]
    let total = 0
    for (const e of links) total += linkWeight(g, k, e)
    if (total <= 0) return -1
    let x = rand() * total
    let chosen = links[links.length - 1]
    for (const e of links) {
      x -= linkWeight(g, k, e)
      if (x < 0) {
        chosen = e
        break
      }
    }
    const other = edgeFrom[chosen] === k ? edgeTo[chosen] : edgeFrom[chosen]
    via[g] = chosen
    viaId[g] = edgeIds[chosen]
    to[g] = other
    toId[g] = nodeIds[other]
    return chosen
  }

  function linkWeight(g, k, e) {
    const other = edgeFrom[e] === k ? edgeTo[e] : edgeFrom[e]
    // A directed link carries dust one way only.
    if (edgeDirected[e]) return edgeFrom[e] === k ? 1 + 2 * nodeCore[other] : 0
    // Undirected links still have a current: most grains go the way it runs.
    const downstream = edgeFlow[e] > 0 === (edgeFrom[e] === k)
    return (
      (1 + 2 * nodeCore[other]) * (other === came[g] ? 0.15 : 1) * (downstream ? CURRENT : 1 - CURRENT) * 2
    )
  }

  /**
   * Grain `g` leaves star `a` (orbit `phi`..`wob`) down edge `e` for star `b`
   * at time `t0`, from angle `exitTheta` — or, if NaN, from wherever on that
   * orbit is heading down the link.
   */
  function startTransit(g, e, b, t0, a, phi, tilt, r, lift, wob, exitTheta) {
    phase[g] = RIDING
    via[g] = e
    viaId[g] = edgeIds[e]
    to[g] = b
    toId[g] = nodeIds[b]
    const p = nodeObjs[a]
    const q = nodeObjs[b]
    const len = len3(q.x - p.x, q.y - p.y, q.z - p.z) || 1
    const dx = (q.x - p.x) / len
    const dy = (q.y - p.y) / len
    const dz = (q.z - p.z) / len
    if (Number.isNaN(exitTheta)) exitTheta = headingAngle(a, phi, tilt, dx, dy, dz)
    const phiB = TAU * rand()
    const tiltB = (rand() - 0.5) * 0.3
    const rB = randomRadius()
    const liftB = (rand() - 0.5) * 0.3
    const wobB = TAU * rand()
    const entryTheta = headingAngle(b, phiB, tiltB, dx, dy, dz)
    orbitPoint(a, phi, tilt, r, lift, wob, exitTheta, orbitOut)
    orbitPoint(b, phiB, tiltB, rB, liftB, wobB, entryTheta, orbitOut2)
    const chord = len3(orbitOut2[0] - orbitOut[0], orbitOut2[1] - orbitOut[1], orbitOut2[2] - orbitOut[2])
    const duration = Math.max(0.1, chord / (RIVER_SPEED * pace[g]))
    const s = Math.sqrt(-2 * Math.log(1 - rand())) // Rayleigh: most near the middle
    const w = TAU * rand()
    const o = segOf(g, SEG_NOW)
    records[o + KIND] = TRANSIT
    records[o + T0] = t0
    records[o + T1] = t0 + duration
    records[o + EDGE] = e
    records[o + A] = a
    records[o + A + 1] = phi
    records[o + A + 2] = tilt
    records[o + A + 3] = r
    records[o + A2] = lift
    records[o + A2 + 1] = wob
    records[o + A2 + 2] = exitTheta
    records[o + A2 + 3] = 0
    records[o + B] = b
    records[o + B + 1] = phiB
    records[o + B + 2] = tiltB
    records[o + B + 3] = rB
    records[o + B2] = liftB
    records[o + B2 + 1] = wobB
    records[o + B2 + 2] = entryTheta
    records[o + B2 + 3] = 0
    records[o + LANE] = 0.5 * s * Math.cos(w)
    records[o + LANE + 1] = 0.5 * s * Math.sin(w)
    records[o + LANE + 2] = 0
    records[o + LANE + 3] = 0
    markDirty(g)
  }

  /** Grain `g`'s current segment has ended: on to the next. */
  function advance(g) {
    const s = segOf(g, SEG_NOW)
    records.copyWithin(segOf(g, SEG_BEFORE), s, s + SEG_TEXELS * 4)
    const t1 = records[s + T1]
    if (records[s + KIND] === ORBIT) {
      const k = records[s + A]
      const phi = records[s + A + 1]
      const tilt = records[s + A + 2]
      const r = records[s + A + 3]
      const lift = records[s + A2]
      const wob = records[s + A2 + 1]
      // Where the orbit has got to, from the numbers the GPU has.
      const theta = records[s + A2 + 2] + records[s + A2 + 3] * (t1 - records[s + T0])
      if (to[g] < 0) startOrbit(g, k, came[g], t1, phi, tilt, r, lift, wob, theta)
      else startTransit(g, via[g], to[g], t1, k, phi, tilt, r, lift, wob, theta)
    } else {
      // Caught into the far star's swirl, right where the curve ends.
      startOrbit(
        g,
        records[s + B],
        at[g],
        t1,
        records[s + B + 1],
        records[s + B + 2],
        records[s + B + 3],
        records[s + B2],
        records[s + B2 + 1],
        records[s + B2 + 2],
      )
    }
  }

  // --- The formula: the JS twin of GRAIN_GLSL in dustRivers.js ---

  /** Point and unit tangent (into `out`) of an orbit of star `k` at angle `th`. */
  function orbitPoint(k, phi, tilt, r, lift, wob, th, out) {
    basisOf(k, phi, tilt)
    const f = k * FRAME_TEXELS * 4
    const o = k * 4
    const radius = stars[o + 3]
    const spin = frames[f + 3]
    const rr = r * radius * (1 + 0.12 * Math.sin(3 * th + wob))
    const c = Math.cos(th)
    const s = Math.sin(th)
    const h = lift * radius
    for (let a = 0; a < 3; a++) {
      out[a] = stars[o + a] + rr * (c * basisOut[a] + s * basisOut[3 + a]) + h * frames[f + 8 + a]
      out[3 + a] = spin * (-s * basisOut[a] + c * basisOut[3 + a])
    }
  }

  const heatFrom = (d) => {
    const x = clamp01((HEAT_NONE - d) / (HEAT_NONE - HEAT_FULL))
    return x * x
  }

  /** Bends tangent (tx, ty, tz) toward direction d by AIM, into out[3..5]. */
  function aim(out, dx, dy, dz) {
    const x = out[3] * (1 - AIM) + dx * AIM
    const y = out[4] * (1 - AIM) + dy * AIM
    const z = out[5] * (1 - AIM) + dz * AIM
    const l = len3(x, y, z) || 1
    out[3] = x / l
    out[4] = y / l
    out[5] = z / l
  }

  /** Where segment `s` of grain `g` is at time `t`: x, y, z, heat into `out`. */
  function segmentAt(g, s, t, out) {
    const kind = records[s + KIND]
    if (kind === FROZEN) {
      out[0] = records[s + A]
      out[1] = records[s + A + 1]
      out[2] = records[s + A + 2]
      out[3] = records[s + A + 3]
      return
    }
    if (kind === NONE) {
      out[0] = out[1] = out[2] = out[3] = 0
      return
    }
    const k = records[s + A]
    if (kind === ORBIT) {
      const th = records[s + A2 + 2] + records[s + A2 + 3] * (t - records[s + T0])
      orbitPoint(
        k,
        records[s + A + 1],
        records[s + A + 2],
        records[s + A + 3],
        records[s + A2],
        records[s + A2 + 1],
        th,
        orbitOut,
      )
      out[0] = orbitOut[0]
      out[1] = orbitOut[1]
      out[2] = orbitOut[2]
      out[3] = heatFrom(records[s + A + 3])
      return
    }
    const b = records[s + B]
    const pa = k * 4
    const pb = b * 4
    orbitPoint(
      k,
      records[s + A + 1],
      records[s + A + 2],
      records[s + A + 3],
      records[s + A2],
      records[s + A2 + 1],
      records[s + A2 + 2],
      orbitOut,
    )
    orbitPoint(
      b,
      records[s + B + 1],
      records[s + B + 2],
      records[s + B + 3],
      records[s + B2],
      records[s + B2 + 1],
      records[s + B2 + 2],
      orbitOut2,
    )
    let dx = stars[pb] - stars[pa]
    let dy = stars[pb + 1] - stars[pa + 1]
    let dz = stars[pb + 2] - stars[pa + 2]
    const dl = len3(dx, dy, dz) || 1
    dx /= dl
    dy /= dl
    dz /= dl
    aim(orbitOut, dx, dy, dz)
    aim(orbitOut2, dx, dy, dz)
    const chord =
      len3(orbitOut2[0] - orbitOut[0], orbitOut2[1] - orbitOut[1], orbitOut2[2] - orbitOut[2]) || 1
    const tau = clamp01((t - records[s + T0]) / Math.max(records[s + T1] - records[s + T0], 1e-4))
    const u = tau - (TRANSIT_EASE * Math.sin(TAU * tau)) / TAU
    const u2 = u * u
    const u3 = u2 * u
    const h00 = 2 * u3 - 3 * u2 + 1
    const h10 = u3 - 2 * u2 + u
    const h01 = -2 * u3 + 3 * u2
    const h11 = u3 - u2
    const m = chord * TANGENT_SCALE
    let x = h00 * orbitOut[0] + h10 * m * orbitOut[3] + h01 * orbitOut2[0] + h11 * m * orbitOut2[3]
    let y = h00 * orbitOut[1] + h10 * m * orbitOut[4] + h01 * orbitOut2[1] + h11 * m * orbitOut2[4]
    let z = h00 * orbitOut[2] + h10 * m * orbitOut[5] + h01 * orbitOut2[2] + h11 * m * orbitOut2[5]

    // The river's banks: a bend the whole link shares, and this grain's lane
    // in it, both zero at the ends. The link's own axes, from its own `from`.
    const e = records[s + EDGE] * EDGE_TEXELS * 4
    const forward = edges[e] === k
    let ex = forward ? dx : -dx
    let ey = forward ? dy : -dy
    let ez = forward ? dz : -dz
    let f1x = ey
    let f1y = -ex
    let f1z = 0
    if (Math.abs(ez) > 0.9) {
      f1x = 0
      f1y = ez
      f1z = -ey
    }
    const l1 = len3(f1x, f1y, f1z) || 1
    f1x /= l1
    f1y /= l1
    f1z /= l1
    const f2x = ey * f1z - ez * f1y
    const f2y = ez * f1x - ex * f1z
    const f2z = ex * f1y - ey * f1x
    const along = forward ? u : 1 - u
    const envelope = Math.sin(Math.PI * u)
    const bend =
      Math.min(BEND_SHARE * dl, BEND_MAX) *
      Math.sin(Math.PI * edges[e + 2] * along + edges[e + 3] + t * edges[e + 5])
    const width = Math.min(LANE_SHARE * dl, LANE_MAX) * (1 + 0.25 * Math.sin(5 * along + g))
    const ang = edges[e + 4]
    const la = bend * Math.cos(ang) + width * records[s + LANE]
    const lb = bend * Math.sin(ang) + width * records[s + LANE + 1]
    x += envelope * (la * f1x + lb * f2x)
    y += envelope * (la * f1y + lb * f2y)
    z += envelope * (la * f1z + lb * f2z)
    out[0] = x
    out[1] = y
    out[2] = z
    const dA = len3(x - stars[pa], y - stars[pa + 1], z - stars[pa + 2]) / stars[pa + 3]
    const dB = len3(x - stars[pb], y - stars[pb + 1], z - stars[pb + 2]) / stars[pb + 3]
    out[3] = heatFrom(Math.min(dA, dB))
  }

  /** The earliest time grain `g`'s tail can reach back to. */
  function earliest(g) {
    const s = segOf(g, SEG_NOW)
    const p = segOf(g, SEG_BEFORE)
    const from = records[p + KIND] !== NONE ? records[p + T0] : records[s + T0]
    return Math.max(from, records[headOf(g) + SPAWN])
  }

  /** Where grain `g` is at (epoch-relative) time `t`: x, y, z, heat into `out`. */
  function positionAt(g, t, out) {
    const s = segOf(g, SEG_NOW)
    const p = segOf(g, SEG_BEFORE)
    t = Math.max(t, earliest(g))
    segmentAt(g, t >= records[s + T0] || records[p + KIND] === NONE ? s : p, t, out)
    shockPush(out[0], out[1], out[2], t, pushOut)
    out[0] += pushOut[0]
    out[1] += pushOut[1]
    out[2] += pushOut[2]
  }

  /**
   * How far the live shells have pushed a grain at (x, y, z) by time `t`: the
   * shell reaches it at `reached`, shoves it out by what the shell's push
   * integrates to over its width, and the shove dies away.
   */
  function shockPush(x, y, z, t, out) {
    out[0] = out[1] = out[2] = 0
    for (let i = 0; i < MAX_SHOCKS; i++) {
      const o = i * 8
      const r0 = shockData[o + 3]
      if (r0 <= 0) continue
      const age = t - shockData[o + 4]
      if (age <= 0) continue
      const rx = x - shockData[o]
      const ry = y - shockData[o + 1]
      const rz = z - shockData[o + 2]
      const d = len3(rx, ry, rz)
      if (d < 1e-3) continue
      const reach = r0 * SHOCK_REACH
      if (d >= reach) continue
      const reached = -SHOCK_EASE * Math.log(1 - d / reach)
      if (reached >= SHOCK_LIFE) continue
      const life = reached / SHOCK_LIFE
      const strength = SHOCK_PUSH * (r0 / 5) * (1 - life) * (1 - life)
      const width = Math.max(0.35 * d, 2)
      const rate = (reach - d) / SHOCK_EASE
      const amount = Math.min(PUSH_MAX, (strength * width * 1.7724539) / Math.max(rate, 1e-3))
      const radius = reach * (1 - Math.exp(-age / SHOCK_EASE))
      const rise = 1 - smoothstep(-1.5, 1.5, (d - radius) / width)
      const decay = Math.exp(-Math.max(0, age - reached) / PUSH_DECAY)
      const k = (amount * rise * decay) / d
      out[0] += rx * k
      out[1] += ry * k
      out[2] += rz * k
    }
    const l = len3(out[0], out[1], out[2])
    if (l > PUSH_MAX) {
      out[0] *= PUSH_MAX / l
      out[1] *= PUSH_MAX / l
      out[2] *= PUSH_MAX / l
    }
  }

  /** Grain `g`'s brightness at time `t`: faded in after spawn, out after death. */
  function lightAt(g, t) {
    if (records[segOf(g, SEG_NOW) + KIND] === NONE) return 0
    const h = headOf(g)
    const f = clamp01(Math.min((t - records[h + SPAWN]) / FADE_IN, 1 - (t - records[h + DEATH]) / FADE_OUT))
    return records[h + BRIGHT] * f * f * (3 - 2 * f)
  }

  /** Takes in `list` from `supernova.shocks()`; keeps each until its push is gone. */
  function noteShocks(list) {
    for (const shock of list) {
      if (shocks.some((s) => s.id === shock.id)) continue
      shocks.push({
        id: shock.id,
        x: shock.x,
        y: shock.y,
        z: shock.z,
        r0: shock.starRadius,
        birth: clock - shock.age,
      })
    }
    shocks = shocks.filter((s) => clock - s.birth < SHOCK_KEEP).slice(-MAX_SHOCKS)
    shockData.fill(0)
    shocks.forEach((s, i) => {
      shockData.set([s.x, s.y, s.z, s.r0, s.birth - epoch], i * 8)
    })
  }

  /** Moves the epoch up to now, keeping every record time where it was. */
  function rebase() {
    const shift = clock - epoch
    epoch = clock
    for (let g = 0; g < count; g++) {
      const h = headOf(g)
      if (Math.abs(records[h + SPAWN]) < NEVER / 2) records[h + SPAWN] -= shift
      if (Math.abs(records[h + DEATH]) < NEVER / 2) records[h + DEATH] -= shift
      for (const seg of [SEG_NOW, SEG_BEFORE]) {
        const s = segOf(g, seg)
        records[s + T0] -= shift
        if (records[s + T1] < NEVER / 2) records[s + T1] -= shift
      }
    }
    writeEdges()
    tablesVersion++
    allDirty = true
  }

  /**
   * Advances the rivers by `dt` seconds: new segments for the grains whose
   * last one ended, and the stars' positions and radii for the GPU. `shocks`
   * is `supernova.shocks()`.
   */
  function step(dt, shockList = []) {
    for (let i = 0; i < dirtyCount; i++) isDirty[dirty[i]] = 0
    dirtyCount = 0
    allDirty = false
    clock += dt
    if (clock - epoch > EPOCH_SPAN) rebase()
    if (graph.revision !== builtRevision) rebuild()
    writeStars()
    noteShocks(shockList)
    const t = now()
    for (let g = 0; g < count; g++) {
      if (phase[g] === DEAD) continue
      const h = headOf(g)
      const s = segOf(g, SEG_NOW)
      // A long frame can end several segments at once.
      for (let guard = 0; guard < 16; guard++) {
        if (t >= records[h + DEATH] + FADE_OUT) {
          spawn(g, t)
          break
        }
        if (records[s + KIND] === FROZEN || t < records[s + T1]) break
        advance(g)
      }
    }
    // Trailing grains that have retired need not be drawn.
    while (count > 0 && phase[count - 1] === DEAD) count--
  }

  /** Fills `positions`, `light` and `heat` for now. Not needed to draw. */
  function sample() {
    const t = now()
    for (let g = 0; g < count; g++) {
      if (phase[g] === DEAD) {
        light[g] = 0
        continue
      }
      positionAt(g, t, pointOut)
      positions[g * 3] = pointOut[0]
      positions[g * 3 + 1] = pointOut[1]
      positions[g * 3 + 2] = pointOut[2]
      heat[g] = pointOut[3]
      light[g] = lightAt(g, t)
    }
  }

  return {
    step,
    sample,
    positions,
    light,
    heat,
    records,
    shockData,
    /** Grain `g`'s position (x, y, z, heat) at `secondsAgo` before now. */
    positionAt(g, secondsAgo, out) {
      positionAt(g, now() - secondsAgo, out)
      return out
    },
    /**
     * Grain `g`'s tail points, newest first, into `out` (3 per point): where
     * it was TRAIL_STEP, 2·TRAIL_STEP, … seconds ago, as far back as it goes.
     * Returns how many — fewer than TRAIL_POINTS for a fresh grain.
     */
    trailOf(g, out) {
      const t = now()
      const from = earliest(g)
      let n = 0
      for (let i = 1; i <= TRAIL_POINTS; i++) {
        const ti = t - i * TRAIL_STEP
        if (ti < from) break
        positionAt(g, ti, pointOut)
        out[n * 3] = pointOut[0]
        out[n * 3 + 1] = pointOut[1]
        out[n * 3 + 2] = pointOut[2]
        n++
      }
      return n
    },
    /** Seconds since the epoch: the GPU's clock. */
    get time() {
      return now()
    },
    get stars() {
      return stars
    },
    get frames() {
      return frames
    },
    get edges() {
      return edges
    },
    get tablesVersion() {
      return tablesVersion
    },
    /** Grains changed in the last step: `dirty[0..dirtyCount-1]`, or all. */
    dirty,
    get dirtyCount() {
      return dirtyCount
    },
    get allDirty() {
      return allDirty
    },
    /** Grains to draw: 0..count-1 (dead ones among them have no light). */
    get count() {
      return count
    },
    /** Test seam: where grain `g` is and which node/edge it is on. */
    grain(g) {
      const h = headOf(g)
      return {
        phase: phase[g] === ORBITING ? 'orbit' : phase[g] === RIDING ? 'transit' : 'dead',
        node: atId[g],
        to: toId[g],
        edge: viaId[g],
        dying: frozen[g] ? 2 : now() > records[h + DEATH] ? 1 : 0,
      }
    },
    /** Moves the epoch up to now (done by itself every EPOCH_SPAN seconds). */
    rebase,
  }
}
