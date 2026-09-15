/**
 * Does a standalone .html on disk still support the three things the AtlasMap
 * viewer needs? Pointer lock (flight), WebGL2 (everything), and a data-URI
 * woff2 through document.fonts (labels.js waits on that before rastering).
 *
 * The identical page is run twice — file:// and http — so a failure in both
 * reads as the harness rather than as a file:// limitation.
 */
import { createRequire } from 'node:module'
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'

const require = createRequire('/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/5a026c05-ec34-4eca-a30b-6b84a52f43a3/scratchpad/')
const { chromium } = require('playwright')

// The installed playwright wants a browser revision that was never downloaded;
// drive whichever real Chromium this machine already has instead.
function candidates() {
  const out = []
  const cache = `${process.env.HOME}/Library/Caches/ms-playwright`
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).filter((n) => n.startsWith('chromium-')).sort().reverse()) {
      const base = `${cache}/${dir}/chrome-mac-arm64`
      if (!existsSync(base)) continue
      for (const app of readdirSync(base).filter((n) => n.endsWith('.app'))) {
        const macos = `${base}/${app}/Contents/MacOS`
        if (existsSync(macos)) for (const bin of readdirSync(macos)) out.push(`${macos}/${bin}`)
      }
    }
  }
  out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  out.push('/Applications/Chromium.app/Contents/MacOS/Chromium')
  return out.filter(existsSync)
}

const bins = candidates()
console.log('candidate browsers:')
for (const b of bins) console.log('  ', b)
if (!bins.length) { console.log('NO BROWSER FOUND'); process.exit(1) }

const woff2 = readFileSync('/Users/dempseypalmer/PycharmProjects/AtlasMap/frontend/node_modules/@fontsource/jost/files/jost-latin-400-normal.woff2').toString('base64')

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>@font-face{font-family:'JostTest';font-weight:400;src:url(data:font/woff2;base64,${woff2}) format('woff2');}</style>
</head><body style="margin:0">
<canvas id="c" width="64" height="64"></canvas>
<button id="b" style="width:240px;height:80px;font-size:20px">go</button>
<script type="module">window.__moduleRan = true</script>
<script>
window.__r = { moduleRan:null, gl2:null, font:null, fontCheck:null, lockEvent:null, lockError:null, promise:null, clicked:false };
try { var gl = document.getElementById('c').getContext('webgl2'); window.__r.gl2 = gl ? gl.getParameter(gl.VERSION) : 'null context' } catch(e){ window.__r.gl2 = 'throw: '+e.message }
document.fonts.load('16px JostTest').then(function(fs){ window.__r.font = 'faces:'+fs.length; window.__r.fontCheck = document.fonts.check('16px JostTest') })
  .catch(function(e){ window.__r.font = 'reject: '+e.message });
document.addEventListener('pointerlockchange', function(){ window.__r.lockEvent = document.pointerLockElement ? 'LOCKED' : 'unlocked' });
document.addEventListener('pointerlockerror', function(){ window.__r.lockError = 'pointerlockerror fired' });
document.getElementById('b').addEventListener('click', function(){
  window.__r.clicked = true;
  try {
    var p = document.body.requestPointerLock();
    if (p && p.then) p.then(function(){ window.__r.promise='resolved' }, function(e){ window.__r.promise='rejected: '+e.name+': '+e.message });
    else window.__r.promise = '(returned undefined, legacy API)';
  } catch(e) { window.__r.promise = 'threw: '+e.message }
});
</script></body></html>`

const dir = '/private/tmp/claude-501/-Users-dempseypalmer-PycharmProjects-AtlasMap/5432f80e-6e72-4451-9445-fa57a40f9a47/scratchpad'
writeFileSync(`${dir}/pltest.html`, HTML)
const server = createServer((_q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end(HTML) }).listen(5199)

let executablePath = null
for (const bin of bins) {
  try { const b = await chromium.launch({ headless: false, executablePath: bin }); await b.close(); executablePath = bin; break }
  catch (e) { console.log(`  (cannot launch ${bin.split('/').pop()}: ${String(e).split('\n')[0].slice(0, 80)})`) }
}
if (!executablePath) { console.log('NO LAUNCHABLE BROWSER'); server.close(); process.exit(1) }
console.log('using:', executablePath, '\n')

async function run(label, url) {
  const browser = await chromium.launch({ headless: false, executablePath })
  const page = await browser.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(url)
  await page.bringToFront()
  await page.click('#b')
  await page.waitForTimeout(2000)
  const r = await page.evaluate(() => ({ ...window.__r, moduleRan: window.__moduleRan === true }))
  console.log(`--- ${label} ---`)
  for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(11)} ${v}`)
  if (errs.length) console.log('  pageerror  ', errs.join(' | '))
  await browser.close()
  return r
}

const f = await run('file://', `file://${dir}/pltest.html`)
const h = await run('http', 'http://127.0.0.1:5199/')
server.close()

console.log('\n=== VERDICT ===')
console.log('pointer lock   file://', f.lockEvent, '  | http', h.lockEvent)
console.log('webgl2         file://', String(f.gl2).slice(0, 30), '| http', String(h.gl2).slice(0, 30))
console.log('data-URI font  file://', f.fontCheck, '  | http', h.fontCheck)
console.log('inline module  file://', f.moduleRan, '  | http', h.moduleRan)
