/**
 * Folds the `.viewer-build/` output into one self-contained HTML template at
 * `server/static/viewer-template.html`.
 *
 * An exported map is opened by double-clicking it, so the file has to work from
 * `file://` with nothing beside it: no `/assets/` requests, no separate
 * stylesheet, no font files. This script inlines the script and the stylesheet,
 * turns every remaining `url()` into a data URI, and then **fails the build** if
 * any outward reference survives — a template that quietly reaches for a server
 * would only be discovered by whoever received the file.
 *
 * The three `__ATLASMAP_*__` markers are left in place for `files.js` to fill at
 * export time.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const frontend = resolve(here, '..')
const build = join(frontend, '.viewer-build')
const outFile = resolve(frontend, '../server/static/viewer-template.html')

const MIME = {
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

const fail = (message) => {
  console.error(`build-viewer: ${message}`)
  process.exit(1)
}

const entry = join(build, 'viewer.html')
if (!existsSync(entry)) fail(`no ${entry} — run the viewer vite build first`)
let html = readFileSync(entry, 'utf8')

/** `/assets/x.js`, `./assets/x.js` and `assets/x.js` all name the same file. */
const assetPath = (ref) => join(build, ref.replace(/^\.?\//, ''))

const scriptTag = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/)
const styleTag = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/)
if (!scriptTag) fail('no module script tag in the built viewer.html')

// `</script` and `</style` inside the code would end the tag early. Escaping the
// slash is safe: the sequence can only legally occur inside a string, a regex or
// a comment, and `<\/` means exactly `</` in all three.
const safeForTag = (text, tag) => text.replaceAll(`</${tag}`, `<\\/${tag}`)

let css = ''
if (styleTag) {
  css = readFileSync(assetPath(styleTag[1]), 'utf8')
  css = css.replace(/url\(\s*([^)]+?)\s*\)/g, (whole, raw) => {
    const ref = raw.replace(/^['"]|['"]$/g, '')
    if (ref.startsWith('data:')) return whole
    const file = assetPath(ref)
    if (!existsSync(file)) fail(`stylesheet references ${ref}, which is not in the build`)
    const ext = ref.split('.').pop().toLowerCase().split('?')[0]
    const mime = MIME[ext]
    if (!mime) fail(`no MIME type known for ${ref}`)
    return `url(data:${mime};base64,${readFileSync(file).toString('base64')})`
  })

  // @fontsource names a woff2 *and* a woff for every face, and the build inlines
  // both — about 76 kB of base64 per exported file for a fallback that cannot
  // ever be reached. Anything that can run WebGL2 reads woff2. The woff always
  // follows its woff2 inside one `src:` list, so this drops the alternative and
  // leaves the primary.
  const beforeStrip = css.length
  css = css.replace(/,\s*url\(data:font\/woff;base64,[^)]*\)\s*format\((["'])woff\1\)/g, '')
  if (css.length !== beforeStrip && !/format\((["'])woff2\1\)/.test(css)) {
    fail('dropped the woff fallbacks but no woff2 face survived')
  }
  if (css.length !== beforeStrip) {
    console.log(`build-viewer: dropped woff fallbacks, ${((beforeStrip - css.length) / 1024).toFixed(1)} kB saved`)
  }
}

const js = readFileSync(assetPath(scriptTag[1]), 'utf8')

// Replacement *functions*: the bundle is full of `$&` and `$'` sequences, which
// a string replacement would interpret as capture-group references.
if (styleTag) html = html.replace(styleTag[0], () => `<style>\n${safeForTag(css, 'style')}\n  </style>`)
html = html.replace(scriptTag[0], () => `<script type="module">\n${safeForTag(js, 'script')}\n  </script>`)

// A standalone file that still reaches outward is the one failure worth
// stopping the build for; it would look fine here and break on someone else's
// machine, offline.
for (const pattern of [/\bsrc="[^"]+"/g, /\bhref="[^"]+"/g, /\/assets\//g]) {
  const stray = html.match(pattern)
  if (stray) fail(`outward reference left in the template: ${stray.slice(0, 3).join(', ')}`)
}
for (const marker of ['__ATLASMAP_PAYLOAD__', '__ATLASMAP_TITLE__', '__ATLASMAP_SETTINGS__']) {
  if (!html.includes(marker)) fail(`${marker} was consumed by the build; files.js cannot fill it`)
}
// `import.meta.url` would resolve against the file:// path of whatever machine
// opens the export. Nothing should be using it once assets are inlined.
if (html.includes('import.meta')) {
  console.warn('build-viewer: WARNING — import.meta survives in the bundle; check it is not import.meta.url')
}

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, html)

const kb = (n) => `${(n / 1024).toFixed(1)} kB`
console.log(
  `build-viewer: viewer-template.html ${kb(Buffer.byteLength(html))} ` +
    `(js ${kb(js.length)}, css+fonts ${kb(css.length)})`
)
