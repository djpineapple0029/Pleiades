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

describe('roomUrl for a guest on a share link', () => {
  it('carries the link, the name and this tab’s guest key', () => {
    const url = new URL(
      roomUrl('m', { protocol: 'https:', host: 'h' }, '/', {
        link: 'T/K',
        name: 'Ari & Sam',
        key: 'k'.repeat(22),
      }),
    )
    expect(url.pathname).toBe('/ws/maps/m')
    expect(url.searchParams.get('link')).toBe('T/K')
    expect(url.searchParams.get('name')).toBe('Ari & Sam')
    expect(url.searchParams.get('guest')).toBe('k'.repeat(22))
  })
})
