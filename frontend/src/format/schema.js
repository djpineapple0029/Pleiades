/**
 * The payload's shape version — what's *inside* the decrypted JSON. Separate
 * from the container's `VERSION` byte (`container.js`, `server/atlasfile.py`),
 * which is about crypto and framing only and never changes for a new field.
 * See `docs/FORMAT.md` for the rules this module enforces.
 *
 * DOM-free and three-free: the app, the viewer and Node tests all run it.
 */
import { version as APP_VERSION } from '../../package.json'

export const FORMAT = 'atlasmap'
export const CURRENT_SCHEMA = 1

// Keys the envelope owns. Everything else at the top level that isn't
// `nodes`/`edges`/`camera` is a later build's field, and is carried through.
export const ENVELOPE_KEYS = ['format', 'schema', 'app', 'modified']

/** Thrown when a payload can't be read as a map at all. */
export class PayloadError extends Error {}

// MIGRATIONS[n] turns a schema-n payload into schema n+1. Empty while there
// is only schema 1; a rename or restructure adds one here, never an in-place
// reinterpretation of an existing field.
const MIGRATIONS = {}

/**
 * Checks the envelope and brings an older payload up to `CURRENT_SCHEMA`.
 * Runs before anything is built from the payload, so a refusal commits
 * nothing. A payload without `schema` is schema 1 (every file before this
 * module existed). Returns a payload at the current schema; never mutates
 * its argument.
 */
export function migrate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PayloadError('Payload is not an object.')
  }
  if (payload.format !== undefined && payload.format !== FORMAT) {
    throw new PayloadError('This is not an AtlasMap map.')
  }
  const schema = payload.schema ?? 1
  if (!Number.isInteger(schema) || schema < 1) {
    throw new PayloadError('The map has an unreadable schema number.')
  }
  if (schema > CURRENT_SCHEMA) {
    throw new PayloadError(`This map was made by a newer AtlasMap (schema ${schema}). Update to open it.`)
  }
  let current = payload
  for (let n = schema; n < CURRENT_SCHEMA; n++) current = MIGRATIONS[n](current)
  return current
}

/** The envelope every payload this build writes starts with. */
export function envelope() {
  return { format: FORMAT, schema: CURRENT_SCHEMA, app: APP_VERSION }
}
