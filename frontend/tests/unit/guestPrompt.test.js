import { describe, it, expect } from 'vitest'
import { linkFromLocation, newGuestKey, guestNameProblem, rememberLink } from '../../src/room/guestPrompt.js'

describe('linkFromLocation', () => {
  it('reads the map from the query and the token from the fragment', () => {
    expect(linkFromLocation({ search: '?map=abc', hash: '#link=TOK-_9' })).toEqual({
      mapId: 'abc',
      token: 'TOK-_9',
    })
  })

  it('is null without a map or without a link', () => {
    expect(linkFromLocation({ search: '', hash: '#link=TOK' })).toBeNull()
    expect(linkFromLocation({ search: '?map=abc', hash: '' })).toBeNull()
    expect(linkFromLocation({ search: '?map=abc', hash: '#share=abc' })).toBeNull()
  })
})

describe('rememberLink', () => {
  function fakeStorage() {
    const values = new Map()
    return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)) }
  }

  it('moves the token out of the address into this tab, and finds it again after a reload', () => {
    const storage = fakeStorage()
    const replaced = []
    const where = { search: '?map=abc', hash: '#link=TOK', pathname: '/pleiades/' }
    const history = { replaceState: (_s, _t, url) => replaced.push(url) }
    expect(rememberLink('abc', { where, storage, history })).toBe('TOK')
    expect(replaced).toEqual(['/pleiades/?map=abc'])
    expect(rememberLink('abc', { where: { search: '?map=abc', hash: '' }, storage, history })).toBe('TOK')
    expect(rememberLink('other', { where: { search: '?map=other', hash: '' }, storage, history })).toBeNull()
  })

  it('is null, not a throw, when storage is blocked', () => {
    const storage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const where = { search: '?map=abc', hash: '', pathname: '/' }
    expect(rememberLink('abc', { where, storage, history: { replaceState() {} } })).toBeNull()
  })
})

describe('newGuestKey', () => {
  it('is 22 url-safe characters', () => {
    expect(newGuestKey()).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('comes from the random bytes it is given', () => {
    expect(newGuestKey((bytes) => bytes.fill(0))).toBe('A'.repeat(22))
    expect(newGuestKey((bytes) => bytes.fill(255))).toBe('_'.repeat(21) + 'w')
  })
})

describe('guestNameProblem', () => {
  it('asks for 1–24 characters', () => {
    expect(guestNameProblem('Ari')).toBeNull()
    expect(guestNameProblem('   ')).toMatch(/name/)
    expect(guestNameProblem('x'.repeat(25))).toMatch(/24/)
  })
})
