// Golden files, browser side (V2.md §2.7.2). The same fixtures as
// server/tests/test_golden.py, decrypted with format/container.js under Node's
// WebCrypto and then loaded through graph.load. Written once, never
// regenerated: a failure here means the format broke. See
// tests/fixtures/README.md for where each file came from.
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { readContainer, ContainerPasswordError } from '../../src/format/container.js'
import { createGraph } from '../../src/graph.js'

const FIXTURES = new URL('../fixtures/', import.meta.url)
const KNOWN = 'correct horse ✦ battery'
const GOLDEN = [
  ['twelve', 'open sesame', 1],
  ['v1-known-password', KNOWN, 1],
  ['v2-encrypted', KNOWN, 2],
  ['v2-no-password', '', 2],
]

// readFileSync throws on a missing fixture, so the test fails, never skips.
const bytesOf = (name) => new Uint8Array(readFileSync(new URL(`${name}.atlasmap`, FIXTURES)))
const jsonOf = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'))

describe.each(GOLDEN)('golden %s', (name, password, version) => {
  it(`is a v${version} container and decrypts to its committed JSON`, async () => {
    const bytes = bytesOf(name)
    expect(bytes[4]).toBe(version)
    expect(await readContainer(bytes, password)).toEqual(jsonOf(name))
  })

  if (password) {
    it('refuses a wrong password', async () => {
      await expect(readContainer(bytesOf(name), `${password}x`)).rejects.toBeInstanceOf(
        ContainerPasswordError,
      )
    })
  }

  it('loads through graph.load and loses nothing on the way back out', () => {
    const file = jsonOf(name)
    const graph = createGraph()
    graph.load(file)
    const out = graph.toPayload()
    expect(out.nodes).toHaveLength(file.nodes.length)
    expect(out.edges).toHaveLength(file.edges.length)
    // Every field the file held comes back unchanged. Load may *add*
    // defaults (an old file has no `blend`), never drop or alter.
    for (const node of file.nodes) expect(out.nodes.find((n) => n.id === node.id)).toMatchObject(node)
    for (const edge of file.edges) expect(out.edges.find((e) => e.id === edge.id)).toMatchObject(edge)
    // cluster_color_id is authoritative on load, never recomputed.
    expect(graph.clusterCount).toBe(new Set(file.nodes.map((n) => n.cluster_color_id).filter(Boolean)).size)
  })
})
