// Social in a shared map (context/MOONSHOT.md, milestone 3): chat, emotes,
// follow, other people's cursors in notes. Runs against a server of its own
// (playwright.multiplayer.config.js).
import { test, expect } from '@playwright/test'
import { createMap, freshName, openMap, shareWith, signUp } from '../helpers/multiplayer.js'
import { settle, t } from '../helpers/gestures.js'

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

  /** Hold G, look toward a wedge, let go; what the ring showed and armed. */
  async function emoteRing(page, dx, dy, shot = null) {
    await page.keyboard.down('g')
    await settle(page)
    const wedges = await t(page, 'wedges()')
    await t(page, `look(${dx}, ${dy})`)
    await settle(page)
    const armed = await t(page, 'armed()')
    if (shot) await page.screenshot({ path: shot })
    await page.keyboard.up('g')
    await settle(page)
    return { wedges, armed }
  }

  /** Every emote message `page` receives from now on, in order. */
  const recordEmotes = (page) =>
    page.evaluate(() => {
      const { emotes } = window.__pleiades
      window.__emotes = []
      const receive = emotes.receive
      emotes.receive = (message) => {
        window.__emotes.push(message.id)
        receive(message)
      }
    })
  const emotesSeen = (page) => page.evaluate(() => window.__emotes)

  test('hold G, point, let go: Bob sees the emote, Alice sees her own; one a second', async () => {
    await recordEmotes(bob)
    // Alice flies ahead and Bob turns a little, so her ship is in his view.
    await alice.keyboard.down('w')
    await alice.waitForTimeout(1200)
    await alice.keyboard.up('w')
    await alice.evaluate(() => window.__t.look(300, 0))
    await expect.poll(() => bob.evaluate(() => window.__pleiades.avatars.drawn)).toBe(1)
    const ringShot = 'artifacts/e2e-multiplayer/emote-ring.png'
    const { wedges, armed } = await emoteRing(alice, 0, -80, ringShot) // straight up: the first wedge
    expect(wedges).toEqual(['👋', '👍', '👎', '👀', '💡', '😂', '❤️', '❓'])
    expect(armed).toBe('👋')
    await expect.poll(() => emotesSeen(bob)).toEqual(['wave'])
    await expect(alice.locator('#my-emote')).toHaveText('👋')
    await bob.screenshot({ path: 'artifacts/e2e-multiplayer/emote-wave.png' })
    await alice.screenshot({ path: 'artifacts/e2e-multiplayer/emote-mine.png' })
    // Straight away again: the ring opens, but nothing is sent.
    await emoteRing(alice, 80, 0)
    await bob.waitForTimeout(400)
    expect(await emotesSeen(bob)).toEqual(['wave'])
    // A second later, it goes.
    await alice.waitForTimeout(1100)
    const down = await emoteRing(alice, 0, 80) // straight down: the fifth of eight
    expect(down.armed).toBe('💡')
    await expect.poll(() => emotesSeen(bob)).toEqual(['wave', 'idea'])
    await bob.screenshot({ path: 'artifacts/e2e-multiplayer/emote.png' })
    expect(await t(alice, 'locked()')).toBe(true)
  })

  /** Where `page`'s camera is, from what it publishes in awareness. */
  const published = (page) =>
    page.evaluate(() => {
      const { room, mapDoc } = window.__pleiades
      return room.awareness.getStates().get(mapDoc.doc.clientID)?.pose ?? null
    })

  test('Bob follows Alice: F, she flies, his camera trails hers; moving stops it', async () => {
    // Alice moves out ahead of Bob, inside his view.
    await alice.keyboard.down('w')
    await alice.waitForTimeout(1500)
    await alice.keyboard.up('w')
    await expect.poll(() => bob.evaluate(() => window.__pleiades.avatars.drawn)).toBe(1)
    await bob.keyboard.press('f')
    await expect(bob.locator('#hud')).toContainText(/following alice.* — move to stop/)
    await expect
      .poll(() => bob.evaluate(() => window.__pleiades.room.awareness.getLocalState().following))
      .not.toBeNull()
    // Alice flies on and turns; Bob ends up 30 behind and 6 above her.
    await alice.evaluate(() => window.__t.look(400, 0))
    await alice.keyboard.down('w')
    await alice.waitForTimeout(1500)
    await alice.keyboard.up('w')
    const gap = async () => {
      const [a, b] = await Promise.all([published(alice), published(bob)])
      if (!a || !b) return Infinity
      return Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2])
    }
    await expect.poll(gap, { timeout: 20_000 }).toBeLessThan(40)
    await expect.poll(gap, { timeout: 20_000 }).toBeGreaterThan(25)
    await bob.screenshot({ path: 'artifacts/e2e-multiplayer/follow.png' })
    // Bob moves: he's flying himself again.
    await bob.keyboard.press('s')
    // Quietly: the "following" line goes, and the trace says why.
    await expect(bob.locator('#hud')).toHaveAttribute('data-trace', /stopped following/)
    await expect(bob.locator('#hud')).not.toContainText(/following/)
    expect(await bob.evaluate(() => window.__pleiades.follow.active)).toBe(false)
    await expect
      .poll(() => bob.evaluate(() => window.__pleiades.room.awareness.getLocalState().following))
      .toBeNull()
  })

  test('two people cannot follow each other round in a circle', async () => {
    await alice.keyboard.down('w')
    await alice.waitForTimeout(1500)
    await alice.keyboard.up('w')
    await expect.poll(() => bob.evaluate(() => window.__pleiades.avatars.drawn)).toBe(1)
    await bob.keyboard.press('f')
    await expect(bob.locator('#hud')).toContainText(/following/)
    // Alice turns round to face Bob and tries to follow him back.
    await alice.evaluate(() => window.__t.look(1600, 0))
    await expect.poll(() => alice.evaluate(() => window.__pleiades.avatars.drawn)).toBe(1)
    // Once Alice knows Bob is following her:
    await expect
      .poll(() =>
        alice.evaluate(() => {
          const { room } = window.__pleiades
          const other = room.roster.find((p) => p.conn !== room.you.conn)
          return room.awareness.getStates().get(other?.clientIds[0])?.following ?? null
        }),
      )
      .not.toBeNull()
    await alice.evaluate(() => {
      const { room } = window.__pleiades
      const other = room.roster.find((p) => p.conn !== room.you.conn)
      window.__pleiades.interaction.followPerson(
        other.clientIds[0],
        other.name,
        room.awareness.getStates().get(other.clientIds[0])?.following,
      )
    })
    await expect(alice.locator('#hud')).toContainText(/is following you/)
    expect(await alice.evaluate(() => window.__pleiades.follow.active)).toBe(false)
  })

  test('both follow each other at the same moment: exactly one keeps following', async () => {
    // Neither knows about the other yet, as when both press F at once.
    const followOther = (page) =>
      page.evaluate(() => {
        const { room, interaction } = window.__pleiades
        const other = room.roster.find((p) => p.conn !== room.you.conn)
        interaction.followPerson(other.clientIds[0], other.name, null)
      })
    await expect.poll(() => bob.evaluate(() => window.__pleiades.room.roster[0]?.clientIds.length)).toBe(1)
    await expect.poll(() => alice.evaluate(() => window.__pleiades.room.roster[1]?.clientIds.length)).toBe(1)
    await Promise.all([followOther(alice), followOther(bob)])
    const following = () =>
      Promise.all([alice, bob].map((page) => page.evaluate(() => window.__pleiades.follow.active)))
    await expect.poll(async () => (await following()).filter(Boolean).length).toBe(1)
    await alice.waitForTimeout(1000)
    expect((await following()).filter(Boolean)).toHaveLength(1)
  })

  /** Alice a little ahead of Bob, side on to him, so her shape shows. */
  async function aliceSideOn() {
    await alice.keyboard.down('w')
    await alice.waitForTimeout(450)
    await alice.keyboard.up('w')
    await alice.evaluate(() => window.__t.look(800, 0))
    await expect.poll(() => bob.evaluate(() => window.__pleiades.avatars.drawn)).toBe(1)
    await bob.waitForTimeout(400) // past the 150 ms the avatars are drawn behind
  }

  test('avatars match the Look: ships, a submarine, a cursor, a marker', async () => {
    await aliceSideOn()
    const expected = {
      'deep-space': 'ship',
      'deep-sea': 'sub',
      terminal: 'cursor',
      minimal: 'marker',
      'shallow-space': 'ship',
    }
    for (const [look, style] of Object.entries(expected)) {
      await bob.evaluate((id) => window.__pleiades.looks.set(id, { instant: true, remember: false }), look)
      await expect.poll(() => bob.evaluate(() => window.__pleiades.avatars.style)).toBe(style)
      // The cursor blinks: catch it in the half second it's on.
      await bob.waitForFunction(() => performance.now() % 1000 < 250)
      await bob.screenshot({ path: `artifacts/avatars/${look}.png` })
    }
  })

  test("Show editors off hides Alice's ship, and stays off after a reload", async () => {
    await aliceSideOn()
    await escape(bob)
    const editors = bob.getByLabel('Show editors')
    await expect(editors).toBeChecked()
    await editors.uncheck()
    await expect.poll(() => bob.evaluate(() => window.__pleiades.avatars.drawn)).toBe(0)
    // Kept in Bob's account.
    await expect
      .poll(async () => (await bob.request.get('/api/account/settings')).json())
      .toMatchObject({ overrides: { multiplayer: { show_editor_avatars: false } } })
    await openMap(bob, mapId)
    await escape(bob)
    await expect(bob.getByLabel('Show editors')).not.toBeChecked()
    await bob.waitForTimeout(800)
    expect(await bob.evaluate(() => window.__pleiades.avatars.drawn)).toBe(0)
    // Viewers' switch is separate: Alice is an owner, so it changes nothing.
    await bob.getByLabel('Show editors').check()
    await bob.getByLabel('Show viewers').uncheck()
    await expect.poll(() => bob.evaluate(() => window.__pleiades.avatars.drawn)).toBe(1)
  })

  test("My maps shows who's in each map, and keeps it fresh without closing what's open", async () => {
    test.setTimeout(120_000)
    // Alice's list, in another tab of hers, while she and Bob are in the map.
    const shell = await alice.context().newPage()
    await shell.goto('/account.html')
    const row = shell.locator(`#maps .map[data-id="${mapId}"]`)
    const marker = row.locator('.online')
    await expect(marker).toBeVisible()
    await expect(marker.locator('.person')).toHaveCount(2)
    await expect(marker).toHaveAttribute('title', new RegExp(`In this map now: .*${bobName}`))
    await shell.screenshot({ path: 'artifacts/e2e-multiplayer/my-maps-online.png' })
    // Bob's list shows it too, on the Shared with me row.
    const bobShell = await bob.context().newPage()
    await bobShell.goto('/account.html')
    await expect(bobShell.locator('#shared-maps .map .online .person')).toHaveCount(2)
    await bobShell.close()
    // Alice opens the Share panel; Bob leaves the map; the next poll updates
    // the marker in place and the panel stays open.
    await row.getByRole('button', { name: 'Share' }).click()
    await expect(row.locator('.sharing')).toBeVisible()
    await bob.goto('about:blank')
    await expect(marker.locator('.person')).toHaveCount(1, { timeout: 40_000 })
    await expect(row.locator('.sharing')).toBeVisible()
    await shell.close()
  })

  test("the owner makes Deep Sea the map's Look: Bob opens in it; cleared, he's back to his own", async () => {
    await alice.evaluate(() => window.__pleiades.looks.set('deep-sea', { instant: true, remember: false }))
    await escape(alice)
    const line = alice.locator('#room-panel .room-look')
    await expect(line).toContainText('Everyone opens this map in their own Look.')
    await line.getByRole('button', { name: "Make Deep Sea this map's Look" }).click()
    await expect(line).toContainText('This map opens in Deep Sea for everyone.')
    await alice.screenshot({ path: 'artifacts/e2e-multiplayer/default-look.png' })
    // Bob, an editor, sees no such line, and opens the map in Deep Sea.
    await escape(bob)
    await expect(bob.locator('#room-panel .room-look')).toBeHidden()
    await openMap(bob, mapId)
    expect(await bob.evaluate(() => window.__pleiades.looks.current.id)).toBe('deep-sea')
    // His own account's look is untouched.
    const own = await (await bob.request.get('/api/account/settings')).json()
    expect(own.overrides?.visuals?.look).toBeUndefined()
    // Cleared: the next open is his own Look again.
    await escape(alice)
    await line.getByRole('button', { name: "Clear this map's Look" }).click()
    await expect(line).toContainText('Everyone opens this map in their own Look.')
    await openMap(bob, mapId)
    expect(await bob.evaluate(() => window.__pleiades.looks.current.id)).toBe('deep-space')
  })
})
