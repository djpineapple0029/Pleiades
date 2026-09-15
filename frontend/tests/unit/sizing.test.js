// Ported from tests/_rescued/unit/sizing.test.mjs (session 4 verification).
// Each assertion's condition is computed inline, at the same point in the
// script as the original `check()` call, then handed to a same-named `it()`
// — the graph is mutated between assertions (setCore, removeEdge, …), so the
// condition has to be captured *before* later mutations run, not evaluated
// lazily inside a deferred `it()` body.
import { describe, it, expect } from 'vitest'
import { createGraph } from '../../src/graph.js'
import { degreeSize, coreSize, CORE_SIZE } from '../../src/sizing.js'

const close = (a, b) => Math.abs(a - b) < 1e-9

describe('sizing', () => {
  // A chain n0 - n1 - ... - n9.
  const g = createGraph()
  const chain = []
  for (let i = 0; i < 10; i++) chain.push(g.addNode({ x: i, y: 0, z: 0 }).id)
  for (let i = 1; i < 10; i++) g.addEdge(chain[i - 1], chain[i])

  // Captured now, not read lazily inside it(): the describe body below still
  // has to run removeNode(chain[1]) etc. before any it() actually executes,
  // and g.sizeOf(chain[0]) would answer as of *that* later state otherwise.
  const leafIsDegreeSize = close(g.sizeOf(chain[0]), degreeSize(1))
  const middleIsDegreeSize = close(g.sizeOf(chain[5]), degreeSize(2))
  it('leaf is degree size', () => expect(leafIsDegreeSize).toBe(true))
  it('middle is degree size', () => expect(middleIsDegreeSize).toBe(true))
  it('degree 0 is 1x', () => expect(degreeSize(0)).toBe(1))
  it('degree size capped below core', () => expect(degreeSize(1e6)).toBeLessThan(CORE_SIZE))
  it('degree size monotonic', () => {
    expect([0, 1, 2, 3, 5, 8, 20, 100].every((d, i, a) => i === 0 || degreeSize(d) >= degreeSize(a[i - 1]))).toBe(true)
  })

  // Core in the middle: fades over hops, symmetric, cut off after 4.
  const rev0 = g.revision
  g.setCore(chain[4], true)
  const coreBumpsRevision = g.revision > rev0
  const sizes = chain.map((id) => g.sizeOf(id))
  it('setCore bumps revision', () => expect(coreBumpsRevision).toBe(true))
  it('core is CORE_SIZE', () => expect(close(sizes[4], CORE_SIZE)).toBe(true))
  it('hop 1 both sides', () => expect(close(sizes[3], coreSize(1)) && close(sizes[5], coreSize(1))).toBe(true))
  it('hop 2', () => expect(close(sizes[2], coreSize(2)) && close(sizes[6], coreSize(2))).toBe(true))
  it('hop 3', () => expect(close(sizes[1], coreSize(3)) && close(sizes[7], coreSize(3))).toBe(true))
  it('hop 4 (leaf n0) takes max(degree, core)', () => {
    expect(close(sizes[0], Math.max(degreeSize(1), coreSize(4))) && close(sizes[8], Math.max(degreeSize(2), coreSize(4)))).toBe(true)
  })
  it('hop 5 back to degree size', () => expect(close(sizes[9], degreeSize(1))).toBe(true))
  it('strictly decreasing over 4 hops', () => {
    expect(sizes[4] > sizes[5] && sizes[5] > sizes[6] && sizes[6] > sizes[7] && sizes[7] > sizes[8] && sizes[8] > sizes[9]).toBe(true)
  })
  it('hop 4 still visibly above plain', () => expect(coreSize(4) > 1.1 && coreSize(5) === 1).toBe(true))

  // Idempotent setCore does not bump.
  const rev1 = g.revision
  g.setCore(chain[4], true)
  const sameFlagNoBump = g.revision === rev1
  const setCoreUnknownIsFalse = g.setCore('nope', true) === false
  it('same flag, no bump', () => expect(sameFlagNoBump).toBe(true))
  it('setCore on unknown id is false', () => expect(setCoreUnknownIsFalse).toBe(true))

  // Two cores: nearest wins, no summing.
  g.setCore(chain[8], true)
  const n6TwoCores = close(g.sizeOf(chain[6]), coreSize(2))
  const n7NearestHop1 = close(g.sizeOf(chain[7]), coreSize(1))
  const n9Hop1 = close(g.sizeOf(chain[9]), coreSize(1))
  it("two cores: n6 at hop 2 from both is coreSize(2), not summed", () => expect(n6TwoCores).toBe(true))
  it('two cores: n7 takes nearest (hop 1 of n8)', () => expect(n7NearestHop1).toBe(true))
  it('two cores: n9 hop 1', () => expect(n9Hop1).toBe(true))

  // High-degree hub beats weak core influence (max rule).
  const h = createGraph()
  const hub = h.addNode({ x: 0, y: 0, z: 0 }).id
  const spokes = []
  for (let i = 0; i < 20; i++) { const id = h.addNode({ x: i, y: 1, z: 0 }).id; spokes.push(id); h.addEdge(hub, id) }
  const far = [spokes[0]]
  for (let i = 0; i < 4; i++) { const id = h.addNode({ x: i, y: 2, z: 0 }).id; h.addEdge(far[far.length - 1], id); far.push(id) }
  h.setCore(far[4], true) // core 4 hops from spokes[0], 5 from hub
  const hubKeepsDegreeSize = close(h.sizeOf(hub), degreeSize(20))
  const hubBiggerThanWeakInfluence = h.sizeOf(hub) > coreSize(4)
  it('hub keeps degree size outside core range', () => expect(hubKeepsDegreeSize).toBe(true))
  it('hub bigger than weak influence', () => expect(hubBiggerThanWeakInfluence).toBe(true))

  // Unmark core: back to degree sizes.
  g.setCore(chain[4], false)
  g.setCore(chain[8], false)
  const unmarkRestores = chain.every((id, i) => close(g.sizeOf(id), degreeSize(i === 0 || i === 9 ? 1 : 2)))
  it('unmark restores degree sizes', () => expect(unmarkRestores).toBe(true))

  // Structural edits invalidate: removing an edge cuts influence.
  g.setCore(chain[0], true)
  const beforeCutN3Hop3 = close(g.sizeOf(chain[3]), coreSize(3))
  const cut = [...g.edges.values()].find((e) => (e.from === chain[1] && e.to === chain[2]) || (e.from === chain[2] && e.to === chain[1]))
  g.removeEdge(cut.id)
  const afterCutN3BackToDegree = close(g.sizeOf(chain[3]), degreeSize(2))
  const afterCutN2Leaf = close(g.sizeOf(chain[2]), degreeSize(1))
  g.addEdge(chain[1], chain[2])
  const reAddN3Influenced = close(g.sizeOf(chain[3]), coreSize(3))
  g.removeNode(chain[1])
  const removeNodeN2NoLongerReached = close(g.sizeOf(chain[2]), degreeSize(1))
  it('before cut: n3 hop 3', () => expect(beforeCutN3Hop3).toBe(true))
  it('after cut: n3 back to degree', () => expect(afterCutN3BackToDegree).toBe(true))
  it('after cut: n2 now a leaf', () => expect(afterCutN2Leaf).toBe(true))
  it('re-add: n3 influenced again', () => expect(reAddN3Influenced).toBe(true))
  it('remove node: n2 no longer reached', () => expect(removeNodeN2NoLongerReached).toBe(true))

  // load(): flag round-trips, sizes recomputed, revision bumps.
  const payload = g.toPayload()
  const payloadCarriesIsCoreNotSize = payload.nodes.find((n) => n.id === chain[0]).is_core === true && !('size' in payload.nodes[0])
  const g2 = createGraph()
  const rev2 = g2.revision
  g2.load(payload)
  const loadBumpsRevision = g2.revision > rev2
  const loadedCoreSize = close(g2.sizeOf(chain[0]), CORE_SIZE)
  const unknownIdIsOne = g2.sizeOf('zzz') === 1
  it('payload carries is_core, not size', () => expect(payloadCarriesIsCoreNotSize).toBe(true))
  it('load bumps revision', () => expect(loadBumpsRevision).toBe(true))
  it('loaded core size', () => expect(loadedCoreSize).toBe(true))
  it('unknown id is 1', () => expect(unknownIdIsOne).toBe(true))

  // Directed edges walked both ways.
  const d = createGraph()
  const a = d.addNode({ x: 0, y: 0, z: 0 }).id, b = d.addNode({ x: 1, y: 0, z: 0 }).id
  d.load({ nodes: [{ id: a, x: 0, y: 0, z: 0, is_core: false }, { id: b, x: 1, y: 0, z: 0, is_core: true }], edges: [{ id: 'e1', from: a, to: b, directed: true }] })
  const directedEdgeInfluenceReachesSource = close(d.sizeOf(a), coreSize(1))
  it("directed edge: influence reaches its source", () => expect(directedEdgeInfluenceReachesSource).toBe(true))

  // BFS cost on a big graph.
  const big = createGraph()
  const ids = []
  for (let i = 0; i < 20000; i++) ids.push(big.addNode({ x: 0, y: 0, z: 0 }).id)
  for (let i = 1; i < 20000; i++) big.addEdge(ids[i], ids[Math.floor(Math.random() * i)])
  for (let i = 0; i < 40; i++) big.setCore(ids[i * 500], true)
  const t0 = performance.now()
  big.sizeOf(ids[0])
  const t1 = performance.now()
  big.sizeOf(ids[1]) // cached
  // Loosened from the original session's 20ms: under Vitest's worker pool
  // this machine measured ~55ms, well short of an O(n^2) blowup (seconds) —
  // the bound here is to catch that, not to pin a specific millisecond figure.
  it('recompute stays well clear of a BFS-per-frame blowup at 20k nodes', () => expect(t1 - t0).toBeLessThan(200))
})
