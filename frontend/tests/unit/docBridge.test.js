import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { createGraph } from '../../src/graph.js'
import { sequentialIds } from '../../src/ids.js'
import { createMapDoc } from '../../src/mapDoc.js'
import { createDocBridge } from '../../src/docBridge.js'
import { nodeToY, edgeToY } from '../../src/format/ydoc.js'

function stubView() {
  const calls = { syncNodes: 0, syncEdges: 0, updateEdgePositions: 0 }
  const view = { calls }
  for (const name of Object.keys(calls)) view[name] = () => calls[name]++
  return view
}
function stubPhysics() {
  return {
    invalidations: 0,
    flights: [],
    invalidate() {
      this.invalidations++
    },
    flyTo(targets) {
      this.flights.push(targets)
    },
    isRunning: false,
  }
}
const node = (id, extra = {}) => ({
  id,
  label: id,
  notes: '',
  x: 0,
  y: 0,
  z: 0,
  cluster_color_id: 0,
  blend: null,
  is_core: false,
  is_nexus: false,
  links: [],
  ...extra,
})
const edge = (id, from, to) => ({ id, from, to, directed: false, label: '' })

function setup(payload = { nodes: [node('a'), node('b')], edges: [] }) {
  const mapDoc = createMapDoc()
  const graph = createGraph({ newId: sequentialIds() })
  mapDoc.replace(payload)
  graph.load(payload)
  const view = stubView()
  const physics = stubPhysics()
  const onRemoved = vi.fn()
  const onRemoteChange = vi.fn()
  const bridge = createDocBridge({ mapDoc, graph, view, physics, onRemoved, onRemoteChange })
  return { mapDoc, graph, view, physics, onRemoved, onRemoteChange, bridge }
}

/** A second peer: edits made on it arrive as remote transactions. */
function peer(mapDoc) {
  const other = new Y.Doc()
  Y.applyUpdate(other, Y.encodeStateAsUpdate(mapDoc.doc))
  other.on('update', (update) => Y.applyUpdate(mapDoc.doc, update, 'remote'))
  return other
}

describe('doc → graph', () => {
  it('a load-origin replace is ignored (the caller loads the graph)', () => {
    const { mapDoc, view } = setup()
    mapDoc.replace({ nodes: [node('z')], edges: [] })
    expect(view.calls.syncNodes).toBe(0)
  })

  it('a local node add appears in the graph and syncs the view', () => {
    const { mapDoc, graph, view, physics } = setup()
    mapDoc.transact(() => mapDoc.nodes.set('c', nodeToY(node('c', { x: 5 }))))
    expect(graph.getNode('c').x).toBe(5)
    expect(view.calls.syncNodes).toBeGreaterThan(0)
    expect(physics.invalidations).toBeGreaterThan(0)
  })

  it('a local move snaps; a remote move flies', () => {
    const { mapDoc, graph, physics, view } = setup()
    mapDoc.transact(() => mapDoc.nodes.get('a').set('x', 9))
    expect(graph.getNode('a').x).toBe(9)
    expect(view.calls.updateEdgePositions).toBe(1)
    const other = peer(mapDoc)
    other.getMap('nodes').get('b').set('x', 7)
    expect(graph.getNode('b').x).toBe(0) // not snapped
    expect(physics.flights.at(-1).get('b')).toEqual([7, 0, 0])
  })

  it('a text edit touches neither the view nor physics', () => {
    const { mapDoc, graph, view, physics } = setup()
    mapDoc.transact(() => mapDoc.nodes.get('a').set('label', 'Alpha'))
    expect(graph.getNode('a').label).toBe('Alpha')
    expect(view.calls).toEqual({ syncNodes: 0, syncEdges: 0, updateEdgePositions: 0 })
    expect(physics.invalidations).toBe(0)
  })

  it('a change of kind invalidates physics without resyncing the view', () => {
    const { mapDoc, graph, view, physics } = setup()
    mapDoc.transact(() => mapDoc.nodes.get('a').set('is_core', true))
    expect(graph.getNode('a').is_core).toBe(true)
    expect(view.calls.syncNodes).toBe(0)
    expect(physics.invalidations).toBe(1)
  })

  it('remote notes typing updates the graph text', () => {
    const { mapDoc, graph } = setup()
    const other = peer(mapDoc)
    other.getMap('nodes').get('a').get('notes').insert(0, 'hi')
    expect(graph.getNode('a').notes).toBe('hi')
  })

  it('a remote delete removes the node and its links, and reports it', () => {
    const { mapDoc, graph, onRemoved } = setup()
    mapDoc.transact(() => mapDoc.edges.set('e1', edgeToY(edge('e1', 'a', 'b'))))
    const other = peer(mapDoc)
    other.getMap('nodes').delete('a')
    expect(graph.getNode('a')).toBeNull()
    expect(graph.getEdge('e1')).toBeNull()
    expect(onRemoved).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'node', id: 'a', local: false, label: 'a', at: { x: 0, y: 0, z: 0 } }),
    )
    expect(onRemoved).toHaveBeenCalledWith(expect.objectContaining({ kind: 'edge', id: 'e1', local: false }))
  })

  it('a node delete that takes its links redraws the lines', () => {
    const { mapDoc, view } = setup()
    mapDoc.transact(() => mapDoc.edges.set('e1', edgeToY(edge('e1', 'a', 'b'))))
    const before = view.calls.syncEdges
    mapDoc.transact(() => {
      mapDoc.edges.delete('e1')
      mapDoc.nodes.delete('a')
    })
    expect(view.calls.syncEdges).toBe(before + 1)
    expect(view.calls.syncNodes).toBeGreaterThan(0)
  })

  it('Review Focus 1: two concurrent links between the same pair → one link, the smaller id', () => {
    const { mapDoc, graph } = setup()
    const other = peer(mapDoc)
    other.getMap('edges').set('e-zzz', edgeToY(edge('e-zzz', 'a', 'b')))
    mapDoc.transact(() => mapDoc.edges.set('e-aaa', edgeToY(edge('e-aaa', 'b', 'a'))))
    expect([...graph.edges.keys()]).toEqual(['e-aaa'])
  })

  it('Review Focus 2: a link to a star deleted concurrently never shows', () => {
    const { mapDoc, graph } = setup()
    const other = peer(mapDoc)
    other.getMap('nodes').delete('b')
    mapDoc.transact(() => mapDoc.edges.set('e1', edgeToY(edge('e1', 'a', 'b'))))
    expect(graph.edges.size).toBe(0)
  })

  it('Review Focus 2: an edit to a star that is gone does not throw', () => {
    const { mapDoc, graph } = setup()
    const stale = mapDoc.nodes.get('a')
    mapDoc.transact(() => mapDoc.nodes.delete('a'))
    expect(() => mapDoc.transact(() => stale.set('label', 'late'))).not.toThrow()
    expect(graph.getNode('a')).toBeNull()
  })

  it('remote cluster colours and blends land without recomputing', () => {
    const { mapDoc, graph } = setup()
    const other = peer(mapDoc)
    other.transact(() => {
      other.getMap('nodes').get('a').set('cluster_color_id', 3)
      other.getMap('nodes').get('a').set('blend', [0.1, 0.2, 0.3])
    })
    expect(graph.getNode('a').cluster_color_id).toBe(3)
    expect(graph.getNode('a').blend).toEqual([0.1, 0.2, 0.3])
    expect(graph.clusterCount).toBe(1)
  })

  it('unknown fields and links reach the graph', () => {
    const { mapDoc, graph } = setup()
    mapDoc.transact(() => {
      mapDoc.nodes.get('a').set('links', ['https://a'])
      mapDoc.nodes.get('a').set('colourway', 'teal')
    })
    expect(graph.getNode('a').links).toEqual(['https://a'])
    expect(graph.getNode('a').colourway).toBe('teal')
  })

  it('reports one remote change per transaction, with what it touched', () => {
    const { mapDoc, onRemoteChange } = setup()
    const other = peer(mapDoc)
    other.getMap('nodes').get('a').set('label', 'x')
    expect(onRemoteChange).toHaveBeenCalledTimes(1)
    expect([...onRemoteChange.mock.calls[0][0].nodeIds]).toEqual(['a'])
    expect([...onRemoteChange.mock.calls[0][0].authors]).toEqual([other.clientID])
  })

  it("someone else's layout during my own Balance puts every star back to what the doc says", () => {
    const { mapDoc, graph, physics } = setup()
    physics.isRunning = true
    physics.isLocalRun = true
    // My run, mid-flight: b has moved and been recoloured, none of it in the doc yet.
    graph.getNode('b').x = 4
    graph.applyLayout({
      positions: new Map([['b', [4, 0, 0]]]),
      colors: new Map([['b', 2]]),
      blends: new Map([['b', null]]),
    })
    const other = peer(mapDoc)
    other.transact(() => {
      other.getMap('nodes').get('a').set('x', 7)
      other.getMap('nodes').get('a').set('cluster_color_id', 1)
    })
    const flight = physics.flights.at(-1)
    expect(flight.get('a')).toEqual([7, 0, 0])
    expect(flight.get('b')).toEqual([0, 0, 0])
    expect(graph.getNode('b').cluster_color_id).toBe(0)
    expect(graph.getNode('a').cluster_color_id).toBe(1)
  })

  it("my own move during someone else's flight joins the flight instead of being carried back", () => {
    const { mapDoc, graph, physics } = setup()
    physics.isRunning = true
    physics.isLocalRun = false
    const before = physics.invalidations
    mapDoc.transact(() => mapDoc.nodes.get('a').set('x', 9))
    expect(graph.getNode('a').x).toBe(9)
    expect(physics.flights.at(-1).get('a')).toEqual([9, 0, 0])
    expect(physics.invalidations).toBe(before)
  })

  it('dispose stops listening', () => {
    const { mapDoc, graph, bridge } = setup()
    bridge.dispose()
    mapDoc.transact(() => mapDoc.nodes.get('a').set('label', 'gone quiet'))
    expect(graph.getNode('a').label).toBe('a')
  })
})
