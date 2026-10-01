// Upload and download in the account shell (src/shell/mapFiles.js), and the
// Account page's wording (src/shell/accountPage.js). Golden files are only
// read here, never written.
import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { readContainer } from '../../src/format/container.js'
import {
  fileName,
  mapFileBlob,
  nameFromFile,
  probe,
  readMapFile,
  readsHere,
} from '../../src/shell/mapFiles.js'
import { attachmentName, sessionsText } from '../../src/shell/accountPage.js'

const FIXTURES = new URL('../fixtures/', import.meta.url)
const bytesOf = (name) => new Uint8Array(readFileSync(new URL(`${name}.atlasmap`, FIXTURES)))
const jsonOf = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'))
const KNOWN = 'correct horse ✦ battery'
const PAYLOAD = { format: 'atlasmap', schema: 1, nodes: [{ id: 'a', label: 'Star' }], edges: [], extra: 1 }

describe('names', () => {
  it('a file name as a map name', () => {
    expect(nameFromFile('Trip.plm')).toBe('Trip')
    expect(nameFromFile('Old one.atlasmap')).toBe('Old one')
    expect(nameFromFile('LOUD.PLM')).toBe('LOUD')
    expect(nameFromFile('.plm')).toBe('')
    expect(nameFromFile('notes.txt')).toBe('notes.txt')
  })

  it('a map name as a file name', () => {
    expect(fileName('Trip')).toBe('Trip.plm')
    expect(fileName('a/b: c?')).toBe('a-b c.plm')
    expect(fileName('  ..hidden.  ')).toBe('hidden.plm')
    expect(fileName('')).toBe('map.plm')
    expect(fileName('***')).toBe('map.plm')
    expect(fileName('x'.repeat(300))).toBe(`${'x'.repeat(120)}.plm`)
  })
})

describe('reading an upload', () => {
  it('probes the header without a password', () => {
    expect(probe(bytesOf('v2-no-password'))).toEqual({ needsPassword: false })
    expect(probe(bytesOf('v2-encrypted'))).toEqual({ needsPassword: true })
    expect(probe(bytesOf('v1-known-password'))).toEqual({ needsPassword: true })
    expect(probe(new TextEncoder().encode('hello, not a map'))).toBeNull()
  })

  it('reads here unless it needs WebCrypto the page lacks', () => {
    expect(readsHere({ needsPassword: false }, false)).toBe(true)
    expect(readsHere({ needsPassword: true }, true)).toBe(true)
    expect(readsHere({ needsPassword: true }, false)).toBe(false)
  })

  it.each([
    ['v1-known-password', KNOWN],
    ['v2-encrypted', KNOWN],
    ['v2-no-password', ''],
  ])('reads golden %s', async (name, password) => {
    expect(await readMapFile(bytesOf(name), password)).toEqual({ ok: true, payload: jsonOf(name) })
  })

  it('says when the password is wrong', async () => {
    const result = await readMapFile(bytesOf('v2-encrypted'), 'nope')
    expect(result.ok).toBe(false)
    expect(result.wrongPassword).toBe(true)
  })

  it("refuses a file the app couldn't open", async () => {
    const newer = await mapFileBlob({ ...PAYLOAD, schema: 99 }, '', { crypto: false })
    const result = await readMapFile(new Uint8Array(await newer.blob.arrayBuffer()), '')
    expect(result).toMatchObject({ ok: false })
    expect(result.error).toMatch(/newer/)
    expect(result.wrongPassword).toBeUndefined()
  })
})

describe('writing a download', () => {
  const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer())

  it('with no password, even without WebCrypto, and it reads back', async () => {
    const fetchImpl = vi.fn()
    const result = await mapFileBlob(PAYLOAD, '', { crypto: false, fetchImpl })
    expect(result.ok).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(await readContainer(await bytes(result.blob), '')).toEqual(PAYLOAD)
  })

  it('with a password where WebCrypto exists', async () => {
    const result = await mapFileBlob(PAYLOAD, 'pw', { crypto: true })
    const written = await bytes(result.blob)
    expect(probe(written)).toEqual({ needsPassword: true })
    expect(await readContainer(written, 'pw')).toEqual(PAYLOAD)
  })

  it('with a password and no WebCrypto, through /api/save', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])))
    const result = await mapFileBlob(PAYLOAD, 'pw', { base: '/pleiades/', crypto: false, fetchImpl })
    expect(result.ok).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/pleiades/api/save')
    expect(JSON.parse(init.body)).toEqual({ password: 'pw', payload: PAYLOAD })
  })

  it("says what the server said when it can't", async () => {
    const fetchImpl = async () => Response.json({ error: 'Too big.' }, { status: 413 })
    expect(await mapFileBlob(PAYLOAD, 'pw', { crypto: false, fetchImpl })).toEqual({
      ok: false,
      error: 'Too big.',
    })
    const down = async () => {
      throw new TypeError('offline')
    }
    expect((await mapFileBlob(PAYLOAD, 'pw', { crypto: false, fetchImpl: down })).ok).toBe(false)
  })
})

describe('account page wording', () => {
  it('other sessions', () => {
    expect(sessionsText(0)).toBe("You aren't signed in anywhere else.")
    expect(sessionsText(1)).toBe("You're also signed in on 1 other browser or device.")
    expect(sessionsText(3)).toBe("You're also signed in on 3 other browsers or devices.")
  })

  it("the zip's name", () => {
    expect(attachmentName('attachment; filename=pleiades-alice-2026-09-30.zip', 'x.zip')).toBe(
      'pleiades-alice-2026-09-30.zip',
    )
    expect(attachmentName('attachment; filename="a b.zip"', 'x.zip')).toBe('a b.zip')
    expect(attachmentName("attachment; filename*=UTF-8''caf%C3%A9.zip", 'x.zip')).toBe('café.zip')
    expect(attachmentName(null, 'x.zip')).toBe('x.zip')
  })
})
