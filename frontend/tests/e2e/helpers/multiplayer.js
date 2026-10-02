/**
 * The multiplayer suite's moves (tests/e2e/multiplayer): accounts and maps
 * made through the API, maps opened in the real app, and its edits driven
 * through the dev-only `window.__pleiades` seam (main.js).
 */
import { expect } from '@playwright/test'
import { installGestures } from './gestures.js'

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
