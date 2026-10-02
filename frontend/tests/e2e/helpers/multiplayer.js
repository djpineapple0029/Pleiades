/**
 * The multiplayer suite's moves (tests/e2e/multiplayer): accounts and maps
 * made through the API, maps opened in the real app, and its edits driven
 * through the dev-only `window.__pleiades` seam (main.js).
 */
import { expect } from '@playwright/test'
import { installGestures } from './gestures.js'
import { ADMIN_PASSWORD } from '../../../playwright.multiplayer.config.js'

const CSRF = { 'X-Pleiades': '1' }
export const PASSWORD = 'e2e password 1'
let counter = 0

/** A fresh username, unique within a run (the database outlives each test). */
export const freshName = (prefix) => `${prefix}${Date.now().toString(36)}${counter++}`

/** Signs this page's browser context up (and in) as `name`. */
export async function signUp(page, name) {
  const response = await page.request.post('/api/auth/signup', {
    headers: CSRF,
    data: { username: name, password: PASSWORD },
  })
  expect(response.status(), await response.text()).toBe(201)
  return name
}

export async function createMap(page, name) {
  const response = await page.request.post('/api/maps', { headers: CSRF, data: { name } })
  expect(response.status()).toBe(201)
  return (await response.json()).id
}

export async function shareWith(page, mapId, username, role) {
  const response = await page.request.post(`/api/maps/${mapId}/members`, {
    headers: CSRF,
    data: { username, role },
  })
  expect(response.status(), await response.text()).toBe(201)
}

/** Opens the map in the app and waits until its room has it. */
export async function openMap(page, mapId) {
  await page.goto(`/?map=${mapId}`)
  await expect
    .poll(() => page.evaluate(() => window.__pleiades?.room?.state ?? null), { timeout: 30_000 })
    .toMatch(/^(live|read_only)$/)
  await installGestures(page)
}

/** True once `page`'s graph has this star. */
export const hasNode = (page, id) =>
  page.evaluate((nodeId) => Boolean(window.__pleiades.graph.getNode(nodeId)), id)

/** Makes (or replaces) the map's share link as `page`; returns its absolute URL. */
export async function makeLink(page, mapId, role = 'viewer', days = null) {
  const response = await page.request.post(`/api/maps/${mapId}/link`, {
    headers: CSRF,
    data: { role, expires_in_days: days },
  })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json()).url // `/s/<token>`, under the app's base
}

/** A signed-out page opens a share link, types a name, and waits for the room. */
export async function joinAsGuest(page, linkPath, name) {
  await page.goto(linkPath)
  const field = page.locator('#editor .editor-row input')
  await expect(field).toBeVisible({ timeout: 30_000 })
  await field.fill(name)
  await page.locator('#editor').getByRole('button', { name: 'Join' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__pleiades?.room?.state ?? null), { timeout: 30_000 })
    .toMatch(/^(live|read_only)$/)
  await installGestures(page)
}

/** Signs in to /admin and saves the sharing switches given, keeping every other value. */
export async function adminSharing(page, sharing) {
  const login = await page.request.post('/api/admin/login', { data: { password: ADMIN_PASSWORD } })
  expect(login.status(), await login.text()).toBe(200)
  const headers = { Authorization: `Bearer ${(await login.json()).token}` }
  const { values } = await (await page.request.get('/api/admin/config', { headers })).json()
  values.sharing = { ...values.sharing, ...sharing }
  const saved = await page.request.put('/api/admin/config', { headers, data: values })
  expect(saved.status(), await saved.text()).toBe(200)
}
