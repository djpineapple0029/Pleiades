// Sharing done properly (context/MOONSHOT.md, milestone 2): links and guests,
// revoking, expiry choices, permissions that change live, kick and ban,
// restore and delete with people inside, and the admin's guest-link switch.
// Runs against a server of its own (playwright.multiplayer.config.js).
import { test, expect } from '@playwright/test'
import {
  adminSharing,
  createMap,
  freshName,
  hasNode,
  joinAsGuest,
  makeLink,
  openMap,
  shareWith,
  signUp,
} from '../helpers/multiplayer.js'

const CSRF = { 'X-Pleiades': '1' }

test.describe('sharing', () => {
  let alice, mapId
  const pages = []

  async function newPage(browser, options = {}) {
    const page = await (await browser.newContext(options)).newPage()
    pages.push(page)
    return page
  }

  test.beforeEach(async ({ browser }) => {
    alice = await newPage(browser)
    await signUp(alice, freshName('alice'))
    mapId = await createMap(alice, 'Pleiades cluster')
  })

  test.afterEach(async () => {
    while (pages.length) await pages.pop().context().close()
  })

  test('a view link: a guest joins by name, sees the stars, cannot edit, and shows as a guest', async ({
    browser,
  }) => {
    await openMap(alice, mapId)
    const star = await alice.evaluate(() => window.__pleiades.commands.spawn({ x: 0, y: 0, z: 0 }).id)
    const guest = await newPage(browser)
    await joinAsGuest(guest, await makeLink(alice, mapId, 'viewer'), 'Ari')
    await expect.poll(() => hasNode(guest, star)).toBe(true)
    expect(await guest.evaluate(() => window.__pleiades.room.state)).toBe('read_only')
    expect(await guest.evaluate(() => window.__pleiades.commands.spawn({ x: 0, y: 0, z: 0 }))).toBeNull()
    await expect(alice.locator('#roster .roster-bubble')).toHaveCount(1)
    await expect(alice.locator('#roster .roster-bubble')).toHaveAttribute('title', /^Ari \(guest\) · viewer$/)
    // The token left the address bar for this tab's storage.
    expect(guest.url()).not.toContain('link=')
    // A guest has no My maps: Home is the homepage.
    await expect(guest.locator('#map-home')).toHaveAttribute('href', /home\.html$/)
  })

  test('an edit link: the guest’s star appears for the owner', async ({ browser }) => {
    await openMap(alice, mapId)
    const guest = await newPage(browser)
    await joinAsGuest(guest, await makeLink(alice, mapId, 'editor'), 'Sam')
    const id = await guest.evaluate(() => window.__pleiades.commands.spawn({ x: 5, y: 0, z: 0 }).id)
    await expect.poll(() => hasNode(alice, id)).toBe(true)
  })

  test('revoking the link sends a connected guest out, and the link is dead', async ({ browser }) => {
    const guest = await newPage(browser)
    const link = await makeLink(alice, mapId, 'viewer')
    await joinAsGuest(guest, link, 'Ari')
    const revoked = await alice.request.delete(`/api/maps/${mapId}/link`, { headers: CSRF })
    expect(revoked.status()).toBe(200)
    await expect(guest.locator('#hud')).toContainText(/you were removed from this map/i)
    const landing = await alice.request.get(link, { maxRedirects: 0 })
    expect(landing.status()).toBe(410)
  })

  test('the dialog offers Never / 1 / 7 / 30 days and shows the chosen expiry', async ({ browser }) => {
    const owner = await newPage(browser, { viewport: { width: 1000, height: 720 } })
    await owner.context().addCookies(await alice.context().cookies())
    await owner.goto('/account.html')
    const row = owner.locator(`.map[data-id="${mapId}"]`)
    await row.getByRole('button', { name: 'Share' }).click()
    const sharing = row.locator('.sharing')
    const expiry = sharing.getByLabel('Link expires')
    await expect(expiry.locator('option')).toHaveText([
      'Never expires',
      'Expires in 1 day',
      'Expires in 7 days',
      'Expires in 30 days',
    ])
    await sharing.getByLabel('Anyone with the link can').selectOption('editor')
    await expiry.selectOption('7')
    await sharing.getByRole('button', { name: 'Make link' }).click()
    await expect(sharing.locator('.link-state')).toContainText('Anyone with the link can edit until')
    await expect(sharing.getByLabel('Share link')).toHaveValue(/\/s\/[A-Za-z0-9_-]{43}$/)
    await owner.screenshot({ path: 'artifacts/e2e-multiplayer/share-dialog.png', fullPage: true })
  })

  test('permissions change live: the owner turns off the editor’s Export', async ({ browser }) => {
    const bob = await newPage(browser)
    const bobName = await signUp(bob, freshName('bob'))
    await shareWith(alice, mapId, bobName, 'editor')
    await openMap(bob, mapId)
    const bobId = (await (await bob.request.get('/api/auth/me')).json()).user.id
    const changed = await alice.request.patch(`/api/maps/${mapId}/members/${bobId}`, {
      headers: CSRF,
      data: { perms: { export: false } },
    })
    expect(changed.status()).toBe(200)
    await expect.poll(() => bob.evaluate(() => window.__pleiades.room.you.perms.export)).toBe(false)
    await bob.evaluate(() => window.__pleiades.interaction.exportMap())
    await expect(bob.locator('#hud')).toContainText('Saving and exporting are off for you on this map')
  })

  test('kick and ban: the banned member can’t reopen it, and it leaves Shared with me', async ({
    browser,
  }) => {
    const bob = await newPage(browser)
    const bobName = await signUp(bob, freshName('bob'))
    await shareWith(alice, mapId, bobName, 'editor')
    await openMap(bob, mapId)
    const conn = await bob.evaluate(() => window.__pleiades.room.you.conn)
    const kicked = await alice.request.post(`/api/maps/${mapId}/kick`, {
      headers: CSRF,
      data: { conn, ban: true },
    })
    expect(kicked.status()).toBe(200)
    await expect(bob.locator('#hud')).toContainText(/you were removed from this map/i)
    await bob.waitForURL(/account\.html/, { timeout: 15_000 })
    await expect(bob.locator('#shared-section')).toBeHidden()
    await bob.goto(`/?map=${mapId}`)
    await bob.waitForURL(/account\.html#missing/, { timeout: 30_000 })
  })

  test('restoring with someone in: their page reloads into the restored version', async ({ browser }) => {
    const bob = await newPage(browser)
    const bobName = await signUp(bob, freshName('bob'))
    await shareWith(alice, mapId, bobName, 'editor')
    // A version with nothing in it, then a star on top.
    await openMap(alice, mapId)
    const star = await alice.evaluate(() => window.__pleiades.commands.spawn({ x: 0, y: 0, z: 0 }).id)
    await alice.evaluate(() => window.__pleiades.room.flush())
    const kept = await alice.request.post(`/api/maps/${mapId}/snapshots`, {
      headers: CSRF,
      data: { payload: { format: 'atlasmap', schema: 1, nodes: [], edges: [] } },
    })
    expect(kept.status(), await kept.text()).toBe(201)
    const snapshotId = (await kept.json()).id
    await openMap(bob, mapId)
    await expect.poll(() => hasNode(bob, star)).toBe(true)
    const reloaded = bob.waitForEvent('load', { timeout: 30_000 })
    const restored = await alice.request.post(`/api/maps/${mapId}/snapshots/${snapshotId}/restore`, {
      headers: CSRF,
    })
    expect(restored.status(), await restored.text()).toBe(200)
    await reloaded
    await expect
      .poll(() => bob.evaluate(() => window.__pleiades?.room?.state ?? null), { timeout: 30_000 })
      .toMatch(/^(live|read_only)$/)
    expect(await hasNode(bob, star)).toBe(false)
  })

  test('the owner deletes the map: the editor is told, then lands on My maps', async ({ browser }) => {
    const bob = await newPage(browser)
    const bobName = await signUp(bob, freshName('bob'))
    await shareWith(alice, mapId, bobName, 'editor')
    await openMap(bob, mapId)
    const deleted = await alice.request.delete(`/api/maps/${mapId}`, { headers: CSRF })
    expect(deleted.status()).toBe(200)
    await expect(bob.locator('#hud')).toContainText(/this map was deleted/i)
    await bob.waitForURL(/account\.html/, { timeout: 15_000 })
  })

  test('the admin turns guest links off: a connected guest is removed, and the link page says so', async ({
    browser,
  }) => {
    const guest = await newPage(browser)
    const link = await makeLink(alice, mapId, 'viewer')
    await joinAsGuest(guest, link, 'Ari')
    try {
      await adminSharing(alice, { guest_links: false })
      await expect(guest.locator('#hud')).toContainText(/you were removed from this map/i)
      const page = await newPage(browser)
      await page.goto(link)
      await expect(page.locator('body')).toContainText("This link doesn't work any more.")
    } finally {
      await adminSharing(alice, { guest_links: true })
    }
  })
})
