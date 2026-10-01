// Post-build sanity check for CI (V2.md §2.7.5): every entry point exists and
// nothing has ballooned. Budgets sit ~25% above the sizes on 2026-09-25
// (app JS 800 kB, viewer template 693 kB); raise them on purpose, not by drift.
// The viewer module-graph guard belongs to §2.4.6 and isn't built yet.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const STATIC = new URL('../../server/static/', import.meta.url).pathname
const KB = 1024
const BUDGETS = [
  { label: 'index.html', match: /^index\.html$/, dir: '', max: 8 * KB },
  { label: 'viewer-template.html', match: /^viewer-template\.html$/, dir: '', max: 875 * KB },
  { label: 'app JS', match: /^index-.*\.js$/, dir: 'assets', max: 1000 * KB },
  { label: 'app CSS', match: /^index-.*\.css$/, dir: 'assets', max: 16 * KB },
  // The account shell must stay small: no three, no scene code.
  // Milestone 7's Account page is static markup in it: 11.1 kB then.
  { label: 'account.html', match: /^account\.html$/, dir: '', max: 14 * KB },
  // Settings and Help (2026-09-30) brought in the schema, keymap and looks,
  // and set those pages in Jost (its @font-face rules are most of the CSS):
  // JS 20.3 kB, CSS 10 kB then. Upload, download and the Account page
  // (milestone 7, 2026-09-30): JS 31.5 kB.
  { label: 'account JS', match: /^account-.*\.js$/, dir: 'assets', max: 38 * KB },
  { label: 'account CSS', match: /^account-.*\.css$/, dir: 'assets', max: 14 * KB },
  // three, split out of the app on 2026-09-30 so the homepage's hero shares it
  // (530 kB then; the app JS above dropped by the same amount).
  { label: 'three chunk', match: /^three-.*\.js$/, dir: 'assets', max: 680 * KB },
  // The homepage: its own code is small; the hero borrows the three chunk.
  { label: 'home.html', match: /^home\.html$/, dir: '', max: 24 * KB },
  { label: 'home JS', match: /^home-.*\.js$/, dir: 'assets', max: 16 * KB },
  { label: 'home CSS', match: /^home-.*\.css$/, dir: 'assets', max: 16 * KB },
]

let failed = false
for (const { label, match, dir, max } of BUDGETS) {
  const where = join(STATIC, dir)
  const hits = existsSync(where) ? readdirSync(where).filter((f) => match.test(f)) : []
  if (hits.length !== 1) {
    console.error(`✗ ${label}: expected one file in server/static/${dir}, found ${hits.length}`)
    failed = true
    continue
  }
  const size = statSync(join(where, hits[0])).size
  const ok = size <= max
  if (!ok) failed = true
  console.log(`${ok ? '✓' : '✗'} ${label}: ${(size / KB).toFixed(1)} kB (budget ${max / KB} kB)`)
}
process.exit(failed ? 1 : 0)
