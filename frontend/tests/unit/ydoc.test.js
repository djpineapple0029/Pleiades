import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import * as Y from 'yjs'
import { payloadToDoc, docToPayload, keptEdges } from '../../src/format/ydoc.js'

const FIXTURES = new URL('../fixtures/', import.meta.url)
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const normalise = (p) => ({ ...p, nodes: [...p.nodes].sort(byId), edges: [...p.edges].sort(byId) })

describe('payload ↔ Y.Doc', () => {
  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith('.json') && f !== 'ydoc-vectors.json')) {
    it(`round-trips golden payload ${name} unchanged`, () => {
      const payload = JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'))
      const back = docToPayload(payloadToDoc(payload))
      // migrate() leaves a schema-1 payload as it is, so nothing is added.
      expect(normalise(back)).toEqual(normalise(payload))
    })
  }

  it('notes are shared text, everything else plain values', () => {
    const doc = payloadToDoc({
      nodes: [{ id: 'n1', label: 'A', notes: 'hello', x: 1, y: 2, z: 3 }],
      edges: [],
    })
    const node = doc.getMap('nodes').get('n1')
    expect(node.get('notes')).toBeInstanceOf(Y.Text)
    expect(node.get('notes').toString()).toBe('hello')
    expect(node.get('label')).toBe('A')
  })

  it('unknown node, edge and top-level fields ride along', () => {
    const payload = {
      future: { a: 1 },
      nodes: [
        { id: 'n1', x: 0, y: 0, z: 0, colourway: 'teal' },
        { id: 'n2', x: 1, y: 0, z: 0 },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', weight: 3 }],
    }
    const back = docToPayload(payloadToDoc(payload))
    expect(back.future).toEqual({ a: 1 })
    expect(back.nodes.find((n) => n.id === 'n1').colourway).toBe('teal')
    expect(back.edges[0].weight).toBe(3)
  })

  it('a synced copy of the doc materialises the same payload', () => {
    const a = payloadToDoc({ nodes: [{ id: 'n1', x: 0, y: 0, z: 0, notes: 'x' }], edges: [] })
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(docToPayload(b)).toEqual(docToPayload(a))
  })

  it('a payload that is not a map is refused, as on Open', () => {
    expect(() => payloadToDoc({ format: 'something else', nodes: [], edges: [] })).toThrow()
  })
})

describe('keptEdges', () => {
  const ids = new Set(['a', 'b', 'c'])

  it('drops an edge whose end is gone', () => {
    const kept = keptEdges(ids, [{ id: 'e1', from: 'a', to: 'zz' }])
    expect(kept.size).toBe(0)
  })

  it('drops self-loops', () => {
    expect(keptEdges(ids, [{ id: 'e1', from: 'a', to: 'a' }]).size).toBe(0)
  })

  it('of two links between the same pair, either direction, the smaller id wins', () => {
    const kept = keptEdges(ids, [
      { id: 'e-zzz', from: 'a', to: 'b' },
      { id: 'e-aaa', from: 'b', to: 'a' },
      { id: 'e-mmm', from: 'b', to: 'c' },
    ])
    expect([...kept.keys()].sort()).toEqual(['e-aaa', 'e-mmm'])
  })
})
