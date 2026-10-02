// The account shell's list wording (src/shell/format.js).
import { describe, it, expect } from 'vitest'
import {
  dateTime,
  formatSize,
  mapSummary,
  relativeTime,
  sameMaps,
  versionSummary,
  whoIsIn,
} from '../../src/shell/format.js'

describe('shell format', () => {
  const now = 1_800_000_000

  it('relative times', () => {
    expect(relativeTime(now - 5, now)).toBe('just now')
    expect(relativeTime(now + 30, now), 'a clock a little ahead').toBe('just now')
    expect(relativeTime(now - 5 * 60, now)).toBe('5 min ago')
    expect(relativeTime(now - 3600, now)).toBe('1 hour ago')
    expect(relativeTime(now - 3 * 3600, now)).toBe('3 hours ago')
    expect(relativeTime(now - 30 * 3600, now)).toBe('yesterday')
    expect(relativeTime(now - 3 * 86400, now)).toBe('3 days ago')
    expect(relativeTime(now - 30 * 86400, now)).toMatch(/\d/)
  })

  it('sizes', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(3277)).toBe('3.2 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('summary', () => {
    expect(mapSummary({ node_count: 1, updated_at: now, size_bytes: 20 }, now)).toBe(
      '1 star · just now · 20 B',
    )
    expect(mapSummary({ node_count: 12, updated_at: now - 120, size_bytes: 2048 }, now)).toBe(
      '12 stars · 2 min ago · 2.0 KB',
    )
  })

  it('versions', () => {
    const version = { node_count: 1, size_bytes: 2048, reason: 'rolling' }
    expect(versionSummary(version)).toBe('1 star · 2.0 KB')
    expect(versionSummary({ ...version, reason: 'before-restore' })).toBe(
      '1 star · 2.0 KB · kept before a restore',
    )
    expect(
      versionSummary({ ...version, reason: 'from-a-later-server' }),
      'an unknown reason says nothing',
    ).toBe('1 star · 2.0 KB')
    expect(dateTime(now)).toMatch(/\d/)
  })
})

describe('asking before a change that reaches other people', () => {
  it('restore: plain when nobody is in, for everyone when someone is', async () => {
    const { restoreQuestion } = await import('../../src/shell/format.js')
    expect(restoreQuestion(0)).toEqual({
      text: 'Make this the current version? The current one is kept here first.',
      yes: 'Restore',
    })
    expect(restoreQuestion(1)).toEqual({
      text: '1 person is in this map. Restore this version for everyone? What’s there now is kept in History.',
      yes: 'Restore for everyone',
    })
    expect(restoreQuestion(3).text).toMatch(/^3 people are in this map\./)
  })

  it('delete: says who it reaches', async () => {
    const { deleteQuestion } = await import('../../src/shell/format.js')
    expect(deleteQuestion(0, 0)).toEqual({ text: "Delete it for good? This can't be undone.", yes: 'Delete' })
    expect(deleteQuestion(1, 0)).toEqual({
      text: 'This map is shared with 1 person. Deleting it removes it for everyone.',
      yes: 'Delete for everyone',
    })
    expect(deleteQuestion(2, 1).text).toBe(
      'This map is shared with 2 people, and 1 is in it now. Deleting it removes it for everyone.',
    )
    expect(deleteQuestion(2, 3).text).toBe(
      'This map is shared with 2 people, and 3 are in it now. Deleting it removes it for everyone.',
    )
    expect(deleteQuestion(0, 2).text).toBe(
      '2 people are in this map now. Deleting it removes it for everyone.',
    )
  })
})

describe("who's in a map, on its row (MOONSHOT decision 17)", () => {
  const person = (name, colour = '#fff', guest = false) => ({ name, colour, guest })

  it('nobody: nothing to show', () => {
    expect(whoIsIn([])).toBeNull()
    expect(whoIsIn(undefined)).toBeNull()
  })

  it('up to three coloured initials, every name in the title', () => {
    expect(whoIsIn([person('ari', '#f00'), person('Sam', '#0f0')])).toEqual({
      initials: [
        { initial: 'A', colour: '#f00' },
        { initial: 'S', colour: '#0f0' },
      ],
      more: '',
      title: 'In this map now: ari and Sam',
    })
  })

  it('past three, "+N"', () => {
    const shown = whoIsIn(['a', 'b', 'c', 'd', 'e'].map((n) => person(n)))
    expect(shown.initials).toHaveLength(3)
    expect(shown.more).toBe('+2')
    expect(shown.title).toBe('In this map now: a, b, c, d and e')
  })

  it('a guest is marked as one; an emoji name keeps its whole first character', () => {
    const shown = whoIsIn([person('🌍 earth'), person('<b>x</b>', '#fff', true)])
    expect(shown.initials.map((i) => i.initial)).toEqual(['🌍', '<'])
    expect(shown.title).toBe('In this map now: 🌍 earth and <b>x</b> (guest)')
  })
})

describe('sameMaps: when the 15 s poll needs to rebuild the list (review fix)', () => {
  it('the same maps in a new order (someone saved one) is no change', () => {
    expect(sameMaps(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true)
  })

  it('a map that came or went is', () => {
    expect(sameMaps(['a', 'b'], ['a', 'b', 'c'])).toBe(false)
    expect(sameMaps(['a', 'b'], ['a'])).toBe(false)
    expect(sameMaps(['a', 'b'], ['a', 'x'])).toBe(false)
  })
})
