// Post-build sanity check for CI (V2.md §2.7.5): both entry points exist and
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
