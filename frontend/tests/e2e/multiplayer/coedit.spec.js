// Two people in one map (context/MOONSHOT.md, milestone 1): edits appear for
// the other, notes typed at once both survive, undo takes back only your own
// edit, the roster shows who's here, a delete closes the other's menu on it,
// Balance asks first when another editor is in, offline is read-only until
// it reconnects, and a viewer can't edit. Runs against a server of its own
// (playwright.multiplayer.config.js).
import { test, expect } from '@playwright/test'
import { createMap, freshName, hasNode, openMap, shareWith, signUp } from '../helpers/multiplayer.js'

test.describe('two people, one map', () => {
  let alice, bob, mapId

  test.beforeEach(async ({ browser }) => {
    alice = await (await browser.newContext()).newPage()
    bob = await (await browser.newContext()).newPage()
    await signUp(alice, freshName('alice'))
    const bobName = await signUp(bob, freshName('bob'))
    mapId = await createMap(alice, 'Shared galaxy')
    await shareWith(alice, mapId, bobName, 'editor')
    await openMap(alice, mapId)
    await openMap(bob, mapId)
  })

  test.afterEach(async () => {
    await alice.context().close()
    await bob.context().close()
  })

  test('a star Alice adds appears for Bob', async () => {
    const id = await alice.evaluate(() => window.__pleiades.commands.spawn({ x: 0, y: 0, z: 0 }).id)
    await expect.poll(() => hasNode(bob, id)).toBe(true)
  })

  test('both typing notes at once: both texts survive', async () => {
    const id = await alice.evaluate(() => window.__pleiades.commands.spawn({ x: 0, y: 0, z: 0 }).id)
    await expect.poll(() => hasNode(bob, id)).toBe(true)
    const type = (page, text) =>
      page.evaluate(
        ([nodeId, typed]) => {
          const { commands, mapDoc } = window.__pleiades
          const session = commands.editNotes(nodeId)
          mapDoc.transact(() => session.text.insert(0, typed))
          session.end()
        },
        [id, text],
      )
    await Promise.all([type(alice, 'AAA'), type(bob, 'BBB')])
    const read = (page) => page.evaluate((nodeId) => window.__pleiades.graph.getNode(nodeId).notes, id)
    await expect.poll(() => read(alice)).toMatch(/AAA/)
    await expect.poll(() => read(alice)).toMatch(/BBB/)
    await expect.poll(() => read(bob)).toBe(await read(alice))
  })

  test('undo only takes back my own edit', async () => {
    const mine = await alice.evaluate(() => window.__pleiades.commands.spawn({ x: 0, y: 0, z: 0 }).id)
    const theirs = await bob.evaluate(() => window.__pleiades.commands.spawn({ x: 50, y: 0, z: 0 }).id)
    await expect.poll(() => hasNode(alice, theirs)).toBe(true)
    await expect.poll(() => hasNode(bob, mine)).toBe(true)
    await alice.evaluate(() => window.__pleiades.commands.undo())
    await expect.poll(() => hasNode(bob, mine)).toBe(false)
    expect(await hasNode(bob, theirs)).toBe(true)
    expect(await hasNode(alice, theirs)).toBe(true)
  })

  test('Bob sees Alice in the roster and as an avatar', async () => {
    await expect(bob.locator('#roster .roster-bubble')).toHaveCount(1)
    await expect(alice.locator('#roster .roster-bubble')).toHaveCount(1)
    // Both start at the same pose; Alice flies ahead and turns, so Bob sees her.
    await alice.keyboard.down('w')
    await alice.waitForTimeout(1200)
    await alice.keyboard.up('w')
    await alice.evaluate(() => window.__t.look(300, 0))
    await expect.poll(() => bob.evaluate(() => window.__pleiades.avatars.drawn)).toBe(1)
    await bob.screenshot({ path: 'artifacts/e2e-multiplayer/avatar.png' })
  })

  test('Review Focus 2: deleting a star closes the other person’s menu on it', async () => {
    const id = await alice.evaluate(() => window.__pleiades.commands.spawn({ x: 0, y: 0, z: 0 }).id)
    await expect.poll(() => hasNode(bob, id)).toBe(true)
    await bob.evaluate((nodeId) => window.__pleiades.interaction.openMenuFor(nodeId), id)
    await expect(bob.locator('#radial-menu')).toBeVisible()
    // The HUD's notice is short-lived: record whatever it says from here on.
    await bob.evaluate(() => {
      const hud = document.getElementById('hud')
      window.__hudSaid = []
      new MutationObserver(() => window.__hudSaid.push(hud.textContent)).observe(hud, {
        childList: true,
        characterData: true,
        subtree: true,
      })
    })
    await alice.evaluate((nodeId) => window.__pleiades.commands.deleteNode(nodeId), id)
    await expect(bob.locator('#radial-menu')).toBeHidden()
    await expect.poll(() => hasNode(bob, id)).toBe(false)
    await expect.poll(() => bob.evaluate(() => window.__hudSaid.join(' | '))).toContain('was deleted')
  })

  test('Balance asks first when another editor is here', async () => {
    await alice.evaluate(() => {
      const c = window.__pleiades.commands
      const a = c.spawn({ x: 0, y: 0, z: 0 })
      const b = c.spawn({ x: 9, y: 0, z: 0 })
      c.connect(a.id, b.id)
    })
    // Not awaited in the page: it waits for an answer to the panel it opens.
    await alice.evaluate(() => {
      window.__pleiades.interaction.balance()
    })
    await expect(alice.locator('#editor')).toContainText('is editing. Rearrange the map for everyone?')
  })

  test('Orbit asks first too: it rearranges the map for everyone', async () => {
    const id = await alice.evaluate(() => {
      const c = window.__pleiades.commands
      const a = c.spawn({ x: 0, y: 0, z: 0 })
      const b = c.spawn({ x: 9, y: 0, z: 0 })
      c.connect(a.id, b.id)
      return a.id
    })
    await alice.evaluate((nodeId) => {
      window.__pleiades.interaction.orbitFor(nodeId)
    }, id)
    await expect(alice.locator('#editor')).toContainText('is editing. Rearrange the map for everyone?')
  })

  test('the notes editor goes read-only while offline, and back', async () => {
    const id = await bob.evaluate(() => window.__pleiades.commands.spawn({ x: 0, y: 0, z: 0 }).id)
    await bob.evaluate((nodeId) => window.__pleiades.interaction.editNotesFor(nodeId), id)
    const notes = bob.locator('#notes-sidebar textarea')
    await expect(notes).toBeVisible()
    await expect(notes).not.toHaveAttribute('readonly')
    await bob.context().setOffline(true)
    await expect(notes).toHaveAttribute('readonly')
    await bob.context().setOffline(false)
    await expect(notes).not.toHaveAttribute('readonly', { timeout: 20_000 })
  })

  test('offline is read-only and recovers', async () => {
    await bob.context().setOffline(true)
    await expect.poll(() => bob.evaluate(() => window.__pleiades.room.state)).toBe('offline')
    expect(await bob.evaluate(() => window.__pleiades.commands.spawn({ x: 0, y: 0, z: 0 }))).toBeNull()
    await bob.context().setOffline(false)
    await expect
      .poll(() => bob.evaluate(() => window.__pleiades.room.state), { timeout: 20_000 })
      .toBe('live')
    const id = await bob.evaluate(() => window.__pleiades.commands.spawn({ x: 0, y: 0, z: 0 }).id)
    await expect.poll(() => hasNode(alice, id)).toBe(true)
  })

  test('a viewer cannot edit', async ({ browser }) => {
    const vic = await (await browser.newContext()).newPage()
    const name = await signUp(vic, freshName('vic'))
    await shareWith(alice, mapId, name, 'viewer')
    await openMap(vic, mapId)
    expect(await vic.evaluate(() => window.__pleiades.room.state)).toBe('read_only')
    expect(await vic.evaluate(() => window.__pleiades.commands.spawn({ x: 0, y: 0, z: 0 }))).toBeNull()
    // A viewer counts for the roster, not for Balance's warning.
    await expect(alice.locator('#roster .roster-bubble')).toHaveCount(2)
    await vic.context().close()
  })
})

test('share from My maps: it lands in Shared with me, marked new until opened, and Leave takes it off', async ({
  browser,
}) => {
  // The shell has no WebGL to starve, so a size worth a screenshot.
  const alice = await (await browser.newContext({ viewport: { width: 1000, height: 720 } })).newPage()
  const bob = await (await browser.newContext()).newPage()
  await signUp(alice, freshName('alice'))
  const bobName = await signUp(bob, freshName('bob'))
  const mapId = await createMap(alice, 'Andromeda')

  await alice.goto('/account.html')
  const row = alice.locator(`.map[data-id="${mapId}"]`)
  await row.getByRole('button', { name: 'Share' }).click()
  const sharing = row.locator('.sharing')
  await sharing.getByLabel('Username to share with').fill(bobName)
  await sharing.getByLabel('Their role').selectOption('editor')
  await sharing.getByRole('button', { name: 'Share' }).click()
  await expect(sharing.locator('.member')).toHaveCount(2)
  await expect(sharing).toContainText(bobName)
  await alice.screenshot({ path: 'artifacts/e2e-multiplayer/share-panel.png' })

  await bob.goto('/account.html')
  const shared = bob.locator('#shared-maps .map')
  await expect(shared).toHaveCount(1)
  await expect(shared).toContainText('Andromeda')
  await expect(shared.locator('.badge')).toHaveText('new')

  await openMap(bob, mapId)
  await bob.goto('/account.html')
  await expect(bob.locator('#shared-maps .map .badge')).toHaveCount(0)
  await bob.locator('#shared-maps .map').getByRole('button', { name: 'Leave' }).click()
  await expect(bob.locator('#shared-section')).toBeHidden()

  await alice.context().close()
  await bob.context().close()
})
