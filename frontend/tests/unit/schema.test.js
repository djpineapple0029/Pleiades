// Payload schema version, unknown-field pass-through and the export allowlist
// (V2.md §2.3.1, §2.3.3). The point of all three: a map a newer build wrote
// survives being opened and re-saved here, and nothing private rides along
// into a plaintext HTML export.
import { describe, it, expect } from 'vitest'
import { createGraph, PayloadError } from '../../src/graph.js'
import { createFiles } from '../../src/files.js'
import { CURRENT_SCHEMA, FORMAT, migrate } from '../../src/format/schema.js'
import { exportPayload } from '../../src/format/exportPayload.js'
import { version } from '../../package.json'

function fakeCamera() {
  return {
    position: { toArray: () => [0, 0, 0], fromArray: () => {} },
    rotation: { x: 0, y: 0, z: 0, set: () => {} },
  }
}
const makeFiles = (graph) =>
  createFiles({ graph, view: { sync: () => {} }, camera: fakeCamera(), physics: { reset: () => {} } })

const roundTrip = (value) => JSON.parse(JSON.stringify(value))

describe('migrate', () => {
  it('reads a payload with no envelope as schema 1', () => {
    const p = { nodes: [], edges: [] }
    expect(migrate(p)).toBe(p)
  })

  it('accepts the current schema', () => {
    expect(() => migrate({ format: FORMAT, schema: CURRENT_SCHEMA, nodes: [] })).not.toThrow()
  })

  it('refuses a newer schema, naming it', () => {
    expect(() => migrate({ schema: CURRENT_SCHEMA + 1 })).toThrow(
      `made by a newer AtlasMap (schema ${CURRENT_SCHEMA + 1})`,
    )
  })

  const bad = [
    ['null', null],
    ['an array', []],
    ['a string', 'map'],
    ['another format', { format: 'something-else', nodes: [] }],
    ['schema 0', { schema: 0 }],
    ['a fractional schema', { schema: 1.5 }],
    ['a string schema', { schema: '1' }],
  ]
  for (const [name, p] of bad) {
    it(`refuses ${name}`, () => expect(() => migrate(p)).toThrow(PayloadError))
  }
})

describe('graph.load: schema check comes first', () => {
  it('a newer-schema file leaves the open map untouched', () => {
    const g = createGraph()
    g.load({ nodes: [{ id: 'keep', x: 5, y: 0, z: 0 }] })
    const revision = g.revision
    expect(() => g.load({ schema: CURRENT_SCHEMA + 1, nodes: [] })).toThrow(PayloadError)
    expect(g.nodes.size).toBe(1)
    expect(g.getNode('keep').x).toBe(5)
    expect(g.revision).toBe(revision)
  })
})

describe('graph: unknown node and edge fields pass through', () => {
  const file = {
    nodes: [
      { id: 'n1', x: 1, y: 2, z: 3, label: 'a', pinned: true, tags: ['x', 'y'], vx: 9, index: 0 },
      { id: 'n2', x: 0, y: 0, z: 0, colour_override: '#ff0000' },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', strength: 0.5, kind: 'cites' }],
  }
  const g = createGraph()
  g.load(roundTrip(file))
  const out = roundTrip(g.toPayload())
  const n1 = out.nodes.find((n) => n.id === 'n1')
  const n2 = out.nodes.find((n) => n.id === 'n2')

  it('keeps unknown node fields through load → toPayload → JSON', () => {
    expect(n1.pinned).toBe(true)
    expect(n1.tags).toEqual(['x', 'y'])
    expect(n2.colour_override).toBe('#ff0000')
  })

  it('keeps unknown edge fields', () => {
    expect(out.edges[0].strength).toBe(0.5)
    expect(out.edges[0].kind).toBe('cites')
  })

  it("drops d3-force's stamps", () => {
    expect('vx' in n1).toBe(false)
    expect('index' in n1).toBe(false)
  })

  it('a known field always wins over a same-named raw value', () => {
    const g2 = createGraph()
    g2.load({ nodes: [{ id: 'n', x: 0, y: 0, z: 0, label: 42, is_core: 'yes' }] })
    const n = g2.toPayload().nodes[0]
    expect(n.label).toBe('')
    expect(n.is_core).toBe(false)
  })

  it('survives delete + undo (restoreNode)', () => {
    const g3 = createGraph()
    g3.load(roundTrip(file))
    const snapshot = g3.removeNode('n1')
    g3.restoreNode(snapshot)
    const back = g3.toPayload()
    expect(back.nodes.find((n) => n.id === 'n1').tags).toEqual(['x', 'y'])
    expect(back.edges[0].kind).toBe('cites')
  })
})

describe('files: envelope and top-level pass-through', () => {
  it('stamps format, schema and app on every save payload', () => {
    const payload = makeFiles(createGraph()).toPayload()
    expect(payload.format).toBe(FORMAT)
    expect(payload.schema).toBe(CURRENT_SCHEMA)
    expect(payload.app).toBe(version)
  })

  it('writes back top-level keys it does not own, but never their envelope', () => {
    const files = makeFiles(createGraph())
    files.applyPayload({
      format: FORMAT,
      schema: 1,
      app: '0.0.1-old',
      nodes: [{ id: 'n1', x: 0, y: 0, z: 0 }],
      edges: [],
      views: [{ name: 'home' }],
    })
    const out = roundTrip(files.toPayload())
    expect(out.views).toEqual([{ name: 'home' }])
    expect(out.app).toBe(version)
    expect(out.nodes).toHaveLength(1)
  })

  it('New map (clearCredentials) forgets the last file’s top-level extras', () => {
    const files = makeFiles(createGraph())
    files.applyPayload({ nodes: [], edges: [], views: [1] })
    files.clearCredentials()
    expect('views' in files.toPayload()).toBe(false)
  })

  it('a refused newer file leaves the previous extras alone', () => {
    const files = makeFiles(createGraph())
    files.applyPayload({ nodes: [], edges: [], views: [1] })
    expect(() => files.applyPayload({ schema: CURRENT_SCHEMA + 1, other: 2 })).toThrow(PayloadError)
    const out = files.toPayload()
    expect(out.views).toEqual([1])
    expect('other' in out).toBe(false)
  })
})

describe('HTML export allowlist', () => {
  const g = createGraph()
  g.load({
    views: 'top-level secret',
    nodes: [
      {
        id: 'n1',
        x: 1,
        y: 2,
        z: 3,
        label: 'Public',
        notes: 'private notes',
        links: ['https://private.invalid'],
        secret: 'passed-through',
        is_core: true,
        cluster_color_id: 2,
        blend: [0.1, 0.2, 0.3],
      },
      { id: 'n2', x: 0, y: 0, z: 0 },
    ],
    edges: [{ id: 'e1', from: 'n1', to: 'n2', directed: true, label: 'l', strength: 0.9 }],
  })
  const camera = { position: [0, 0, 1], rotation: [0, 0, 0] }
  const out = exportPayload(g.toPayload(), camera)
  const text = JSON.stringify(out)

  it('carries nothing private: notes, links or passed-through fields', () => {
    for (const leak of [
      'private notes',
      'private.invalid',
      'passed-through',
      'top-level secret',
      'strength',
    ]) {
      expect(text).not.toContain(leak)
    }
  })

  it('keeps exactly what the viewer draws', () => {
    expect(Object.keys(out.nodes[0]).sort()).toEqual(
      ['blend', 'cluster_color_id', 'id', 'is_core', 'label', 'x', 'y', 'z'].sort(),
    )
    expect(Object.keys(out.edges[0]).sort()).toEqual(['directed', 'from', 'id', 'label', 'to'])
    expect(out.camera).toEqual(camera)
  })

  it('is stamped, and loads back through the same migrate', () => {
    expect(out.schema).toBe(CURRENT_SCHEMA)
    const viewer = createGraph()
    viewer.load(roundTrip(out))
    expect(viewer.nodes.size).toBe(2)
  })
})
