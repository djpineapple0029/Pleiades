/**
 * `.atlasmap` files: assembling the payload, saving/opening, and the
 * browser's own file dialogs. Plus the standalone `.html` export.
 *
 * There is no server-side folder — the user owns the file's location entirely.
 * Saving is a download, opening is an upload.
 *
 * **Crypto happens here, not on the server, whenever the page is a secure
 * context** (`cryptoAvailable()` — localhost or HTTPS): `save`/`open` call
 * `format/container.js` directly, so the password and the plaintext map never
 * leave the tab, and there's no network round trip either. Only when the page
 * is plain-HTTP-over-LAN (no `crypto.subtle`) do these fall back to POSTing to
 * `/api/save`/`/api/open`, exactly as v1 always did — same server, same
 * endpoints, just now writing/reading the v2 container so a blank password
 * still works from there too. Either way the password lives only in the
 * closure below for the length of the session.
 */
import { cryptoAvailable, peekHeader, readContainer, writeContainer, ContainerPasswordError } from './format/container.js'

const SUFFIX = '.atlasmap'
const DEFAULT_FILENAME = `map${SUFFIX}`
// Revoking the object URL in the same task can cancel the download it was
// created for; one turn of the event loop is enough for the click to take it.
const REVOKE_DELAY_MS = 1000

// The built read-only viewer, with two holes in it. Written by
// `frontend/scripts/build-viewer.mjs`; served by Flask from server/static, and
// proxied through in dev so Ctrl+E works there too.
const VIEWER_TEMPLATE = '/viewer-template.html'
const PAYLOAD_MARK = '__ATLASMAP_PAYLOAD__'
const TITLE_MARK = '__ATLASMAP_TITLE__'

/** The `error` a failed endpoint reports, or something honest about the status. */
async function errorFrom(response) {
  try {
    const body = await response.json()
    if (typeof body?.error === 'string' && body.error) return body.error
  } catch {
    // Not JSON — a proxy or the dev server answered instead of Flask.
  }
  return `server returned ${response.status}`
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function createFiles({ graph, view, camera, physics }) {
  let password = null
  let filename = DEFAULT_FILENAME
  // The graph.contentRevision as of the last successful save or open (or a
  // fresh New map) — a freshly constructed, untouched graph starts clean.
  let savedRevision = graph.contentRevision

  function cameraBlock() {
    return {
      position: camera.position.toArray(),
      // The camera's own euler order, whatever it is, on the way out and on
      // the way back in — so the pair round-trips without a conversion.
      rotation: [camera.rotation.x, camera.rotation.y, camera.rotation.z],
    }
  }

  function toPayload() {
    return { ...graph.toPayload(), camera: cameraBlock() }
  }

  const isTriple = (value) =>
    Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite)

  /** A camera block is a convenience, not part of the graph — skip a bad one. */
  function restoreCamera(saved) {
    if (!saved || typeof saved !== 'object') return
    if (isTriple(saved.position)) camera.position.fromArray(saved.position)
    if (isTriple(saved.rotation)) camera.rotation.set(...saved.rotation.slice(0, 3))
  }

  /** Swaps in a decrypted payload. Throws `PayloadError` if it is not a graph. */
  function applyPayload(payload) {
    graph.load(payload)
    // Before the view syncs: bodies keyed by an id the new file happens to
    // reuse would otherwise hand their old velocity to a different node.
    physics.reset()
    view.sync()
    restoreCamera(payload.camera)
    savedRevision = graph.contentRevision
  }

  /**
   * Encrypts (or, with a blank password, just frames) the current graph and
   * downloads it. Local and network-free in a secure context; otherwise the
   * same server round trip v1 always used, now writing v2 there too.
   */
  async function save() {
    // Read before the async work starts: saving doesn't pause editing, and a
    // Balance run keeps moving nodes while this is in flight. Those changes
    // must still leave the map dirty afterward, so only the revision as it
    // stood *at the request* counts as saved.
    const revisionAtSave = graph.contentRevision
    if (cryptoAvailable()) {
      try {
        const blob = await writeContainer(toPayload(), password ?? '')
        triggerDownload(new Blob([blob], { type: 'application/octet-stream' }), filename)
        savedRevision = revisionAtSave
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error.message || 'could not encrypt the file' }
      }
    }
    try {
      const response = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password ?? '', filename, payload: toPayload() }),
      })
      if (!response.ok) return { ok: false, error: await errorFrom(response) }
      triggerDownload(await response.blob(), filename)
      savedRevision = revisionAtSave
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error.message || 'could not reach the server' }
    }
  }

  /**
   * Peeks a file's header without reading a password or touching the
   * network — cheap enough to call before ever showing a password prompt.
   * A v2 file with no encryption reports `needsPassword: false`; everything
   * else (v1, or v2 that is actually encrypted) reports `true`. Returns
   * `null` if the bytes don't look like an `.atlasmap` file at all, so the
   * caller can fall through to its normal "wrong file" handling.
   */
  async function probe(file) {
    // The largest header either version reads before it knows more is v2's
    // fixed-size crypto header; anything shorter is definitely just a magic
    // + version + mode (or too short to be a file at all).
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer())
    try {
      const { version, mode } = peekHeader(head)
      return { needsPassword: !(version === 2 && mode === 0) }
    } catch (error) {
      return null
    }
  }

  /**
   * Reads and, if it holds a graph, swaps in a file. Local and network-free
   * whenever possible: a v2 no-password file never needs a password *or* the
   * network, and a secure context reads anything else locally too. Only an
   * insecure context falls back to `/api/open`. `wrongPassword` separates the
   * one failure worth re-prompting for.
   */
  async function open(file, attempt) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const secretRequired = (await probe(file))?.needsPassword ?? true

    if (!secretRequired || cryptoAvailable()) {
      try {
        applyPayload(await readContainer(bytes, attempt))
      } catch (error) {
        if (error instanceof ContainerPasswordError) return { ok: false, wrongPassword: true, error: error.message }
        return { ok: false, error: error.message || 'the file does not hold a graph' }
      }
      password = attempt
      filename = file.name.endsWith(SUFFIX) ? file.name : `${file.name}${SUFFIX}`
      return { ok: true }
    }

    const form = new FormData()
    form.append('file', file, file.name)
    form.append('password', attempt)

    let response
    try {
      response = await fetch('/api/open', { method: 'POST', body: form })
    } catch (error) {
      return { ok: false, error: error.message || 'could not reach the server' }
    }
    if (response.status === 401) return { ok: false, wrongPassword: true, error: await errorFrom(response) }
    if (!response.ok) return { ok: false, error: await errorFrom(response) }

    try {
      applyPayload(await response.json())
    } catch (error) {
      return { ok: false, error: error.message || 'the file does not hold a graph' }
    }
    // Only now: these are the credentials that actually opened something.
    password = attempt
    filename = file.name.endsWith(SUFFIX) ? file.name : `${file.name}${SUFFIX}`
    return { ok: true }
  }

  /**
   * What goes into an exported file. The graph as saved, minus `notes`.
   *
   * **Notes are deliberately dropped.** An export carries no password, so its
   * contents are readable in a text editor by anyone who has the file, and the
   * viewer has no editor panel to show notes in anyway. Shipping private
   * working text inside a map meant for sharing is the wrong default; the
   * `.atlasmap` file remains the thing that keeps everything.
   */
  function exportPayload() {
    const { nodes, edges } = graph.toPayload()
    return {
      nodes: nodes.map(({ notes, ...rest }) => rest),
      edges,
      camera: cameraBlock(),
    }
  }

  /**
   * Writes the map as a standalone, view-only `.html`: the viewer bundle with
   * the graph spliced into it. No password, no server, and no editing — the
   * code that could change a graph is not in that bundle at all.
   */
  async function exportHtml() {
    const base = filename.endsWith(SUFFIX) ? filename.slice(0, -SUFFIX.length) : filename
    const name = `${base}.html`

    let template
    try {
      const response = await fetch(VIEWER_TEMPLATE)
      if (!response.ok) return { ok: false, error: await errorFrom(response) }
      template = await response.text()
    } catch (error) {
      return { ok: false, error: error.message || 'could not reach the server' }
    }
    if (!template.includes(PAYLOAD_MARK)) {
      return { ok: false, error: 'the viewer template is missing; rebuild the frontend' }
    }

    // `<` is the only character that can end the JSON's script tag early;
    // escaped as `<` it is the same string to any JSON parser.
    const json = JSON.stringify(exportPayload()).replaceAll('<', '\\u003c')
    // Replacement *functions*, because both the JSON and the title can contain
    // `$&` and friends, which a string replacement would read as backreferences.
    const html = template.replace(TITLE_MARK, () => escapeHtml(base)).replace(PAYLOAD_MARK, () => json)

    triggerDownload(new Blob([html], { type: 'text/html' }), name)
    return { ok: true, filename: name }
  }

  /**
   * The browser's own file picker. Resolves with the chosen file, or null if
   * the dialog was dismissed. Taking pointer lock back is the caller's problem
   * — the dialog is a native window and the browser drops the lock to show it.
   */
  function pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = SUFFIX
      const settle = (value) => {
        input.remove()
        resolve(value)
      }
      input.addEventListener('change', () => settle(input.files?.[0] ?? null), { once: true })
      input.addEventListener('cancel', () => settle(null), { once: true })
      input.style.display = 'none'
      document.body.append(input)
      input.click()
    })
  }

  return {
    save,
    open,
    probe,
    exportHtml,
    pickFile,
    applyPayload,
    toPayload,
    setCredentials(nextPassword, nextFilename) {
      // `''` is a real, deliberate credential (a file saved with no
      // password) — distinct from `null`, "nothing has been set up yet".
      password = nextPassword ?? ''
      const trimmed = (nextFilename ?? '').trim()
      filename = !trimmed ? DEFAULT_FILENAME : trimmed.endsWith(SUFFIX) ? trimmed : `${trimmed}${SUFFIX}`
    },
    /** Forgets password and filename — used when New map starts a fresh document. */
    clearCredentials() {
      password = null
      filename = DEFAULT_FILENAME
    },
    /** Re-baselines the dirty check against the graph's current content
     *  revision, without a save or open — New map's "this is now clean". */
    reset() {
      savedRevision = graph.contentRevision
    },
    /** Same mechanism as `reset`, distinct name for the post-save/open call site. */
    markClean() {
      savedRevision = graph.contentRevision
    },
    /** Whether the graph holds changes since the last successful save, open, or New map. */
    get isDirty() {
      return graph.contentRevision !== savedRevision
    },
    /** Whether credentials have been established at all — even a blank password counts. */
    get hasCredentials() {
      return password !== null
    },
    get filename() {
      return filename
    },
  }
}
