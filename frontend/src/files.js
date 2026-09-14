/**
 * `.atlasmap` files: assembling the payload, the two API calls, and the
 * browser's own save/open dialogs. Plus the standalone `.html` export.
 *
 * There is no server-side folder — the user owns the file's location entirely.
 * Saving is a download, opening is an upload, and the password lives in the
 * closure below for the length of the session and goes nowhere but these two
 * endpoints.
 */

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
  }

  /** Posts the current graph and downloads what comes back. */
  async function save() {
    try {
      const response = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, filename, payload: toPayload() }),
      })
      if (!response.ok) return { ok: false, error: await errorFrom(response) }
      triggerDownload(await response.blob(), filename)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error.message || 'could not reach the server' }
    }
  }

  /**
   * Uploads a file to be decrypted and, if it holds a graph, swaps it in.
   * `wrongPassword` separates the one failure worth re-prompting for.
   */
  async function open(file, attempt) {
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
    exportHtml,
    pickFile,
    applyPayload,
    toPayload,
    setCredentials(nextPassword, nextFilename) {
      password = nextPassword
      const trimmed = (nextFilename ?? '').trim()
      filename = !trimmed ? DEFAULT_FILENAME : trimmed.endsWith(SUFFIX) ? trimmed : `${trimmed}${SUFFIX}`
    },
    get hasPassword() {
      return password !== null
    },
    get filename() {
      return filename
    },
  }
}
