// The account shell's list wording (src/shell/format.js).
import { describe, it, expect } from 'vitest'
import { formatSize, mapSummary, relativeTime } from '../../src/shell/format.js'

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
})
