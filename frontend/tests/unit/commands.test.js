// commands.js: every undoable edit round-trips exactly (V2.md F1). Real
// graph, stub view and physics — commands.js is DOM- and three-free so the
// whole undo path runs in plain Node.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createGraph } from '../../src/graph.js'
import { sequentialIds } from '../../src/ids.js'
import { createMapDoc } from '../../src/mapDoc.js'
import { createDocBridge } from '../../src/docBridge.js'
import { createUndo } from '../../src/undo.js'
import { createCommands } from '../../src/commands.js'
import { createFiles } from '../../src/files.js'
import { createPhysics } from '../../src/physics.js'
import { edgeToY } from '../../src/format/ydoc.js'

function stubView() {
  const calls = { syncNodes: 0, syncEdges: 0, updateEdgePositions: 0, sync: 0 }
  const view = {}
  for (const name of Object.keys(calls)) view[name] = () => calls[name]++
  view.calls = calls
  return view
}

/** Just enough of physics.js: start reclusters and marks the run, and stop fades
 *  the colours, like the real one; `settle` stands in for the ticks by moving
 *  every node. */
function stubPhysics(graph) {
  let running = false
  return {
    invalidations: 0,
    invalidate() {
      this.invalidations++
    },
    start() {
      if (graph.nodes.size < 2) return false
      graph.recluster()
      running = true
      graph.touchContent()
      return true
    },
    stop() {
      if (!running) return
      running = false
      if (!graph.reblend()) graph.touchContent()
      this.onSettled?.(graph.layoutSnapshot())
    },
    onSettled: null,
    flyTo() {},
    reset() {
      running = false
    },
    settle() {
      for (const node of graph.nodes.values()) {
        node.x += 100
        node.y -= 50
      }
    },
    get isRunning() {
      return running
    },
  }
}

function setup() {
  const graph = createGraph({ newId: sequentialIds() })
  const view = stubView()
  const physics = stubPhysics(graph)
  const mapDoc = createMapDoc()
  mapDoc.replace({ nodes: [], edges: [] })
  createDocBridge({ mapDoc, graph, view, physics })
  const undo = createUndo({ mapDoc, graph })
  const commands = createCommands({ graph, view, physics, mapDoc, undo, newId: sequentialIds() })
  // Fixtures below are built on the raw graph (no undo entries); this copies
  // them into the doc the commands write, the way opening a file does.
  const sync = () => mapDoc.replace(graph.toPayload())
  return { graph, view, physics, mapDoc, undo, commands, sync }
}

/** Order-independent: a restored item goes back in at the end of its Map. */
function snapshot(graph) {
  const { nodes, edges } = graph.toPayload()
  const byId = (a, b) => a.id.localeCompare(b.id)
  return { nodes: nodes.sort(byId), edges: edges.sort(byId), clusters: graph.clusterCount }
}

/** Runs `act`, then checks undo returns exactly to the state before it and redo to the state after. */
function roundTrip({ graph, commands }, act) {
  const before = snapshot(graph)
  const tokenBefore = graph.contentRevision
  act()
  const after = snapshot(graph)
  const tokenAfter = graph.contentRevision
  expect(after).not.toEqual(before)

  expect(commands.undo()).toBeTypeOf('string')
  expect(snapshot(graph)).toEqual(before)
  expect(graph.contentRevision).toBe(tokenBefore)

  expect(commands.redo()).toBeTypeOf('string')
  expect(snapshot(graph)).toEqual(after)
  expect(graph.contentRevision).toBe(tokenAfter)
}

/** Three nodes, a labelled core hub, two edges — built with the raw graph so no history. */
function populate(graph) {
  const a = graph.addNode({ x: 0, y: 0, z: 0, label: 'Budget', notes: 'q3 numbers' })
  const b = graph.addNode({ x: 60, y: 0, z: 0, label: 'Rent' })
  const c = graph.addNode({ x: 0, y: 60, z: 0 })
  const ab = graph.addEdge(a.id, b.id)
  graph.addEdge(a.id, c.id)
  graph.setEdgeLabel(ab.id, 'pays')
  graph.setCore(a.id, true)
  return { a, b, c, ab }
}

describe('commands.js undo/redo round trips', () => {
  it('spawn: undo removes it, redo brings back the same id', () => {
    const ctx = setup()
    populate(ctx.graph)
    ctx.sync()
    let id
    roundTrip(ctx, () => (id = ctx.commands.spawn({ x: 5, y: 6, z: 7 }).id))
    expect(ctx.graph.getNode(id)).toMatchObject({ x: 5, y: 6, z: 7 })
  })

  it('connect', () => {
    const ctx = setup()
    const { b, c } = populate(ctx.graph)
    ctx.sync()
    roundTrip(ctx, () => expect(ctx.commands.connect(b.id, c.id)).not.toBe(null))
  })

  it('connect refused by the graph records nothing', () => {
    const ctx = setup()
    const { a, b } = populate(ctx.graph)
    ctx.sync()
    expect(ctx.commands.connect(a.id, b.id)).toBe(null) // already linked
    expect(ctx.undo.canUndo).toBe(false)
  })

  it('delete node brings back its fields, core flag, colour and every edge under original ids', () => {
    const ctx = setup()
    const { a } = populate(ctx.graph)
    ctx.sync()
    ctx.graph.getNode(a.id).cluster_color_id = 3
    ctx.graph.getNode(a.id).links.push('https://example.com')
    ctx.sync()
    roundTrip(ctx, () => ctx.commands.deleteNode(a.id))
  })

  it('delete node names what it removes', () => {
    const ctx = setup()
    const { a } = populate(ctx.graph)
    ctx.sync()
    ctx.commands.deleteNode(a.id)
    expect(ctx.commands.undo()).toBe('delete node Budget (2 links)')
  })

  it('delete edge keeps its label', () => {
    const ctx = setup()
    const { ab } = populate(ctx.graph)
    ctx.sync()
    roundTrip(ctx, () => ctx.commands.deleteEdge(ab.id))
    expect(ctx.commands.undo()).toBe('delete edge pays · Budget — Rent')
    expect(ctx.graph.getEdge(ab.id).label).toBe('pays')
  })

  it('node text edits label and notes as one step, in place', () => {
    const ctx = setup()
    const { a } = populate(ctx.graph)
    ctx.sync()
    const live = ctx.graph.getNode(a.id)
    roundTrip(ctx, () => ctx.commands.setNodeText(a.id, 'Budget 2025', 'rewritten'))
    // labels.js polls `node.label` on the object it already holds.
    expect(ctx.graph.getNode(a.id)).toBe(live)
  })

  it('an unchanged text edit records nothing', () => {
    const ctx = setup()
    const { a } = populate(ctx.graph)
    ctx.sync()
    expect(ctx.commands.setNodeText(a.id, 'Budget', 'q3 numbers')).toBe(false)
    expect(ctx.undo.canUndo).toBe(false)
  })

  it('edge label', () => {
    const ctx = setup()
    const { ab } = populate(ctx.graph)
    ctx.sync()
    roundTrip(ctx, () => ctx.commands.setEdgeLabel(ab.id, 'owes'))
  })

  it('core toggle, and sizes follow', () => {
    const ctx = setup()
    const { a, b } = populate(ctx.graph)
    ctx.sync()
    const sizeBefore = ctx.graph.sizeOf(b.id)
    roundTrip(ctx, () => ctx.commands.toggleCore(a.id))
    ctx.commands.undo()
    expect(ctx.graph.sizeOf(b.id)).toBe(sizeBefore)
  })

  it('nexus toggle, from a core, puts the core back on undo', () => {
    const ctx = setup()
    const { a } = populate(ctx.graph)
    ctx.sync()
    roundTrip(ctx, () => ctx.commands.toggleNexus(a.id))
    expect(ctx.graph.getNode(a.id).is_nexus).toBe(true)
    expect(ctx.graph.getNode(a.id).is_core).toBe(false)
    ctx.commands.undo()
    expect(ctx.graph.getNode(a.id).is_core).toBe(true)
    expect(ctx.graph.getNode(a.id).is_nexus).toBe(false)
  })

  it('core toggle on a nexus puts the nexus back on undo', () => {
    const ctx = setup()
    const { b } = populate(ctx.graph)
    ctx.sync()
    ctx.graph.setNexus(b.id, true)
    ctx.sync()
    roundTrip(ctx, () => ctx.commands.toggleCore(b.id))
    ctx.commands.undo()
    expect(ctx.graph.getNode(b.id).is_nexus).toBe(true)
  })

  it('setType: to what it already is records nothing; otherwise one entry', () => {
    const ctx = setup()
    const { a, b } = populate(ctx.graph)
    ctx.sync()
    expect(ctx.commands.setType(a.id, 'core')).toBe(false)
    expect(ctx.commands.setType(b.id, 'star')).toBe(false)
    roundTrip(ctx, () => ctx.commands.setType(a.id, 'nexus'))
    expect(ctx.graph.getNode(a.id).is_nexus).toBe(true)
    roundTrip(ctx, () => ctx.commands.setType(a.id, 'star'))
    expect([ctx.graph.getNode(a.id).is_core, ctx.graph.getNode(a.id).is_nexus]).toEqual([false, false])
    roundTrip(ctx, () => ctx.commands.setType(b.id, 'core'))
  })

  it('split a link with a nexus', () => {
    const ctx = setup()
    const { a, b, ab } = populate(ctx.graph)
    ctx.sync()
    ctx.graph.getEdge(ab.id).directed = true
    ctx.sync()
    let nexus = null
    roundTrip(ctx, () => (nexus = ctx.commands.splitEdge(ab.id)))
    // After the redo roundTrip ends on: A→N→B, the name moved to the nexus.
    expect(ctx.graph.getEdge(ab.id)).toBeNull()
    const n = ctx.graph.getNode(nexus.id)
    expect(n.is_nexus).toBe(true)
    expect(n.label).toBe('pays')
    expect([n.x, n.y, n.z]).toEqual([30, 0, 0])
    const halves = [...ctx.graph.edges.values()].filter((e) => e.from === nexus.id || e.to === nexus.id)
    expect(halves.map((e) => [e.from, e.to, e.directed])).toEqual([
      [a.id, nexus.id, true],
      [nexus.id, b.id, true],
    ])
    expect(ctx.graph.sizeOf(nexus.id)).toBe(0.5)
    expect(ctx.commands.splitEdge('nope')).toBeNull()
  })

  it('move', () => {
    const ctx = setup()
    const { c } = populate(ctx.graph)
    ctx.sync()
    roundTrip(ctx, () => ctx.commands.move(c.id, { x: -10, y: 20, z: 30 }))
    expect(ctx.view.calls.updateEdgePositions).toBeGreaterThan(0)
  })

  it('a move to the same spot records nothing', () => {
    const ctx = setup()
    const { c } = populate(ctx.graph)
    ctx.sync()
    expect(ctx.commands.move(c.id, { x: 0, y: 60, z: 0 })).toBe(false)
    expect(ctx.undo.canUndo).toBe(false)
  })

  it('structural edits sync the view and poke physics', () => {
    const ctx = setup()
    const { a } = populate(ctx.graph)
    ctx.sync()
    ctx.commands.deleteNode(a.id)
    expect(ctx.view.calls.syncNodes).toBe(1)
    expect(ctx.view.calls.syncEdges).toBe(1)
    expect(ctx.physics.invalidations).toBe(1)
    // Never a full sync: that snaps sizes instead of easing them.
    expect(ctx.view.calls.sync).toBe(0)
  })

  it('a chain of edits unwinds to the start and replays to the end', () => {
    const ctx = setup()
    const { a, b } = populate(ctx.graph)
    ctx.sync()
    const start = snapshot(ctx.graph)
    const n = ctx.commands.spawn({ x: 1, y: 2, z: 3 })
    ctx.commands.connect(n.id, a.id)
    ctx.commands.setNodeText(n.id, 'Child', '')
    ctx.commands.deleteNode(a.id)
    ctx.commands.move(b.id, { x: 9, y: 9, z: 9 })
    const end = snapshot(ctx.graph)
    while (ctx.commands.undo());
    expect(snapshot(ctx.graph)).toEqual(start)
    while (ctx.commands.redo());
    expect(snapshot(ctx.graph)).toEqual(end)
  })

  it('ids are never reused after an undone spawn', () => {
    const ctx = setup()
    const first = ctx.commands.spawn({ x: 0, y: 0, z: 0 }).id
    ctx.commands.undo()
    const second = ctx.commands.spawn({ x: 0, y: 0, z: 0 }).id
    expect(second).not.toBe(first)
    expect(ctx.commands.redo()).toBe(null) // the new spawn dropped the redo
  })

  it('undo and redo on an empty history report null', () => {
    const ctx = setup()
    expect(ctx.commands.undo()).toBe(null)
    expect(ctx.commands.redo()).toBe(null)
  })

  it('clear empties the history', () => {
    const ctx = setup()
    ctx.commands.spawn({ x: 0, y: 0, z: 0 })
    ctx.commands.clear()
    expect(ctx.commands.undo()).toBe(null)
  })
})

describe('commands.js balance', () => {
  function twoClusters(graph) {
    // Two triangles joined by one bridge: Louvain splits them.
    const ids = []
    for (let i = 0; i < 6; i++) ids.push(graph.addNode({ x: i * 10, y: 0, z: 0 }).id)
    for (const [p, q] of [
      [0, 1],
      [1, 2],
      [0, 2],
      [3, 4],
      [4, 5],
      [3, 5],
      [2, 3],
    ])
      graph.addEdge(ids[p], ids[q])
    return ids
  }

  it('undo mid-run stops it and restores every position, colour and the cluster count', () => {
    const ctx = setup()
    twoClusters(ctx.graph)
    ctx.sync()
    const before = snapshot(ctx.graph)
    const token = ctx.graph.contentRevision
    expect(ctx.commands.toggleBalance()).toBe(true)
    ctx.physics.settle()
    expect(ctx.graph.clusterCount).toBeGreaterThan(0)
    const during = snapshot(ctx.graph)

    expect(ctx.commands.undo()).toBe('balance')
    expect(ctx.physics.isRunning).toBe(false)
    expect(snapshot(ctx.graph)).toEqual(before)
    expect(ctx.graph.contentRevision).toBe(token)

    // Undoing cut the run short, and a run ending — however it ends — is what
    // fades the colours. So redo puts back where the run had got to, now with
    // its blends: the same positions and colour ids, plus a blend on each node.
    expect(ctx.commands.redo()).toBe('balance')
    const redone = snapshot(ctx.graph)
    expect(redone.nodes.every((node) => Array.isArray(node.blend))).toBe(true)
    const unblended = (shot) => ({ ...shot, nodes: shot.nodes.map((node) => ({ ...node, blend: null })) })
    expect(unblended(redone)).toEqual(during)
  })

  it('undo after the run finished restores the pre-run layout; redo the finished one', () => {
    const ctx = setup()
    twoClusters(ctx.graph)
    ctx.sync()
    const before = snapshot(ctx.graph)
    ctx.commands.toggleBalance()
    ctx.physics.settle()
    ctx.physics.stop() // the run ending on its own
    const finished = snapshot(ctx.graph)
    const finishedToken = ctx.graph.contentRevision
    // The end of a run is what fades the colours, so the finished state has
    // blends and the one before it had none — undo has to take them away.
    expect(finished.nodes.every((node) => Array.isArray(node.blend))).toBe(true)
    expect(before.nodes.every((node) => node.blend === null)).toBe(true)
    ctx.commands.undo()
    expect(snapshot(ctx.graph)).toEqual(before)
    ctx.commands.redo()
    expect(snapshot(ctx.graph)).toEqual(finished)
    expect(ctx.graph.contentRevision).toBe(finishedToken)
  })

  it('toggling a running balance stops it without a new entry', () => {
    const ctx = setup()
    twoClusters(ctx.graph)
    ctx.sync()
    ctx.commands.toggleBalance()
    expect(ctx.commands.toggleBalance()).toBe(false)
    expect(ctx.physics.isRunning).toBe(false)
    expect(ctx.undo.size).toBe(1)
  })

  it('a balance that cannot start records nothing', () => {
    const ctx = setup()
    ctx.graph.addNode({ x: 0, y: 0, z: 0 })
    ctx.sync()
    expect(ctx.commands.toggleBalance()).toBe(false)
    expect(ctx.undo.canUndo).toBe(false)
  })

  it('an edit made mid-run unwinds first, then the run', () => {
    const ctx = setup()
    const ids = twoClusters(ctx.graph)
    ctx.sync()
    const before = snapshot(ctx.graph)
    ctx.commands.toggleBalance()
    ctx.physics.settle()
    ctx.commands.deleteNode(ids[0])
    ctx.physics.settle()
    expect(ctx.commands.undo()).toMatch(/^delete node/)
    expect(ctx.commands.undo()).toBe('balance')
    expect(snapshot(ctx.graph)).toEqual(before)
  })
})

describe('dirty state across undo', () => {
  const fakeCamera = () => ({
    position: { toArray: () => [0, 0, 0], fromArray: () => {} },
    rotation: { x: 0, y: 0, z: 0, set: () => {} },
  })

  function withFiles() {
    const ctx = setup()
    ctx.files = createFiles({ graph: ctx.graph, view: ctx.view, camera: fakeCamera(), physics: ctx.physics })
    return ctx
  }

  // Just enough browser for files.save(): a secure context with Node's own
  // WebCrypto, and a download that goes nowhere.
  beforeEach(() => {
    vi.stubGlobal('window', { isSecureContext: true, crypto: globalThis.crypto })
    vi.stubGlobal('document', {
      createElement: () => ({ click() {}, remove() {} }),
      body: { append() {} },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('undoing back to the saved state reads clean; redo reads dirty again', async () => {
    const ctx = withFiles()
    const n = ctx.commands.spawn({ x: 0, y: 0, z: 0 })
    expect((await ctx.files.save()).ok).toBe(true)
    expect(ctx.files.isDirty).toBe(false)
    ctx.commands.setNodeText(n.id, 'Draft', '')
    expect(ctx.files.isDirty).toBe(true)
    ctx.commands.undo()
    expect(ctx.files.isDirty).toBe(false)
    ctx.commands.redo()
    expect(ctx.files.isDirty).toBe(true)
  })

  it('undoing past the save point reads dirty', async () => {
    const ctx = withFiles()
    ctx.commands.spawn({ x: 0, y: 0, z: 0 })
    ctx.commands.spawn({ x: 1, y: 0, z: 0 })
    await ctx.files.save()
    ctx.commands.undo()
    expect(ctx.files.isDirty).toBe(true)
  })

  it('a new edit after undo never matches the save, even with the same count of steps', async () => {
    const ctx = withFiles()
    const n = ctx.commands.spawn({ x: 0, y: 0, z: 0 })
    ctx.commands.setNodeText(n.id, 'A', '')
    await ctx.files.save()
    ctx.commands.undo()
    ctx.commands.setNodeText(n.id, 'B', '')
    expect(ctx.files.isDirty).toBe(true)
  })

  it('a running balance always reads dirty', () => {
    const ctx = withFiles()
    ctx.graph.addNode({ x: 0, y: 0, z: 0 })
    ctx.sync()
    ctx.graph.addNode({ x: 5, y: 0, z: 0 })
    ctx.sync()
    ctx.files.markClean()
    ctx.commands.toggleBalance()
    expect(ctx.files.isDirty).toBe(true)
  })

  it('a save taken mid-run never reads clean again', async () => {
    const ctx = withFiles()
    ctx.graph.addNode({ x: 0, y: 0, z: 0 })
    ctx.sync()
    ctx.graph.addNode({ x: 5, y: 0, z: 0 })
    ctx.sync()
    ctx.commands.toggleBalance()
    await ctx.files.save()
    ctx.physics.stop()
    expect(ctx.files.isDirty).toBe(true)
    ctx.commands.undo()
    expect(ctx.files.isDirty).toBe(true)
    ctx.commands.redo()
    expect(ctx.files.isDirty).toBe(true)
  })
})

describe('multiplayer-ready commands', () => {
  it('a command writes the doc, and the graph follows', () => {
    const { commands, mapDoc, graph } = setup()
    const node = commands.spawn({ x: 1, y: 2, z: 3 })
    expect(mapDoc.nodes.get(node.id).get('x')).toBe(1)
    expect(graph.getNode(node.id).z).toBe(3)
  })

  it('nothing changes while editing is not allowed', () => {
    const graph = createGraph({ newId: sequentialIds() })
    const mapDoc = createMapDoc()
    mapDoc.replace({ nodes: [], edges: [] })
    const view = stubView()
    const physics = stubPhysics(graph)
    createDocBridge({ mapDoc, graph, view, physics })
    const undo = createUndo({ mapDoc, graph })
    const commands = createCommands({ graph, view, physics, mapDoc, undo, canEdit: () => false })
    expect(commands.spawn({ x: 0, y: 0, z: 0 })).toBeNull()
    expect(graph.nodes.size).toBe(0)
    expect(commands.toggleBalance()).toBe(false)
    expect(commands.undo()).toBeNull()
  })

  it('a Balance reaches the doc as one transaction when it settles, and undoes as one step', () => {
    const { commands, mapDoc, physics, graph } = setup()
    const a = commands.spawn({ x: 0, y: 0, z: 0 })
    const b = commands.spawn({ x: 10, y: 0, z: 0 })
    commands.connect(a.id, b.id)
    let transactions = 0
    mapDoc.doc.on('afterTransaction', () => transactions++)
    commands.toggleBalance()
    physics.settle()
    expect(transactions).toBe(0) // nothing reaches the doc mid-run
    commands.toggleBalance() // stop → settles → commits
    expect(transactions).toBe(1)
    expect(mapDoc.nodes.get(a.id).get('x')).toBe(graph.getNode(a.id).x)
    expect(mapDoc.nodes.get(a.id).get('blend')).toEqual(graph.getNode(a.id).blend)
    expect(commands.undo()).toBe('balance')
    expect(graph.getNode(a.id).x).toBe(0)
  })

  it('a notes session is typed into the shared text and undoes as one step', () => {
    const { commands, graph, mapDoc } = setup()
    const node = commands.spawn({ x: 0, y: 0, z: 0 })
    const session = commands.editNotes(node.id)
    for (const ch of 'hi there') mapDoc.transact(() => session.text.insert(session.text.length, ch))
    session.end()
    expect(graph.getNode(node.id).notes).toBe('hi there')
    expect(commands.undo()).toBe(`edit node ${node.id}`)
    expect(graph.getNode(node.id).notes).toBe('')
  })

  it('the doc and the graph agree after a run of edits and undos', () => {
    const { commands, mapDoc, graph, physics } = setup()
    const a = commands.spawn({ x: 0, y: 0, z: 0 })
    const b = commands.spawn({ x: 20, y: 0, z: 0 })
    const c = commands.spawn({ x: 0, y: 20, z: 0 })
    commands.connect(a.id, b.id)
    commands.connect(b.id, c.id)
    commands.setNodeText(a.id, 'Alpha', 'notes')
    commands.toggleCore(b.id)
    commands.splitEdge([...graph.edges.keys()][0])
    commands.toggleBalance()
    physics.settle()
    commands.undo()
    commands.redo()
    commands.deleteNode(c.id)
    commands.undo()
    const byId = (p, q) => p.id.localeCompare(q.id)
    const docNodes = [...mapDoc.nodes.values()].map((n) => n.toJSON()).sort(byId)
    const graphNodes = graph.toPayload().nodes.sort(byId)
    expect(docNodes).toEqual(graphNodes)
    const docEdges = [...mapDoc.edges.values()].map((e) => e.toJSON()).sort(byId)
    expect(docEdges).toEqual(graph.toPayload().edges.sort(byId))
  })
})

describe("Balance while someone else's layout is flying in", () => {
  it("B lands their flight and starts this tab's own run, rather than just stopping theirs", () => {
    const graph = createGraph({ newId: sequentialIds() })
    const view = { syncNodes() {}, syncEdges() {}, updateEdgePositions() {} }
    const physics = createPhysics(graph, view)
    const mapDoc = createMapDoc()
    mapDoc.replace({ nodes: [], edges: [] })
    createDocBridge({ mapDoc, graph, view, physics })
    const undo = createUndo({ mapDoc, graph })
    const commands = createCommands({ graph, view, physics, mapDoc, undo, newId: sequentialIds() })
    const a = commands.spawn({ x: 0, y: 0, z: 0 })
    const b = commands.spawn({ x: 30, y: 0, z: 0 })
    commands.connect(a.id, b.id)
    physics.flyTo(new Map([[a.id, [5, 0, 0]]]))
    expect(physics.isLocalRun).toBe(false)
    expect(commands.toggleBalance()).toBe(true)
    expect(physics.isLocalRun).toBe(true)
  })
})

describe('Review Focus 1: a link two people made at once, deleted', () => {
  function withDuplicatePair() {
    const ctx = setup()
    const a = ctx.commands.spawn({ x: 0, y: 0, z: 0 })
    const b = ctx.commands.spawn({ x: 10, y: 0, z: 0 })
    // Two concurrent links between a and b: only the smaller id shows.
    ctx.mapDoc.transact(() => {
      ctx.mapDoc.edges.set(
        'e-bbb',
        edgeToY({ id: 'e-bbb', from: a.id, to: b.id, directed: false, label: '' }),
      )
      ctx.mapDoc.edges.set(
        'e-aaa',
        edgeToY({ id: 'e-aaa', from: b.id, to: a.id, directed: false, label: '' }),
      )
    }, 'room')
    expect([...ctx.graph.edges.keys()]).toEqual(['e-aaa'])
    return { ...ctx, a, b }
  }

  it('deleting the link that shows takes its hidden twin too, so it stays deleted', () => {
    const { graph, mapDoc, commands } = withDuplicatePair()
    expect(commands.deleteEdge('e-aaa')).toBe(true)
    expect(graph.edges.size).toBe(0)
    expect(mapDoc.edges.size).toBe(0)
    commands.undo()
    expect(graph.edges.size).toBe(1)
  })

  it('splitting it leaves no direct link behind', () => {
    const { graph, commands, a, b } = withDuplicatePair()
    commands.splitEdge('e-aaa')
    const direct = [...graph.edges.values()].filter(
      (e) => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id),
    )
    expect(direct).toEqual([])
  })
})
