import { createGraph } from '/Users/dempseypalmer/PycharmProjects/AtlasMap/frontend/src/graph.js'
import { degreeSize, coreSize, CORE_SIZE } from '/Users/dempseypalmer/PycharmProjects/AtlasMap/frontend/src/sizing.js'

let ok = 0, fails = 0
const check = (name, cond, extra = '') =>
  cond ? (ok++, console.log(`  pass  ${name}`)) : (fails++, console.log(`  FAIL  ${name} ${extra}`))
const close = (a, b) => Math.abs(a - b) < 1e-9

// A chain n0 - n1 - ... - n9.
const g = createGraph()
const chain = []
for (let i = 0; i < 10; i++) chain.push(g.addNode({ x: i, y: 0, z: 0 }).id)
for (let i = 1; i < 10; i++) g.addEdge(chain[i - 1], chain[i])

check('leaf is degree size', close(g.sizeOf(chain[0]), degreeSize(1)))
check('middle is degree size', close(g.sizeOf(chain[5]), degreeSize(2)))
check('degree 0 is 1x', degreeSize(0) === 1)
check('degree size capped below core', degreeSize(1e6) < CORE_SIZE)
check('degree size monotonic', [0, 1, 2, 3, 5, 8, 20, 100].every((d, i, a) => i === 0 || degreeSize(d) >= degreeSize(a[i - 1])))

// Core in the middle: fades over hops, symmetric, cut off after 4.
const rev0 = g.revision
g.setCore(chain[4], true)
check('setCore bumps revision', g.revision > rev0)
const sizes = chain.map((id) => g.sizeOf(id))
console.log('    sizes', sizes.map((s) => s.toFixed(3)).join(' '))
check('core is CORE_SIZE', close(sizes[4], CORE_SIZE))
check('hop 1 both sides', close(sizes[3], coreSize(1)) && close(sizes[5], coreSize(1)))
check('hop 2', close(sizes[2], coreSize(2)) && close(sizes[6], coreSize(2)))
check('hop 3', close(sizes[1], coreSize(3)) && close(sizes[7], coreSize(3)))
check('hop 4 (leaf n0) takes max(degree, core)', close(sizes[0], Math.max(degreeSize(1), coreSize(4))) && close(sizes[8], Math.max(degreeSize(2), coreSize(4))))
check('hop 5 back to degree size', close(sizes[9], degreeSize(1)))
check('strictly decreasing over 4 hops', sizes[4] > sizes[5] && sizes[5] > sizes[6] && sizes[6] > sizes[7] && sizes[7] > sizes[8] && sizes[8] > sizes[9])
check('hop 4 still visibly above plain', coreSize(4) > 1.1 && coreSize(5) === 1)

// Idempotent setCore does not bump.
const rev1 = g.revision
g.setCore(chain[4], true)
check('same flag, no bump', g.revision === rev1)
check('setCore on unknown id is false', g.setCore('nope', true) === false)

// Two cores: nearest wins, no summing.
g.setCore(chain[8], true)
check('two cores: n6 at hop 2 from both is coreSize(2), not summed', close(g.sizeOf(chain[6]), coreSize(2)))
check('two cores: n7 takes nearest (hop 1 of n8)', close(g.sizeOf(chain[7]), coreSize(1)))
check('two cores: n9 hop 1', close(g.sizeOf(chain[9]), coreSize(1)))

// High-degree hub beats weak core influence (max rule).
const h = createGraph()
const hub = h.addNode({ x: 0, y: 0, z: 0 }).id
const spokes = []
for (let i = 0; i < 20; i++) { const id = h.addNode({ x: i, y: 1, z: 0 }).id; spokes.push(id); h.addEdge(hub, id) }
const far = [spokes[0]]
for (let i = 0; i < 4; i++) { const id = h.addNode({ x: i, y: 2, z: 0 }).id; h.addEdge(far[far.length - 1], id); far.push(id) }
h.setCore(far[4], true) // core 4 hops from spokes[0], 5 from hub
check('hub keeps degree size outside core range', close(h.sizeOf(hub), degreeSize(20)))
check('hub bigger than weak influence', h.sizeOf(hub) > coreSize(4))

// Unmark core: back to degree sizes.
g.setCore(chain[4], false)
g.setCore(chain[8], false)
check('unmark restores degree sizes', chain.every((id, i) => close(g.sizeOf(id), degreeSize(i === 0 || i === 9 ? 1 : 2))))

// Structural edits invalidate: removing an edge cuts influence.
g.setCore(chain[0], true)
check('before cut: n3 hop 3', close(g.sizeOf(chain[3]), coreSize(3)))
const cut = [...g.edges.values()].find((e) => (e.from === chain[1] && e.to === chain[2]) || (e.from === chain[2] && e.to === chain[1]))
g.removeEdge(cut.id)
check('after cut: n3 back to degree', close(g.sizeOf(chain[3]), degreeSize(2)))
check('after cut: n2 now a leaf', close(g.sizeOf(chain[2]), degreeSize(1)))
g.addEdge(chain[1], chain[2])
check('re-add: n3 influenced again', close(g.sizeOf(chain[3]), coreSize(3)))
g.removeNode(chain[1])
check('remove node: n2 no longer reached', close(g.sizeOf(chain[2]), degreeSize(1)))

// load(): flag round-trips, sizes recomputed, revision bumps.
const payload = g.toPayload()
check('payload carries is_core, not size', payload.nodes.find((n) => n.id === chain[0]).is_core === true && !('size' in payload.nodes[0]))
const g2 = createGraph()
const rev2 = g2.revision
g2.load(payload)
check('load bumps revision', g2.revision > rev2)
check('loaded core size', close(g2.sizeOf(chain[0]), CORE_SIZE))
check('unknown id is 1', g2.sizeOf('zzz') === 1)

// Directed edges walked both ways.
const d = createGraph()
const a = d.addNode({ x: 0, y: 0, z: 0 }).id, b = d.addNode({ x: 1, y: 0, z: 0 }).id
d.load({ nodes: [{ id: a, x: 0, y: 0, z: 0, is_core: false }, { id: b, x: 1, y: 0, z: 0, is_core: true }], edges: [{ id: 'e1', from: a, to: b, directed: true }] })
check('directed edge: influence reaches its source', close(d.sizeOf(a), coreSize(1)))

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
const t2 = performance.now()
console.log(`    20k nodes: recompute ${(t1 - t0).toFixed(2)} ms, cached read ${(t2 - t1).toFixed(4)} ms`)
check('recompute under 20 ms at 20k nodes', t1 - t0 < 20)

console.log(`\n${ok} passed, ${fails} failed`)
process.exit(fails ? 1 : 0)
