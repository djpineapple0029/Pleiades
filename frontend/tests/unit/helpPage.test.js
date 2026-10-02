// The Help page's Shared maps section (Task 3.8): everything the plan says
// it must tell people, in words they'd read.
import { describe, it, expect } from 'vitest'
import { MULTIPLAYER_HELP } from '../../src/shell/helpPage.js'

const text = MULTIPLAYER_HELP.map((section) => [section.title, ...section.lines].join('\n')).join('\n\n')

describe('Help: shared maps', () => {
  it.each([
    ['the three roles', /owner/i, /editor/i, /viewer/i],
    ['each permission', /balance/i, /export|download/i, /invite|shar/i, /history/i, /chat/i],
    ['Balance and Export only hide a button', /hide the button/i, /anyone who can see a map can copy/i],
    ['undo only takes back yours', /undo only takes back your own/i, /on top/i],
    ['deleting is for everyone', /deleting a star removes it for everyone/i],
    ['offline is view-only', /view-only until/i],
    ['guest bans are per tab', /per browser tab/i, /new link/i],
    ['chat is not saved', /chat isn.t saved/i],
  ])('covers %s', (_, ...patterns) => {
    for (const pattern of patterns) expect(text).toMatch(pattern)
  })

  it('every line is plain text', () => {
    for (const section of MULTIPLAYER_HELP) {
      expect(typeof section.title).toBe('string')
      for (const line of section.lines) expect(typeof line).toBe('string')
    }
  })
})
