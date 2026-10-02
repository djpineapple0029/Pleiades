// Social in a shared map (context/MOONSHOT.md, milestone 3): chat, emotes,
// follow, other people's cursors in notes. Runs against a server of its own
// (playwright.multiplayer.config.js).
import { test, expect } from '@playwright/test'
import { createMap, freshName, openMap, shareWith, signUp } from '../helpers/multiplayer.js'
import { t } from '../helpers/gestures.js'

/** Esc: the pointer goes, the Esc screen (and its room panel) shows. */
const escape = async (page) => {
  await t(page, 'escape()')
  await expect(page.locator('#room-panel')).toBeVisible()
}

test.describe('social', () => {
  let alice, bob, mapId, bobName

  test.beforeEach(async ({ browser }) => {
    alice = await (await browser.newContext()).newPage()
    bob = await (await browser.newContext()).newPage()
    await signUp(alice, freshName('alice'))
    bobName = await signUp(bob, freshName('bob'))
    mapId = await createMap(alice, 'Social galaxy')
    await shareWith(alice, mapId, bobName, 'editor')
    await openMap(alice, mapId)
    await openMap(bob, mapId)
  })

  test.afterEach(async () => {
    await alice.context().close()
    await bob.context().close()
  })

  test('Review Focus 4: Y, type, Enter — Bob sees it as text, never markup', async () => {
    const hostile = '<img src=x onerror="window.__owned=1"> 👩‍🚀 مرحبا'
    await alice.keyboard.press('y')
    await expect(alice.locator('#chat-form input')).toBeFocused()
    // Typed, not filled: W and ? in the line must not fly or open the key list.
    await alice.keyboard.type(hostile + ' W?')
    await alice.keyboard.press('Enter')
    await expect(alice.locator('#chat-form')).toBeHidden()
    const sent = hostile + ' W?'
    // Bob: in the feed over his HUD and in his panel's log, as the same text.
    await expect(bob.locator('#chat-feed .chat-text')).toHaveText(sent)
    await expect(bob.locator('#room-panel .chat-text')).toHaveText(sent)
    await expect(bob.locator('#chat-feed img, #room-panel img')).toHaveCount(0)
    expect(await bob.evaluate(() => window.__owned)).toBeUndefined()
    // Alice gets her own line back from the room, and the pointer back.
    await expect(alice.locator('#chat-feed .chat-text')).toHaveText(sent)
    await expect.poll(() => t(alice, 'locked()')).toBe(true)
    await bob.screenshot({ path: 'artifacts/e2e-multiplayer/chat.png' })
  })

  test('Esc closes the line without sending', async () => {
    await alice.keyboard.press('y')
    await alice.keyboard.type('never mind')
    await alice.keyboard.press('Escape')
    await expect(alice.locator('#chat-form')).toBeHidden()
    await bob.waitForTimeout(500)
    await expect(bob.locator('#room-panel .chat-text')).toHaveCount(0)
  })

  test('chat from the Esc screen; the feed fades, the log keeps it', async () => {
    await escape(alice)
    await alice.locator('#room-panel input').fill('hello there')
    await alice.locator('#room-panel input').press('Enter')
    await expect(bob.locator('#chat-feed .chat-text')).toHaveText('hello there')
    await expect(bob.locator('#chat-feed .chat-line')).toHaveCount(0, { timeout: 12_000 })
    await escape(bob)
    await expect(bob.locator('#room-panel .chat-text')).toHaveText('hello there')
    // Enter in the panel's line sent it; it didn't also take the pointer back.
    expect(await t(alice, 'locked()')).toBe(false)
    await bob.screenshot({ path: 'artifacts/e2e-multiplayer/room-panel.png' })
  })

  test('a viewer without the chat permission is told so and cannot send', async ({ browser }) => {
    const vicky = await (await browser.newContext()).newPage()
    const vickyName = await signUp(vicky, freshName('vicky'))
    await shareWith(alice, mapId, vickyName, 'viewer')
    await openMap(vicky, mapId)
    await escape(vicky)
    await expect(vicky.locator('#room-panel .room-note')).toHaveText('Chat is off for you on this map')
    await expect(vicky.locator('#room-panel form')).toBeHidden()
    // Even sent by hand, the room refuses it and nobody sees it.
    await vicky.evaluate(() => window.__pleiades.room.send({ type: 'chat', text: 'sneaky' }))
    await expect(vicky.locator('#hud')).toContainText(/chat is off/i)
    await alice.waitForTimeout(500)
    await expect(alice.locator('#room-panel .chat-text')).toHaveCount(0)
    await vicky.context().close()
  })
})
