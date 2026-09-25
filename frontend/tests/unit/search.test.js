// search.js: star-name ranking for the / search.
import { describe, it, expect } from 'vitest'
import { fold, rankNodes } from '../../src/search.js'

const node = (id, label, extra = {}) => ({ id, label, ...extra })
const ids = (hits) => hits.map((h) => h.id)
const noLinks = () => 0

describe('fold', () => {
  it('drops case and accents', () => {
    expect(fold('Café Ölung')).toBe('cafe olung')
  })
})

describe('rankNodes', () => {
  it('matches nothing for an empty or blank query', () => {
    const nodes = [node('a', 'Alpha')]
    expect(rankNodes(nodes, '', noLinks)).toEqual([])
    expect(rankNodes(nodes, '   ', noLinks)).toEqual([])
  })

  it('never matches a nameless node', () => {
    expect(rankNodes([node('n1', ''), node('n2', undefined)], 'n', noLinks)).toEqual([])
  })

  it('ranks prefix, then word start, then substring', () => {
    const nodes = [node('sub', 'Rebudget'), node('word', 'Q3 budget'), node('pre', 'Budget')]
    expect(ids(rankNodes(nodes, 'budg', noLinks))).toEqual(['pre', 'word', 'sub'])
  })

  it('finds a word start past an earlier mid-word occurrence', () => {
    // "art" first appears inside "Start", then again at the start of "art".
    const hits = rankNodes([node('a', 'Start art'), node('b', 'Smartest')], 'art', noLinks)
    expect(ids(hits)).toEqual(['a', 'b'])
  })

  it('treats punctuation and digits sensibly as word boundaries', () => {
    expect(ids(rankNodes([node('a', 'x-ray'), node('b', 'Xray')], 'ray', noLinks))).toEqual(['a', 'b'])
    // A digit is part of a word, so "2b" is not a word start of "b".
    expect(ids(rankNodes([node('a', 'plan 2b'), node('b', 'plan b')], 'b', noLinks))).toEqual(['b', 'a'])
  })

  it('ignores case and accents in both directions', () => {
    const nodes = [node('a', 'Café'), node('b', 'CAFE')]
    expect(ids(rankNodes(nodes, 'cafe', noLinks)).sort()).toEqual(['a', 'b'])
    expect(ids(rankNodes(nodes, 'CAFÉ', noLinks)).sort()).toEqual(['a', 'b'])
  })

  it('breaks ties by core, then links, then shorter name, then alphabet', () => {
    const degree = { a: 1, b: 5, c: 1, d: 1, e: 1 }
    const nodes = [
      node('a', 'Plan alpha'),
      node('b', 'Plan beta'),
      node('c', 'Plan gamma', { is_core: true }),
      node('d', 'Plan d'),
      node('e', 'Plan c'),
    ]
    expect(ids(rankNodes(nodes, 'plan', (id) => degree[id]))).toEqual(['c', 'b', 'e', 'd', 'a'])
  })

  it('returns label, core flag and link count for the rows', () => {
    const [hit] = rankNodes([node('a', 'Alpha', { is_core: true })], 'al', () => 3)
    expect(hit).toEqual({ id: 'a', label: 'Alpha', isCore: true, degree: 3, mark: [0, 2] })
  })

  it('marks where the match sits in the name', () => {
    expect(rankNodes([node('a', 'Q3 Budget')], 'bud', noLinks)[0].mark).toEqual([3, 6])
    expect(rankNodes([node('a', 'Start art')], 'art', noLinks)[0].mark).toEqual([6, 9])
    // Precomposed é folds to one char: offsets still line up.
    expect(rankNodes([node('a', 'Le café')], 'cafe', noLinks)[0].mark).toEqual([3, 7])
    // Decomposed e + combining accent: folding shortens the name, so no mark.
    expect(rankNodes([node('a', 'Le cafe\u0301')], 'cafe', noLinks)[0].mark).toBe(null)
  })

  it('keeps up with a big map', () => {
    const nodes = Array.from({ length: 5000 }, (_, i) => node(`n${i}`, `Topic ${i} note`))
    const started = performance.now()
    const hits = rankNodes(nodes, 'no', noLinks)
    expect(hits.length).toBe(5000)
    // Generous: catches a complexity blowup, not a millisecond budget.
    expect(performance.now() - started).toBeLessThan(500)
  })
})
