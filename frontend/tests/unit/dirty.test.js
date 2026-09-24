// Interim dirty-tracking (V2.md §2.1.1 / F2): graph.js's contentRevision and
// text setters, plus files.js's isDirty/markClean/reset/clearCredentials.
// `files.save()` itself is out of scope here — it needs a DOM (triggerDownload)
// and WebCrypto, and this suite runs in plain Node (vitest.config.js).
import { describe, it, expect } from 'vitest'
import { createGraph } from '../../src/graph.js'
import { createFiles } from '../../src/files.js'

// Just enough for files.js's applyPayload/toPayload to run without a DOM.
function fakeCamera() {
  return {
    position: { toArray: () => [0, 0, 0], fromArray: () => {} },
    rotation: { x: 0, y: 0, z: 0, set: () => {} },
  }
}
const fakeView = { sync: () => {} }
const fakePhysics = { reset: () => {} }

describe('graph.js contentRevision', () => {
  it('starts at 0 on a fresh graph', () => {
    expect(createGraph().contentRevision).toBe(0)
  })

  it('every structural mutator that bumps revision also bumps contentRevision', () => {
    const g = createGraph()
    const before = g.contentRevision
    const a = g.addNode({ x: 0, y: 0, z: 0 })
    const b = g.addNode({ x: 1, y: 0, z: 0 })
    expect(g.contentRevision).toBeGreaterThan(before)
    expect(g.revision).toBeGreaterThan(0)

    const afterNodes = g.contentRevision
    g.addEdge(a.id, b.id)
    expect(g.contentRevision).toBeGreaterThan(afterNodes)
  })

  it('setNodeText bumps only contentRevision, never revision', () => {
    const g = createGraph()
    const node = g.addNode({ x: 0, y: 0, z: 0 })
    const revision = g.revision
    const contentRevision = g.contentRevision
    g.setNodeText(node.id, 'Alpha', 'some notes')
    expect(g.revision).toBe(revision)
    expect(g.contentRevision).toBeGreaterThan(contentRevision)
    expect(node.label).toBe('Alpha')
    expect(node.notes).toBe('some notes')
  })

  it('setEdgeLabel bumps only contentRevision, never revision', () => {
    const g = createGraph()
    const a = g.addNode({ x: 0, y: 0, z: 0 })
    const b = g.addNode({ x: 1, y: 0, z: 0 })
    const edge = g.addEdge(a.id, b.id)
    const revision = g.revision
    const contentRevision = g.contentRevision
    g.setEdgeLabel(edge.id, 'connects to')
    expect(g.revision).toBe(revision)
    expect(g.contentRevision).toBeGreaterThan(contentRevision)
    expect(edge.label).toBe('connects to')
  })

  it('touchContent bumps only contentRevision — physics start/stop and a manual move use this', () => {
    const g = createGraph()
    const revision = g.revision
    const contentRevision = g.contentRevision
    g.touchContent()
    expect(g.revision).toBe(revision)
    expect(g.contentRevision).toBe(contentRevision + 1)
  })

  it('setNodeText/setEdgeLabel return false for an id that does not exist', () => {
    const g = createGraph()
    expect(g.setNodeText('missing', 'x', 'y')).toBe(false)
    expect(g.setEdgeLabel('missing', 'x')).toBe(false)
  })
})

describe('files.js isDirty', () => {
  it('a freshly constructed files object is clean', () => {
    const graph = createGraph()
    const files = createFiles({ graph, view: fakeView, camera: fakeCamera(), physics: fakePhysics })
    expect(files.isDirty).toBe(false)
  })

  it('any graph mutation makes it dirty', () => {
    const graph = createGraph()
    const files = createFiles({ graph, view: fakeView, camera: fakeCamera(), physics: fakePhysics })
    graph.addNode({ x: 0, y: 0, z: 0 })
    expect(files.isDirty).toBe(true)
  })

  it('markClean and reset both re-baseline against the current content revision', () => {
    const graph = createGraph()
    const files = createFiles({ graph, view: fakeView, camera: fakeCamera(), physics: fakePhysics })
    graph.addNode({ x: 0, y: 0, z: 0 })
    expect(files.isDirty).toBe(true)

    files.markClean()
    expect(files.isDirty).toBe(false)
    graph.addNode({ x: 1, y: 0, z: 0 })
    expect(files.isDirty).toBe(true)

    files.reset()
    expect(files.isDirty).toBe(false)
  })

  it('applyPayload marks the map clean — Open never needs interaction.js to touch a revision', () => {
    const graph = createGraph()
    const files = createFiles({ graph, view: fakeView, camera: fakeCamera(), physics: fakePhysics })
    graph.addNode({ x: 0, y: 0, z: 0 }) // dirty the graph before "opening" a file
    expect(files.isDirty).toBe(true)

    files.applyPayload({ nodes: [{ id: 'n1', x: 0, y: 0, z: 0 }], edges: [] })
    expect(files.isDirty).toBe(false)

    graph.addNode({ x: 5, y: 5, z: 5 })
    expect(files.isDirty).toBe(true)
  })

  it('clearCredentials forgets password and filename — New map starts fresh', () => {
    const graph = createGraph()
    const files = createFiles({ graph, view: fakeView, camera: fakeCamera(), physics: fakePhysics })
    files.setCredentials('secret', 'mymap')
    expect(files.hasCredentials).toBe(true)
    expect(files.filename).toBe('mymap.atlasmap')

    files.clearCredentials()
    expect(files.hasCredentials).toBe(false)
    expect(files.filename).toBe('map.atlasmap')
  })
})
