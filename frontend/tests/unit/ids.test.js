import { describe, it, expect } from 'vitest'
import { randomId, sequentialIds, shortId, nodeName } from '../../src/ids.js'

describe('randomId', () => {
  it('is the prefix, a dash and ten base-36 characters', () => {
    expect(randomId('n', new Set())).toMatch(/^n-[0-9a-z]{10}$/)
    expect(randomId('e', new Set())).toMatch(/^e-[0-9a-z]{10}$/)
  })

  it('never returns an id that is taken', () => {
    let calls = 0
    // First draw is all zeros ("n-0000000000"), second all ones.
    const fill = (bytes) => bytes.fill(calls++ === 0 ? 0 : 1)
    expect(randomId('n', new Set(['n-0000000000']), fill)).toBe('n-1111111111')
  })

  it('a thousand draws do not collide', () => {
    const seen = new Set()
    for (let i = 0; i < 1000; i++) seen.add(randomId('n', seen))
    expect(seen.size).toBe(1000)
  })
})

describe('sequentialIds (tests only)', () => {
  it('counts up per prefix and skips taken ids', () => {
    const ids = sequentialIds()
    expect(ids('n', new Set())).toBe('n1')
    expect(ids('n', new Set(['n2']))).toBe('n3')
    expect(ids('e', new Set())).toBe('e1')
  })
})

describe('shortId and nodeName', () => {
  it('a random id reads as its first four characters', () => {
    expect(shortId('n-k3f9x2q7ab')).toBe('k3f9')
    expect(shortId('e-0000000000')).toBe('0000')
  })

  it('old and odd ids read as they are', () => {
    expect(shortId('n25')).toBe('n25')
    expect(shortId('n-abc')).toBe('n-abc')
    expect(shortId('my-node')).toBe('my-node')
  })

  it('a label wins over the id', () => {
    expect(nodeName({ id: 'n-k3f9x2q7ab', label: 'Sun' })).toBe('Sun')
    expect(nodeName({ id: 'n-k3f9x2q7ab', label: '' })).toBe('k3f9')
    expect(nodeName({ id: 'n7', label: '' })).toBe('n7')
  })
})

describe('sequentialIds after a load', () => {
  it('reset starts again above whatever is taken then', () => {
    const ids = sequentialIds()
    ids('n', new Set())
    ids('n', new Set())
    ids.reset()
    expect(ids('n', new Set())).toBe('n1')
    ids.reset()
    expect(ids('n', new Map([['n7', {}]]))).toBe('n8')
  })
})
