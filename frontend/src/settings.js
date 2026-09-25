/**
 * The server's keybinds and client settings (edited at /admin), with the
 * schema's defaults for anything missing, wrong or unreachable.
 *
 * The app fetches them from `/api/config` once at startup. An exported map
 * carries a copy spliced in at export time (`#atlasmap-settings`), since it
 * opens from `file://` with no server at all. Either way a failure means
 * defaults, never a broken start.
 */

import schema from '../../server/settings_schema.json'
import { defaultKeybinds } from './keymap.js'

const FETCH_TIMEOUT_MS = 3000
const CLIENT = schema.settings.filter((spec) => spec.scope === 'client')

export function defaultSettings() {
  const out = { keybinds: defaultKeybinds() }
  for (const spec of CLIENT) (out[spec.section] ??= {})[spec.key] = spec.default
  return out
}

function valid(spec, value) {
  if (spec.type === 'boolean') return typeof value === 'boolean'
  return typeof value === 'number' && Number.isFinite(value) && value >= spec.min && value <= spec.max
}

/** Takes whatever arrived and keeps only what the schema allows. */
export function mergeSettings(raw) {
  const out = defaultSettings()
  if (!raw || typeof raw !== 'object') return out
  for (const spec of CLIENT) {
    const value = raw[spec.section]?.[spec.key]
    if (valid(spec, value)) out[spec.section][spec.key] = value
  }
  const binds = raw.keybinds
  if (binds && typeof binds === 'object') {
    for (const id of Object.keys(out.keybinds)) {
      const list = binds[id]
      if (Array.isArray(list) && list.every((chord) => typeof chord === 'string')) out.keybinds[id] = list
    }
  }
  return out
}

export async function fetchSettings(url) {
  // The e2e server pins defaults, so a customised config on a dev backend
  // can't change the keys a test presses (see playwright.config.js).
  if (import.meta.env?.VITE_ATLASMAP_SETTINGS === 'defaults') return defaultSettings()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) return defaultSettings()
    return mergeSettings(await response.json())
  } catch {
    return defaultSettings()
  } finally {
    clearTimeout(timer)
  }
}

/** For the viewer: the copy spliced into the exported page, if it's there. */
export function readEmbeddedSettings(id = 'atlasmap-settings') {
  const text = document.getElementById(id)?.textContent?.trim()
  if (!text) return defaultSettings()
  try {
    return mergeSettings(JSON.parse(text))
  } catch {
    // The unexported template still holds its placeholder, which isn't JSON.
    return defaultSettings()
  }
}
