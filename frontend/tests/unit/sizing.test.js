// Rewritten for the core-only sizing rule (balance-color-fade): a core is
// CORE_SIZE and every other node 1x, whatever its degree or its distance from
// a core. The original session-4 suite (degree curve, per-hop core boost) is in
// git history. Same eager-capture pattern as before: conditions are computed
// at the point in the script where the graph is in the state being checked,
// because it is mutated between assertions.
import { describe, it, expect } from 'vitest'
import { createGraph } from '../../src/graph.js'
import { CORE_SIZE } from '../../src/sizing.js'
import { ALWAYS_ON_SIZE } from '../../src/labels.js'

describe('sizing', () => {
  it('a core is 2.25x (3x brought down by a quarter)', () => expect(CORE_SIZE).toBe(2.25))
  it('a core is still labelled at any distance', () =>
    expect(CORE_SIZE).toBeGreaterThanOrEqual(ALWAYS_ON_SIZE))

  // A chain n0 - n1 - ... - n9, plus a hub with 20 spokes hanging off n9.
  const g = createGraph()
  const chain = []
  for (let i = 0; i < 10; i++) chain.push(g.addNode({ x: i, y: 0, z: 0 }).id)
  for (let i = 1; i < 10; i++) g.addEdge(chain[i - 1], chain[i])
  for (let i = 0; i < 20; i++) g.addEdge(chain[9], g.addNode({ x: i, y: 1, z: 0 }).id)

  const plainAllOne = [...g.nodes.keys()].every((id) => g.sizeOf(id) === 1)
  it('with no cores, every node is 1x whatever its degree', () => expect(plainAllOne).toBe(true))

  const rev0 = g.revision
  g.setCore(chain[4], true)
  const coreBumpsRevision = g.revision > rev0
  const sizes = chain.map((id) => g.sizeOf(id))
  it('setCore bumps revision', () => expect(coreBumpsRevision).toBe(true))
  it('the core is CORE_SIZE', () => expect(sizes[4]).toBe(CORE_SIZE))
  it("a core's neighbours get no boost", () => expect(sizes[3] === 1 && sizes[5] === 1).toBe(true))
  it('nor does anything further out', () =>
    expect(sizes.every((size, i) => i === 4 || size === 1)).toBe(true))
  it('a 21-link hub gets no boost', () => expect(g.sizeOf(chain[9])).toBe(1))

  const rev1 = g.revision
  g.setCore(chain[4], true)
  const sameFlagNoBump = g.revision === rev1
  it('same flag, no bump', () => expect(sameFlagNoBump).toBe(true))
  it('setCore on unknown id is false', () => expect(g.setCore('nope', true)).toBe(false))

  // Two neighbouring cores are both CORE_SIZE; nothing sums.
  g.setCore(chain[5], true)
  const twoCores =
    g.sizeOf(chain[4]) === CORE_SIZE && g.sizeOf(chain[5]) === CORE_SIZE && g.sizeOf(chain[6]) === 1
  it('two adjacent cores are each CORE_SIZE, and their shared neighbour is 1x', () =>
    expect(twoCores).toBe(true))

  g.setCore(chain[4], false)
  g.setCore(chain[5], false)
  const unmarkRestores = chain.every((id) => g.sizeOf(id) === 1)
  it('unmarking a core puts it back to 1x', () => expect(unmarkRestores).toBe(true))

  // load(): the flag round-trips, the size is derived rather than stored.
  g.setCore(chain[0], true)
  const payload = g.toPayload()
  const payloadCarriesIsCoreNotSize =
    payload.nodes.find((n) => n.id === chain[0]).is_core === true && !('size' in payload.nodes[0])
  const g2 = createGraph()
  const rev2 = g2.revision
  g2.load(payload)
  it('payload carries is_core, not size', () => expect(payloadCarriesIsCoreNotSize).toBe(true))
  it('load bumps revision', () => expect(g2.revision).toBeGreaterThan(rev2))
  it('loaded core size', () => expect(g2.sizeOf(chain[0])).toBe(CORE_SIZE))
  it('unknown id is 1', () => expect(g2.sizeOf('zzz')).toBe(1))
})
