// Accounts, milestones 2 to 4 (USERS.md): sign-up in the account shell, the
// map list, opening a server map, autosave, Ctrl+S, back to the list, and the
// safety rails around them: a second tab never overwrites (the conflict
// panel), edits made offline survive in this browser and are offered back,
// earlier versions can be restored, signed-out goes to sign-in. Plus the
// homepage in front of it all, and the warning before signing in over plain
// HTTP. Milestone 6: /admin's Accounts tab (reset a password, disable,
// delete) and the new password a reset account must choose. Milestone 7:
// upload and download map files, the zip of everything, and the Account
// page. Runs against a Flask of its own (playwright.accounts.config.js).
import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { ADMIN_PASSWORD, API_ORIGIN } from '../../../playwright.accounts.config.js'
import { collectConsoleErrors, installGestures, pickMenu, settle, t } from '../helpers/gestures.js'

const PASSWORD = 'e2e password 1'
let counter = 0
// One account per test: the database outlives each test within a run.
const freshName = () => `e2e${Date.now().toString(36)}${counter++}`

async function signUp(page, username = freshName()) {
  // Signed out, `/` is the homepage; its "Create an account" opens the form.
  await page.goto('/')
  await page.getByRole('link', { name: 'Create an account' }).click()
  await expect(page).toHaveURL(/account\.html$/)
  await expect(page.getByRole('tab', { name: 'Create account' })).toHaveAttribute('aria-selected', 'true')
  await page.locator('#sign-up-username').fill(username)
  await page.locator('#sign-up-password').fill(PASSWORD)
  await page.locator('#sign-up-confirm').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.locator('#who-name')).toHaveText(username)
  return username
}

async function newMap(page, name) {
  await page.locator('#new-map-name').fill(name)
  await page.getByRole('button', { name: 'New map' }).click()
  await expect(page).toHaveURL(/\?map=[\w-]{16}$/)
  await page.waitForTimeout(1500)
  await installGestures(page)
  return new URL(page.url()).searchParams.get('map')
}

const hud = (page) => t(page, 'hud()')
const panel = (page) => page.locator('#editor')

// The same map in a second tab of the same browser (same session cookie).
async function openAgain(page, id) {
  const other = await page.context().newPage()
  await other.goto(`/?map=${id}`)
  await other.waitForTimeout(1500)
  await installGestures(other)
  return other
}

// Tab A saves a star; tab B, still on revision 1, adds its own and is refused.
async function makeConflict(page, id) {
  const other = await openAgain(page, id)
  await t(page, 'doubleClick()')
  await settle(page)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await serverMap(page, id)).revision).toBe(2)
  await t(other, 'look(300, 0)')
  await settle(other)
  await t(other, 'doubleClick()')
  await settle(other)
  await t(other, 'look(0, 200)')
  await settle(other)
  await other.keyboard.press('ControlOrMeta+s')
  return other
}
const serverMap = async (page, id) => (await page.request.get(`/api/maps/${id}`)).json()

test('sign up, make a map, and it saves itself', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await signUp(page)
  await expect(page.locator('#empty')).toBeVisible()

  const id = await newMap(page, 'Orion')
  expect(await page.title()).toBe('Orion — Pleiades')
  await expect.poll(() => hud(page)).toContain('Orion · saved · 0 nodes')

  await t(page, 'doubleClick()')
  await settle(page)
  // Off the new star, so the HUD shows the map rather than describing it.
  await t(page, 'look(300, 0)')
  await settle(page)
  expect(await hud(page)).toMatch(/unsaved|saving/)
  expect(await page.title()).toBe('• Orion — Pleiades')
  // Nothing goes out before the debounce...
  expect((await serverMap(page, id)).payload.nodes).toHaveLength(0)
  // ...and then it does, with no keypress.
  await expect.poll(() => hud(page), { timeout: 15_000 }).toContain('Orion · saved · 1 nodes')
  const saved = await serverMap(page, id)
  expect(saved.payload.nodes).toHaveLength(1)
  expect(saved.revision).toBe(2)
  expect(await page.title()).toBe('Orion — Pleiades')

  // A reload opens what was saved.
  await page.reload()
  await page.waitForTimeout(1500)
  await expect
    .poll(() => page.locator('#hud').getAttribute('data-trace'))
    .toContain('Orion · saved · 1 nodes')
  expect(errors).toEqual([])
})

test('Ctrl+S saves at once, and My maps goes back to the list', async ({ page }) => {
  await signUp(page)
  const id = await newMap(page, 'Lyra')
  await t(page, 'doubleClick()')
  await settle(page)
  await page.keyboard.press('ControlOrMeta+s')
  // Well inside the 3 s debounce.
  await expect.poll(async () => (await serverMap(page, id)).revision, { timeout: 2000 }).toBe(2)
  await expect.poll(() => hud(page)).toContain(' · saved')

  // An edit, then straight back to the list: leaving saves it first.
  await t(page, 'look(300, 0)')
  await settle(page)
  await t(page, 'doubleClick()')
  await settle(page)
  await t(page, 'look(300, 0)')
  await settle(page)
  // pickMenu's own settle would run on a page that has already navigated.
  await t(page, 'rightDown()')
  await settle(page)
  expect(await t(page, 'wedges()')).toEqual(['My maps', 'Save', 'Export', 'Balance', 'More…'])
  await t(page, 'look(0, -60)')
  expect(await t(page, 'armed()')).toBe('My maps')
  await Promise.all([page.waitForURL(/account\.html$/), t(page, 'rightUp()')])
  expect((await serverMap(page, id)).payload.nodes).toHaveLength(2)
  await expect(page.locator('.map .meta')).toContainText('2 stars')
})

test('a second tab never overwrites the first; its edits can become a copy', async ({ page }) => {
  await signUp(page)
  const id = await newMap(page, 'Twins')
  const other = await makeConflict(page, id)

  // The panel comes up by itself; Esc puts it off, Ctrl+S brings it back.
  await expect(panel(other)).toContainText('Twins was changed in another tab or device at')
  await other.keyboard.press('Escape')
  await expect(panel(other)).toBeHidden()
  await expect.poll(() => t(other, 'hud()')).toContain('changed in another tab or device')
  const stored = await serverMap(page, id)
  expect(stored.revision).toBe(2)
  expect(stored.payload.nodes).toHaveLength(1)
  await other.keyboard.press('ControlOrMeta+s')
  await expect(panel(other)).toContainText('L: load theirs')

  await Promise.all([other.waitForURL((url) => !url.search.includes(id)), other.keyboard.press('c')])
  const copyId = new URL(other.url()).searchParams.get('map')
  const copy = await serverMap(page, copyId)
  expect(copy.name).toBe('Twins (conflict copy)')
  expect(copy.payload.nodes).toHaveLength(1)
  const at = (node) => [node.x, node.y, node.z]
  expect(at(copy.payload.nodes[0])).not.toEqual(at(stored.payload.nodes[0]))
  // The original is untouched, and the copy opens clean, with nothing to restore.
  expect((await serverMap(page, id)).revision).toBe(2)
  await other.waitForTimeout(1500)
  await expect(panel(other)).toBeHidden()
  await expect
    .poll(() => other.locator('#hud').getAttribute('data-trace'))
    .toContain('Twins (conflict copy) · saved · 1 nodes')
})

test('load theirs keeps the edits in this tab in history and opens the saved map', async ({ page }) => {
  await signUp(page)
  const id = await newMap(page, 'Gemini')
  const theirs = (await serverMap(page, id)).payload
  const other = await makeConflict(page, id)
  await expect(panel(other)).toContainText("keeps yours in this map's history")
  await Promise.all([other.waitForEvent('load'), other.keyboard.press('l')])
  await other.waitForTimeout(1500)
  // No offer of the dropped edits in this browser: history has them.
  await expect(panel(other)).toBeHidden()
  await expect
    .poll(() => other.locator('#hud').getAttribute('data-trace'))
    .toContain('Gemini · saved · 1 nodes')
  expect(theirs.nodes).toHaveLength(0)
  expect((await serverMap(page, id)).revision).toBe(2)
  const { snapshots } = await (await page.request.get(`/api/maps/${id}/snapshots`)).json()
  // Newest first: tab B's star (based on revision 1), then revision 1 as tab A's save replaced it.
  expect(snapshots.map((s) => [s.reason, s.revision, s.node_count])).toEqual([
    ['unsaved-edits', 1, 1],
    ['rolling', 1, 0],
  ])
})

async function signIn(page, username, password = PASSWORD) {
  await page.goto('/account.html')
  await page.locator('#sign-in-username').fill(username)
  await page.locator('#sign-in-password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('#who-name')).toHaveText(username)
}

// Adds a star while this browser is offline, waits for the HUD to say so, then
// leaves the page for good (a dead laptop, a closed tab) and signs back in.
// Only what this browser kept survives. Chromium still lets the keepalive save
// sent on the way out through under setOffline, so the session is ended first
// (as if it expired meanwhile) and that save is refused.
async function editOfflineAndLeave(page, context, username) {
  await context.setOffline(true)
  await t(page, 'doubleClick()')
  await settle(page)
  await t(page, 'look(300, 0)')
  await settle(page)
  await expect.poll(() => hud(page), { timeout: 15_000 }).toContain('offline, not saved (retrying)')
  await page.request.post('/api/auth/logout', { headers: { 'X-Pleiades': '1' } })
  await page.goto('about:blank')
  await context.setOffline(false)
  await signIn(page, username)
}

test('offline: keeps retrying, keeps the edits in this browser, and offers them back', async ({
  page,
  context,
}) => {
  page.on('dialog', (dialog) => dialog.accept())
  const username = await signUp(page)
  const id = await newMap(page, 'Vela')
  await editOfflineAndLeave(page, context, username)
  expect((await serverMap(page, id)).revision).toBe(1)

  await page.goto(`/?map=${id}`)
  await page.waitForTimeout(1500)
  await expect(panel(page)).toContainText('unsaved changes to Vela')
  await expect(panel(page)).toContainText('R: restore them')
  await page.keyboard.press('r')
  await expect(panel(page)).toBeHidden()
  await expect.poll(async () => (await serverMap(page, id)).payload.nodes.length, { timeout: 15_000 }).toBe(1)
  await expect.poll(() => page.locator('#hud').getAttribute('data-trace')).toContain('Vela · saved · 1 nodes')

  // Saved, so nothing is offered next time.
  await page.reload()
  await page.waitForTimeout(1500)
  await expect(panel(page)).toBeHidden()
})

test('a save that landed on the way out leaves nothing to offer', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept())
  await signUp(page)
  const id = await newMap(page, 'Pyxis')
  // Autosave is refused while the tab is open; the keepalive save sent as it
  // goes gets through (the route can't catch a request from a page that's gone).
  const offline = (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue())
  await page.route('**/api/maps/*', offline)
  await t(page, 'doubleClick()')
  await settle(page)
  await t(page, 'look(300, 0)')
  await settle(page)
  await expect.poll(() => hud(page), { timeout: 15_000 }).toContain('offline')
  await page.goto('/account.html')
  await page.unroute('**/api/maps/*', offline)
  await expect.poll(async () => (await serverMap(page, id)).revision).toBe(2)

  await page.goto(`/?map=${id}`)
  await page.waitForTimeout(1500)
  await expect(panel(page)).toBeHidden()
  await expect
    .poll(() => page.locator('#hud').getAttribute('data-trace'))
    .toContain('Pyxis · saved · 1 nodes')
})

test('edits kept before the rename (the atlasmap database) are still offered back', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept())
  await signUp(page)
  const id = await newMap(page, 'Lyra')
  await page.goto('/account.html')
  await page.evaluate(
    (mapId) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('atlasmap', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('unsaved-maps', { keyPath: 'mapId' })
        req.onsuccess = () => {
          const tx = req.result.transaction('unsaved-maps', 'readwrite')
          tx.objectStore('unsaved-maps').put({
            mapId,
            name: 'Lyra',
            baseRevision: 1,
            savedAt: Date.now(),
            payload: {
              format: 'atlasmap',
              schema: 1,
              nodes: [{ id: 'n1', label: 'kept', x: 0, y: 0, z: 0 }],
              edges: [],
            },
          })
          tx.oncomplete = () => {
            req.result.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      }),
    id,
  )

  await page.goto(`/?map=${id}`)
  await page.waitForTimeout(1500)
  await expect(panel(page)).toContainText('unsaved changes to Lyra')
  await page.keyboard.press('r')
  await expect.poll(async () => (await serverMap(page, id)).payload.nodes.length, { timeout: 15_000 }).toBe(1)
  const names = await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name))
  expect(names, 'the old database is gone once moved').not.toContain('atlasmap')
})

test('edits kept here after the map moved on can only become a copy', async ({ page, context }) => {
  page.on('dialog', (dialog) => dialog.accept())
  const username = await signUp(page)
  const id = await newMap(page, 'Cetus')
  await editOfflineAndLeave(page, context, username)

  // Meanwhile another device saves the map.
  const moved = await page.request.put(`/api/maps/${id}`, {
    headers: { 'X-Pleiades': '1', 'If-Match': '1' },
    data: { payload: { schema: 1, nodes: [], edges: [], note: 'elsewhere' } },
  })
  expect(moved.ok()).toBe(true)

  await page.goto(`/?map=${id}`)
  await page.waitForTimeout(1500)
  await expect(panel(page)).toContainText('changed on the server since')
  await page.keyboard.press('c')
  await expect(panel(page)).toBeHidden()
  await expect.poll(() => page.locator('#hud').getAttribute('data-trace')).toContain('Cetus (unsaved copy)')
  const list = (await (await page.request.get('/api/maps')).json()).maps
  const copy = list.find((map) => map.name === 'Cetus (unsaved copy)')
  expect(copy.node_count).toBe(1)
  // The map itself keeps the other device's version.
  expect((await serverMap(page, id)).payload.note).toBe('elsewhere')

  await page.goto('/account.html')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.locator('#sign-in-form')).toBeVisible()
  const left = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('pleiades', 1)
        req.onsuccess = () => {
          const get = req.result.transaction('unsaved-maps').objectStore('unsaved-maps').count()
          get.onsuccess = () => resolve(get.result)
        }
      }),
  )
  expect(left, 'sign-out clears what this browser kept').toBe(0)
})

test('the list: rename, duplicate, delete', async ({ page }) => {
  await signUp(page)
  await page.locator('#new-map-name').fill('Draco')
  await page.getByRole('button', { name: 'New map' }).click()
  await expect(page).toHaveURL(/\?map=/)
  await page.goto('/account.html')

  const row = page.locator('.map').first()
  await row.getByRole('button', { name: 'Rename' }).click()
  await row.locator('input').fill('Draco <b>major</b>')
  await row.locator('input').press('Enter')
  // Set as text, never as markup.
  await expect(page.locator('.map .name')).toHaveText('Draco <b>major</b>')

  await page.locator('.map').first().getByRole('button', { name: 'Duplicate' }).click()
  await expect(page.locator('.map')).toHaveCount(2)
  await expect(page.locator('.map .name').filter({ hasText: '(copy)' })).toHaveCount(1)

  const copy = page.locator('.map').filter({ hasText: '(copy)' })
  await copy.getByRole('button', { name: 'Delete' }).click()
  await copy.getByRole('button', { name: 'Delete' }).click()
  await expect(page.locator('.map')).toHaveCount(1)

  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.locator('#sign-in-form')).toBeVisible()
})

test('history: restore an earlier version from the list, then undo the restore', async ({ page }) => {
  await signUp(page)
  const id = await newMap(page, 'Cygnus')
  await t(page, 'doubleClick()')
  await settle(page)
  // The first save keeps the empty revision 1 in history.
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await serverMap(page, id)).revision).toBe(2)
  await page.goto('/account.html')

  const row = page.locator('.map').first()
  await expect(row.locator('.meta')).toContainText('1 star')
  await row.getByRole('button', { name: 'History' }).click()
  const versions = row.locator('.version')
  await expect(versions).toHaveCount(1)
  await expect(versions.first()).toContainText('0 stars')

  await versions.first().getByRole('button', { name: 'Restore' }).click()
  await expect(versions.first()).toContainText('Make this the current version?')
  await versions.first().getByRole('button', { name: 'Restore' }).click()
  // The list and its history come back, with what the restore replaced on top.
  const again = page.locator('.map').first()
  await expect(again.locator('.history .done')).toContainText('Restored the version from')
  await expect(again.locator('.meta').first()).toContainText('0 stars')
  const after = again.locator('.version')
  await expect(after).toHaveCount(2)
  await expect(after.first()).toContainText('1 star · ')
  await expect(after.first()).toContainText('kept before a restore')
  const restored = await serverMap(page, id)
  expect([restored.revision, restored.payload.nodes.length]).toEqual([3, 0])

  // Undo it the same way.
  await after.first().getByRole('button', { name: 'Restore' }).click()
  await after.first().getByRole('button', { name: 'Restore' }).click()
  await expect(page.locator('.map').first().locator('.history .done')).toBeVisible()
  const undone = await serverMap(page, id)
  expect([undone.revision, undone.payload.nodes.length]).toEqual([4, 1])

  // Opening it shows the restored star, saved.
  await page.locator('.map .name').first().click()
  await page.waitForTimeout(1500)
  await expect
    .poll(() => page.locator('#hud').getAttribute('data-trace'))
    .toContain('Cygnus · saved · 1 nodes')

  // History closes again from the list.
  await page.goto('/account.html')
  const closing = page.locator('.map').first()
  await closing.getByRole('button', { name: 'History' }).click()
  await expect(closing.locator('.version')).toHaveCount(3)
  await closing.getByRole('button', { name: 'History' }).click()
  await expect(closing.locator('.history')).toHaveCount(0)
})

test('signed out, a map link goes to sign-in; a missing map says so', async ({ page, browser }) => {
  const username = await signUp(page)
  const id = await newMap(page, 'Secret')

  const stranger = await browser.newContext()
  const strangerPage = await stranger.newPage()
  await strangerPage.goto(`/?map=${id}`)
  await expect(strangerPage).toHaveURL(/account\.html$/)
  await expect(strangerPage.locator('#sign-in-form')).toBeVisible()
  await stranger.close()

  await page.goto('/?map=AAAAAAAAAAAAAAAA')
  await expect(page).toHaveURL(/account\.html$/)
  await expect(page.locator('#notice')).toContainText("doesn't exist")
  await expect(page.locator('#who-name')).toHaveText(username)
})

test('sign in with the wrong password, then the right one', async ({ page, browser }) => {
  const username = await signUp(page)
  const fresh = await (await browser.newContext()).newPage()
  await fresh.goto('/account.html')
  await fresh.locator('#sign-in-username').fill(username)
  await fresh.locator('#sign-in-password').fill('not it at all')
  await fresh.getByRole('button', { name: 'Sign in' }).click()
  await expect(fresh.locator('#sign-in-error')).toHaveText('Wrong username or password.')
  await signIn(fresh, username)
})

test('?local is the classic app, even with accounts on', async ({ page }) => {
  await page.goto('/?local')
  await page.waitForTimeout(1500)
  expect(page.url()).toMatch(/\?local$/)
  await installGestures(page)
  expect(await hud(page)).toContain('map.plm')
  const menu = await pickMenu(page, 0, -60)
  expect(menu.labels[0]).toBe('New')
})

test('signed out, / is the homepage: Get started opens the app, Sign in the shell', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('A mind map you fly through.')
  await expect(page.locator('#get-started')).toHaveAttribute('href', '/?local')
  // The key caps in the copy and the list come from the server's keymap.
  await expect(page.locator('#keys li').first()).toBeVisible()
  await page.getByRole('link', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/account\.html$/)
  await expect(page.locator('#sign-in-form')).toBeVisible()
  await page.locator('#home-link').click()
  await expect(page).toHaveURL(/home\.html$/)
  await page.locator('#get-started').click()
  await expect(page).toHaveURL(/\?local$/)
  expect(errors).toEqual([])
})

test('signed in, / goes straight to My maps; the homepage says My maps', async ({ page }) => {
  const username = await signUp(page)
  await page.goto('/')
  await expect(page).toHaveURL(/account\.html$/)
  await expect(page.locator('#who-name')).toHaveText(username)
  await page.goto('/home.html')
  await expect(page.locator('#sign-in')).toHaveText('My maps')
  await expect(page.locator('#sign-up')).toBeHidden()
})

test('over plain HTTP, the shell warns once before the sign-in form', async ({ page }) => {
  // Loopback is always secure, so play a LAN address: the server's own answer, marked not secure.
  await page.route('**/api/auth/me', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...(await response.json()), secure: false } })
  })
  await page.goto('/account.html')
  await expect(page.getByRole('heading', { name: "This connection isn't encrypted" })).toBeVisible()
  await expect(page.locator('#sign-in-form')).toBeHidden()
  await expect(page.locator('#insecure-local')).toHaveAttribute('href', '/?local')
  await page.getByRole('button', { name: 'Sign in anyway' }).click()
  await expect(page.locator('#sign-in-form')).toBeVisible()
  // Once per tab: a reload goes straight to the form.
  await page.reload()
  await expect(page.locator('#sign-in-form')).toBeVisible()
  await expect(page.locator('#insecure')).toBeHidden()
})

// --- Milestone 5: your own settings and keys, Help -----------------------------

const nav = (page, name) => page.locator(`#pages a[data-page="${name}"]`).click()
const settingsRow = (page, path) => page.locator(`#settings-view [data-path="${path}"]`)
const myConfig = async (page) => (await page.request.get('/api/config')).json()

test('settings: your own feel and keys reach Help and your maps, and reset to default', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await signUp(page)
  await nav(page, 'settings')
  await expect(page).toHaveURL(/#settings$/)
  await expect(page).toHaveTitle('Settings — Pleiades')

  const sensitivity = settingsRow(page, 'flight.mouse_sensitivity')
  await expect(sensitivity.getByRole('button', { name: 'Reset to default' })).toHaveCount(0)
  await expect(page.locator('#settings-reset-all')).toBeDisabled()
  await expect(page.locator('.savebar'), 'nothing to save yet').toBeHidden()
  // A change undone by hand leaves nothing to save: the bar goes again.
  await page.locator('#mine-flight-invert_y').click()
  await expect(page.locator('.savebar')).toBeVisible()
  await page.locator('#mine-flight-invert_y').click()
  await expect(page.locator('.savebar')).toBeHidden()
  await sensitivity.locator('input[type="number"]').fill('2')
  await expect(sensitivity.getByRole('button', { name: 'Reset to default' })).toBeVisible()
  await sensitivity.locator('input[type="number"]').fill('1')
  await expect(page.locator('.savebar')).toBeHidden()
  await expect(sensitivity.getByRole('button', { name: 'Reset to default' })).toHaveCount(0)
  await sensitivity.locator('input[type="number"]').fill('2.5')

  // Heat on J instead of H.
  const heat = settingsRow(page, 'keybinds.heat')
  await heat.getByRole('button', { name: /^Add a key for/ }).click()
  await expect(heat.locator('.cap.listening')).toHaveText('Press a key')
  await page.keyboard.press('j')
  await heat.getByRole('button', { name: /^Remove H from/ }).click()
  await expect(heat.locator('.cap:not(.empty)')).toHaveText(['J'])
  await expect(page.locator('.savebar .state')).toHaveText('You have unsaved changes.')
  await page.locator('#settings-save').click()
  await expect(page.locator('.savebar .state')).toHaveText(/^Saved/)
  await expect(heat.getByRole('button', { name: 'Reset to default' })).toHaveAttribute('title', 'Default: H')

  // A key another action has while flying is refused, on its row.
  const balance = settingsRow(page, 'keybinds.balance')
  // Clicking a bound key replaces it.
  await balance.getByRole('button', { name: /^Balance the layout.*: B\. Change it/ }).click()
  await page.keyboard.press('j')
  await expect(balance.locator('.cap:not(.empty)')).toHaveText(['J'])
  await page.locator('#settings-save').click()
  await expect(balance.locator('.error')).toContainText('J clashes with connection heat')
  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(balance.locator('.cap:not(.empty)')).toHaveText(['B'])

  const config = await myConfig(page)
  expect(config.account).toBe(true)
  expect(config.flight.mouse_sensitivity).toBe(2.5)
  expect(config.keybinds.heat).toEqual(['J'])

  // Still there after a reload, and Help shows the key you have.
  await page.reload()
  await expect(settingsRow(page, 'flight.mouse_sensitivity').locator('input[type="number"]')).toHaveValue(
    '2.5',
  )
  await nav(page, 'help')
  await expect(page).toHaveTitle('Help — Pleiades')
  await expect(page.locator('#help-view [data-action="heat"] kbd')).toHaveText(['J'])
  await expect(page.locator('#help-view [data-action="search"] kbd')).toHaveText(['/', 'Ctrl/⌘+F'])

  // A map's own key list says J too.
  await nav(page, 'maps')
  await newMap(page, 'Keys')
  await expect(page.locator('#overlay .keys li', { hasText: 'connection heat' }).locator('kbd')).toHaveText(
    'J',
  )
  // The overlay itself only points at Help; the list waits behind `?`.
  await expect(page.locator('#overlay .keys')).toBeHidden()
  await expect(page.locator('#overlay .prompt-hint a')).toHaveAttribute('href', /account\.html#help$/)

  // Back to the default: the override is gone, not just set to H.
  const overrides = async () => (await (await page.request.get('/api/account/settings')).json()).overrides
  await page.goto('/account.html#settings')
  await settingsRow(page, 'keybinds.heat').getByRole('button', { name: 'Reset to default' }).click()
  await page.locator('#settings-save').click()
  await expect(page.locator('.savebar .state')).toHaveText(/^Saved/)
  expect(await overrides()).toEqual({ flight: { mouse_sensitivity: 2.5 } })
  expect((await myConfig(page)).keybinds.heat).toEqual(['H'])

  // Reset all: nothing of yours left.
  await page.locator('#settings-reset-all').click()
  await expect(settingsRow(page, 'flight.mouse_sensitivity').locator('input[type="number"]')).toHaveValue('1')
  await page.locator('#settings-save').click()
  await expect(page.locator('.savebar .state')).toHaveText(/^Saved/)
  expect(await overrides()).toEqual({})
  await expect(page.locator('#settings-reset-all')).toBeDisabled()
  // The one refused save above, which Chrome logs.
  expect(errors).toEqual([expect.stringContaining('status of 400')])
})

async function holdV(page, dx, dy) {
  await page.keyboard.down('v')
  await settle(page)
  await t(page, `look(${dx}, ${dy})`)
  await settle(page)
  return t(page, 'armed()')
}

test('signed in, a look picked with V is kept in the account and follows you', async ({ page, browser }) => {
  const errors = collectConsoleErrors(page)
  const username = await signUp(page)
  const id = await newMap(page, 'Looks')
  expect(await page.evaluate(() => document.documentElement.dataset.look)).toBe('deep-space')
  expect(await holdV(page, 60, 0)).toBe('Deep Sea')
  await page.keyboard.up('v')
  await settle(page, 500)
  expect(await page.evaluate(() => document.documentElement.dataset.look)).toBe('deep-sea')
  await expect
    .poll(async () => (await (await page.request.get('/api/account/settings')).json()).overrides)
    .toEqual({ visuals: { look: 'deep-sea' } })
  // Kept in the account, not in this browser.
  expect(await page.evaluate(() => localStorage.getItem('pleiades.look'))).toBeNull()

  await page.goto('/account.html#settings')
  await expect(page.locator('#mine-visuals-look')).toHaveValue('deep-sea')

  // Another browser, signed in as the same person, opens in Deep Sea.
  const other = await (await browser.newContext()).newPage()
  await signIn(other, username)
  await other.goto(`/?map=${id}`)
  await expect.poll(() => other.evaluate(() => document.documentElement.dataset.look)).toBe('deep-sea')
  expect(errors).toEqual([])
})

// --- Milestone 6: /admin → Accounts -------------------------------------------

// /admin isn't proxied by Vite; it's the Flask itself, on loopback.
async function openAdmin(browser) {
  const admin = await (await browser.newContext()).newPage()
  await admin.goto(`${API_ORIGIN}/admin`)
  await admin.locator('#sign-in-password').fill(ADMIN_PASSWORD)
  await admin.getByRole('button', { name: 'Sign in' }).click()
  await admin.getByRole('tab', { name: 'Accounts' }).click()
  return admin
}
const userRow = (admin, username) => admin.locator(`#users tr[data-user="${username}"]`)

test('admin resets a password: signed out, a new one chosen, the maps are all still there', async ({
  page,
  browser,
}) => {
  const username = await signUp(page)
  const id = await newMap(page, 'Kept through a reset')
  await page.goto('/account.html')

  const admin = await openAdmin(browser)
  // The accounts settings moved here from Settings, above the users.
  await expect(admin.locator('#accounts-settings')).toContainText('Open sign-up')
  const row = userRow(admin, username)
  await expect(row).toContainText('Active')
  await expect(row.locator('td').nth(3)).toHaveText('1')
  await row.getByRole('button', { name: 'Reset password' }).click()
  await admin.locator('.row-panel').getByRole('button', { name: 'Reset password' }).click()
  const temp = (await admin.locator('.row-panel code.temp').textContent()).trim()
  expect(temp).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3,}$/)
  await expect(row).toContainText('Reset, not yet changed')
  await expect(row).toContainText('signed out')

  // The open tab lost its session at once.
  await page.reload()
  await expect(page.locator('#sign-in-form')).toBeVisible()
  await page.locator('#sign-in-username').fill(username)
  await page.locator('#sign-in-password').fill(temp)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible()
  await expect(page.locator('#pages')).toBeHidden()
  await expect(page.locator('#sign-out')).toBeVisible()

  // Nothing else answers until it's done: a map link comes back here.
  await page.goto(`/?map=${id}`)
  await expect(page).toHaveURL(/account\.html$/)
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible()

  await page.locator('#must-change-password').fill(temp)
  await page.locator('#must-change-confirm').fill(temp)
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.locator('#must-change-error')).toContainText('other than the temporary one')
  await page.locator('#must-change-password').fill('my own again 1')
  await page.locator('#must-change-confirm').fill('my own again 1')
  await page.getByRole('button', { name: 'Save password' }).click()
  await expect(page.locator('#notice')).toHaveText('Password changed.')
  await expect(page.locator('#maps .map .name')).toHaveText(['Kept through a reset'])

  await admin.getByRole('button', { name: 'Done' }).click()
  await admin.getByRole('tab', { name: 'Status' }).click()
  await admin.getByRole('tab', { name: 'Accounts' }).click()
  await expect(row).toContainText('Active')
  await expect(row).toContainText('signed in on 1 device')

  await signIn(await (await browser.newContext()).newPage(), username, 'my own again 1')
})

test('admin disables, enables and deletes an account', async ({ page, browser }) => {
  const username = await signUp(page)
  await newMap(page, 'Going away')
  await page.goto('/account.html')

  const admin = await openAdmin(browser)
  const row = userRow(admin, username)
  await row.getByRole('button', { name: 'Disable' }).click()
  await expect(row).toContainText('Disabled')
  await expect(admin.locator('#toast')).toContainText('disabled and signed out')
  await page.reload()
  await expect(page.locator('#sign-in-form')).toBeVisible()
  await page.locator('#sign-in-username').fill(username)
  await page.locator('#sign-in-password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.locator('#sign-in-error')).toHaveText('Wrong username or password.')

  await row.getByRole('button', { name: 'Enable' }).click()
  await expect(row).toContainText('Active')
  await signIn(page, username)

  await row.getByRole('button', { name: 'Delete' }).click()
  const confirm = admin.locator('.row-panel')
  await expect(confirm).toContainText('1 map and their history')
  const yes = confirm.getByRole('button', { name: 'Delete for good' })
  await expect(yes).toBeDisabled()
  await confirm.getByRole('textbox').fill('not the name')
  await expect(yes).toBeDisabled()
  await confirm.getByRole('textbox').fill(username)
  await yes.click()
  await expect(row).toHaveCount(0)
  await page.reload()
  await expect(page.locator('#sign-in-form')).toBeVisible()
})

// --- Milestone 7: files in and out, and the Account page ---------------------------

const FIXTURES = new URL('../../fixtures/', import.meta.url)
const fixture = (name) => new URL(`${name}.atlasmap`, FIXTURES).pathname
const fixtureJson = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'))

test('upload map files into the list, download one back, and download everything', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await signUp(page)

  // No password: straight in, named after the file.
  await page.locator('#upload-input').setInputFiles(fixture('v2-no-password'))
  await expect(page.locator('#list-status')).toContainText('as “v2-no-password”')
  await expect(page.locator('#upload-form')).toBeHidden()

  // A password: asked for, a wrong one said beside it, then the right one.
  await page.locator('#upload-input').setInputFiles(fixture('v2-encrypted'))
  await expect(page.locator('#upload-what')).toHaveText('v2-encrypted.atlasmap has a password.')
  await page.locator('#upload-password').fill('not it')
  await page.locator('#upload-form').getByRole('button', { name: 'Upload' }).click()
  await expect(page.locator('#upload-error')).toContainText('Wrong password')
  await expect(page.locator('#who-name')).toBeVisible()
  await page.locator('#upload-password').fill('correct horse ✦ battery')
  await page.locator('#upload-form').getByRole('button', { name: 'Upload' }).click()
  await expect(page.locator('.map')).toHaveCount(2)
  const row = page.locator('.map').filter({ hasText: 'v2-encrypted' })
  const id = await row.getAttribute('data-id')
  expect((await serverMap(page, id)).payload).toEqual(fixtureJson('v2-encrypted'))

  // Not a map at all.
  await page.locator('#upload-input').setInputFiles({
    name: 'notes.plm',
    mimeType: 'text/plain',
    buffer: Buffer.from('just some text'),
  })
  await expect(page.locator('#list-error')).toContainText("isn't a Pleiades map file")

  // Back out as a file with no password: readable as is.
  await row.getByRole('button', { name: 'Download' }).click()
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    row.getByRole('button', { name: 'Download v2-encrypted.plm' }).click(),
  ])
  expect(file.suggestedFilename()).toBe('v2-encrypted.plm')
  const bytes = readFileSync(await file.path())
  expect([...bytes.subarray(0, 6)]).toEqual([0x41, 0x54, 0x4c, 0x4d, 2, 0])
  expect(JSON.parse(bytes.subarray(6).toString('utf8'))).toEqual(fixtureJson('v2-encrypted'))
  await expect(row.locator('.download')).toHaveCount(0)

  // With a password, it's encrypted (mode 1), and opens in the app with it.
  await row.getByRole('button', { name: 'Download' }).click()
  await row.getByPlaceholder('Password (optional)').fill('pw for the file')
  const [locked] = await Promise.all([
    page.waitForEvent('download'),
    row.getByRole('button', { name: 'Download v2-encrypted.plm' }).click(),
  ])
  expect([...readFileSync(await locked.path()).subarray(0, 6)]).toEqual([0x41, 0x54, 0x4c, 0x4d, 2, 1])

  // Everything, from Account.
  await page.getByRole('link', { name: 'Account' }).click()
  await expect(page.locator('#account-usage')).toContainText('2 maps')
  const [zip] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download all my data' }).click(),
  ])
  expect(zip.suggestedFilename()).toMatch(/^pleiades-e2e\w+-\d{4}-\d\d-\d\d\.zip$/)
  expect(
    readFileSync(await zip.path())
      .subarray(0, 2)
      .toString(),
  ).toBe('PK')
  expect(errors).toEqual([])
})

test('account: sign out elsewhere, change username and password, delete it all', async ({
  page,
  browser,
}) => {
  const username = await signUp(page)
  const elsewhere = await (await browser.newContext()).newPage()
  await signIn(elsewhere, username)

  await page.getByRole('link', { name: 'Account' }).click()
  await expect(page).toHaveTitle('Account — Pleiades')
  await expect(page.locator('#sessions-text')).toHaveText(
    "You're also signed in on 1 other browser or device.",
  )
  await page.getByRole('button', { name: 'Sign out everywhere else' }).click()
  await expect(page.locator('#sessions-text')).toContainText('Signed out 1 other session')
  await expect(page.getByRole('button', { name: 'Sign out everywhere else' })).toBeDisabled()
  await elsewhere.reload()
  await expect(elsewhere.locator('#sign-in-form')).toBeVisible()

  // A wrong password is said beside the form; nobody is signed out.
  const renamed = `${username}x`
  await page.locator('#username-new').fill(renamed)
  await page.locator('#username-password').fill('not it at all')
  await page.getByRole('button', { name: 'Change username' }).click()
  await expect(page.locator('#username-error')).toHaveText('Wrong current password.')
  await expect(page.locator('#who-name')).toHaveText(username)
  await page.locator('#username-password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Change username' }).click()
  await expect(page.locator('#username-done')).toContainText(`You sign in as ${renamed} now.`)
  await expect(page.locator('#who-name')).toHaveText(renamed)

  const NEW_PASSWORD = 'e2e password 2'
  await page.locator('#password-current').fill(PASSWORD)
  await page.locator('#password-new').fill(NEW_PASSWORD)
  await page.locator('#password-confirm').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.locator('#password-done')).toHaveText('Password changed.')
  await signIn(elsewhere, renamed, NEW_PASSWORD)

  await page.locator('#delete-password').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Delete my account' }).click()
  await expect(page.locator('#sign-in-form')).toBeVisible()
  await expect(page.locator('#notice')).toHaveText('Your account and its maps were deleted.')
  await elsewhere.reload()
  await expect(elsewhere.locator('#sign-in-form')).toBeVisible()
  await elsewhere.locator('#sign-in-username').fill(renamed)
  await elsewhere.locator('#sign-in-password').fill(NEW_PASSWORD)
  await elsewhere.getByRole('button', { name: 'Sign in' }).click()
  await expect(elsewhere.locator('#sign-in-error')).toHaveText('Wrong username or password.')
})
