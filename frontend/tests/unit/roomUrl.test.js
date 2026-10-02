import { describe, it, expect } from 'vitest'
import { roomUrl } from '../../src/api.js'

describe('roomUrl', () => {
  it('is a WebSocket URL on this host, under the app base', () => {
    expect(roomUrl('abcdefghijklmnop', { protocol: 'http:', host: 'localhost:5173' }, '/')).toBe(
      'ws://localhost:5173/ws/maps/abcdefghijklmnop',
    )
  })

  it('is wss behind https and keeps a base path like /pleiades/', () => {
    expect(roomUrl('m', { protocol: 'https:', host: 'example.ts.net' }, '/pleiades/')).toBe(
      'wss://example.ts.net/pleiades/ws/maps/m',
    )
  })
})
