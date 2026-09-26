// Accounts, milestone 2 (USERS.md): sign-up in the account shell, the map
// list, opening a server map, autosave, Ctrl+S, back to the list, and the
// safety rails around them (a second tab never overwrites, signed-out goes
// to sign-in). Runs against a Flask of its own (playwright.accounts.config.js).
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, installGestures, pickMenu, settle, t } from '../helpers/gestures.js'

const PASSWORD = 'e2e password 1'
let counter = 0
// One account per test: the database outlives each test within a run.
const freshName = () => `e2e${Date.now().toString(36)}${counter++}`

async function signUp(page, username = freshName()) {
  await page.goto('/')
  await expect(page).toHaveURL(/account\.html$/)
  await page.getByRole('tab', { name: 'Create account' }).click()
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
const serverMap = async (page, id) => (await page.request.get(`/api/maps/${id}`)).json()

test('sign up, make a map, and it saves itself', async ({ page }) => {
  const errors = collectConsoleErrors(page)
  await signUp(page)
  await expect(page.locator('#empty')).toBeVisible()

  const id = await newMap(page, 'Orion')
  expect(await page.title()).toBe('Orion — AtlasMap')
  await expect.poll(() => hud(page)).toContain('Orion · saved · 0 nodes')

  await t(page, 'doubleClick()')
  await settle(page)
  // Off the new star, so the HUD shows the map rather than describing it.
  await t(page, 'look(300, 0)')
  await settle(page)
  expect(await hud(page)).toMatch(/unsaved|saving/)
  expect(await page.title()).toBe('• Orion — AtlasMap')
  // Nothing goes out before the debounce...
  expect((await serverMap(page, id)).payload.nodes).toHaveLength(0)
  // ...and then it does, with no keypress.
  await expect.poll(() => hud(page), { timeout: 15_000 }).toContain('Orion · saved · 1 nodes')
  const saved = await serverMap(page, id)
  expect(saved.payload.nodes).toHaveLength(1)
  expect(saved.revision).toBe(2)
  expect(await page.title()).toBe('Orion — AtlasMap')

  // A reload opens what was saved.
  await page.reload()
  await page.waitForTimeout(1500)
  await expect.poll(() => page.locator('#hud').textContent()).toContain('Orion · saved · 1 nodes')
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

test('a second tab never overwrites the first', async ({ page, context }) => {
  await signUp(page)
  const id = await newMap(page, 'Twins')
  const other = await context.newPage()
  await other.goto(`/?map=${id}`)
  await other.waitForTimeout(1500)
  await installGestures(other)

  await t(page, 'doubleClick()')
  await settle(page)
  await page.keyboard.press('ControlOrMeta+s')
  await expect.poll(async () => (await serverMap(page, id)).revision).toBe(2)

  // The other tab still thinks it's on revision 1.
  await t(other, 'look(300, 0)')
  await settle(other)
  await t(other, 'doubleClick()')
  await settle(other)
  await other.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => t(other, 'hud()')).toContain('changed in another tab or device')
  const stored = await serverMap(page, id)
  expect(stored.revision).toBe(2)
  expect(stored.payload.nodes).toHaveLength(1)
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
  await fresh.locator('#sign-in-password').fill(PASSWORD)
  await fresh.getByRole('button', { name: 'Sign in' }).click()
  await expect(fresh.locator('#who-name')).toHaveText(username)
})

test('?local is the classic app, even with accounts on', async ({ page }) => {
  await page.goto('/?local')
  await page.waitForTimeout(1500)
  expect(page.url()).toMatch(/\?local$/)
  await installGestures(page)
  expect(await hud(page)).toContain('map.atlasmap')
  const menu = await pickMenu(page, 0, -60)
  expect(menu.labels[0]).toBe('New')
})
