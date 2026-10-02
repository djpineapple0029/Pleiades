import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { createGraph } from '../../src/graph.js'
import { sequentialIds } from '../../src/ids.js'
import { createMapDoc } from '../../src/mapDoc.js'
import { createDocBridge } from '../../src/docBridge.js'
import { createUndo } from '../../src/undo.js'
import { nodeToY } from '../../src/format/ydoc.js'

const stub = () => ({ syncNodes() {}, syncEdges() {}, updateEdgePositions() {}, invalidate() {}, flyTo() {} })
const node = (id) => ({ id, label: id, notes: '', x: 0, y: 0, z: 0 })

function setup() {
  const mapDoc = createMapDoc()
  const graph = createGraph({ newId: sequentialIds() })
  const payload = { nodes: [node('a')], edges: [] }
  mapDoc.replace(payload)
  graph.load(payload)
  createDocBridge({ mapDoc, graph, view: stub(), physics: stub() })
  return { mapDoc, graph, undo: createUndo({ mapDoc, graph }) }
}

describe('undo', () => {
  it('each step is one undo, labelled', () => {
    const { mapDoc, graph, undo } = setup()
    undo.step('new node', () => mapDoc.nodes.set('b', nodeToY(node('b'))))
    undo.step('edit node a', () => mapDoc.nodes.get('a').set('label', 'A'))
    expect(undo.size).toBe(2)
    expect(undo.undo()).toBe('edit node a')
    expect(graph.getNode('a').label).toBe('a')
    expect(undo.undo()).toBe('new node')
    expect(graph.getNode('b')).toBeNull()
    expect(undo.redo()).toBe('new node')
    expect(graph.getNode('b')).not.toBeNull()
  })

  it('undo, redo, undo again keeps the label and the token', () => {
    const { mapDoc, graph, undo } = setup()
    const saved = graph.contentRevision
    undo.step('edit node a', () => mapDoc.nodes.get('a').set('label', 'A'))
    const edited = graph.contentRevision
    expect(undo.undo()).toBe('edit node a')
    expect(graph.contentRevision).toBe(saved)
    expect(undo.redo()).toBe('edit node a')
    expect(graph.contentRevision).toBe(edited)
    expect(graph.getNode('a').label).toBe('A')
    expect(undo.undo()).toBe('edit node a')
    expect(graph.contentRevision).toBe(saved)
    expect(undo.redo()).toBe('edit node a')
    expect(graph.contentRevision).toBe(edited)
  })

  it('undoing back to the saved state reads as clean (token restored)', () => {
    const { mapDoc, graph, undo } = setup()
    const saved = graph.contentRevision
    undo.step('edit node a', () => mapDoc.nodes.get('a').set('label', 'A'))
    expect(graph.contentRevision).not.toBe(saved)
    undo.undo()
    expect(graph.contentRevision).toBe(saved)
  })

  it('only my edits: a remote edit is never undone by me', () => {
    const { mapDoc, graph, undo } = setup()
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(mapDoc.doc))
    other.on('update', (u) => Y.applyUpdate(mapDoc.doc, u, 'remote'))
    undo.step('edit node a', () => mapDoc.nodes.get('a').set('label', 'mine'))
    other.getMap('nodes').set('z', nodeToY(node('z')))
    undo.undo()
    expect(graph.getNode('a').label).toBe('a')
    expect(graph.getNode('z')).not.toBeNull()
  })

  it('a group merges typing into one undo step', () => {
    const { mapDoc, graph, undo } = setup()
    const g = undo.group('edit node a')
    const text = mapDoc.nodes.get('a').get('notes')
    for (const ch of 'hello') mapDoc.transact(() => text.insert(text.length, ch))
    g.end()
    expect(graph.getNode('a').notes).toBe('hello')
    expect(undo.size).toBe(1)
    expect(undo.undo()).toBe('edit node a')
    expect(graph.getNode('a').notes).toBe('')
  })

  it('discarding a group takes back only my typing in it, and leaves no undo or redo', () => {
    const { mapDoc, graph, undo } = setup()
    const text = mapDoc.nodes.get('a').get('notes')
    mapDoc.transact(() => text.insert(0, 'kept'))
    undo.clear()
    const g = undo.group('edit node a')
    for (const ch of ' gone') mapDoc.transact(() => text.insert(text.length, ch))
    // Someone else types meanwhile: theirs stays.
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(mapDoc.doc))
    other.getMap('nodes').get('a').get('notes').insert(0, '>')
    Y.applyUpdate(mapDoc.doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(mapDoc.doc)), 'room')
    g.discard()
    expect(graph.getNode('a').notes).toBe('>kept')
    expect(undo.canUndo).toBe(false)
    expect(undo.canRedo).toBe(false)
  })

  it('discarding a group I never typed in changes nothing', () => {
    const { undo } = setup()
    undo.step('label', () => {})
    const before = undo.size
    undo.group('edit node a').discard()
    expect(undo.size).toBe(before)
  })

  it('a step after a group is a step of its own', () => {
    const { mapDoc, undo } = setup()
    const g = undo.group('edit node a')
    mapDoc.transact(() => mapDoc.nodes.get('a').get('notes').insert(0, 'x'))
    g.end()
    undo.step('move a', () => mapDoc.nodes.get('a').set('x', 3))
    expect(undo.size).toBe(2)
    expect(undo.undo()).toBe('move a')
  })

  it('a load is never undone', () => {
    const { mapDoc, undo } = setup()
    mapDoc.replace({ nodes: [node('q')], edges: [] })
    expect(undo.canUndo).toBe(false)
    expect(undo.undo()).toBeNull()
  })

  it('Review Focus 2: undoing my edit to a star someone deleted is harmless', () => {
    const { mapDoc, graph, undo } = setup()
    undo.step('edit node a', () => mapDoc.nodes.get('a').set('label', 'mine'))
    mapDoc.transact(() => mapDoc.nodes.delete('a'), 'remote')
    expect(() => undo.undo()).not.toThrow()
    expect(graph.getNode('a')).toBeNull()
  })

  it('clear empties both stacks', () => {
    const { mapDoc, undo } = setup()
    undo.step('edit node a', () => mapDoc.nodes.get('a').set('label', 'A'))
    undo.undo()
    undo.clear()
    expect(undo.canUndo).toBe(false)
    expect(undo.canRedo).toBe(false)
  })
})

describe('undo.step at a mark', () => {
  it('files the step where the stack stood at the mark, under later steps', () => {
    const { mapDoc, undo } = setup()
    const mark = undo.mark()
    undo.step('edit node a', () => mapDoc.nodes.get('a').set('label', 'A'))
    undo.step('balance', () => mapDoc.nodes.get('a').set('x', 9), { at: mark })
    expect(undo.undo()).toBe('edit node a')
    expect(undo.undo()).toBe('balance')
    expect(undo.redo()).toBe('balance')
    expect(undo.redo()).toBe('edit node a')
  })

  it('still lands right when the limit drops entries in between', () => {
    const mapDoc = createMapDoc()
    const graph = createGraph({ newId: sequentialIds() })
    mapDoc.replace({ nodes: [node('a')], edges: [] })
    graph.load({ nodes: [node('a')], edges: [] })
    createDocBridge({ mapDoc, graph, view: stub(), physics: stub() })
    const undo = createUndo({ mapDoc, graph, limit: 3 })
    undo.step('one', () => mapDoc.nodes.get('a').set('label', '1'))
    const mark = undo.mark() // one entry below it
    for (const n of ['two', 'three', 'four']) undo.step(n, () => mapDoc.nodes.get('a').set('label', n))
    undo.step('balance', () => mapDoc.nodes.get('a').set('x', 9), { at: mark })
    // 'one' fell off; balance sits under two, three and four, which also lose one to the limit.
    const labels = []
    for (let label; (label = undo.undo());) labels.push(label)
    expect(labels).toEqual(['four', 'three', 'balance'])
  })
})
