/**
 * Does a standalone .html on disk still support the three things the AtlasMap
 * viewer needs? Pointer lock (flight), WebGL2 (everything), and a data-URI
 * woff2 through document.fonts (labels.js waits on that before rastering).
 *
 * The identical page is run twice — file:// and http — so a failure in both
 * reads as the harness rather than as a file:// limitation.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const woff2 = readFileSync(
  fileURLToPath(new URL('../../node_modules/@fontsource/jost/files/jost-latin-400-normal.woff2', import.meta.url))
).toString('base64')

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

const dir = fileURLToPath(new URL('../../artifacts', import.meta.url))
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/pltest.html`, HTML)
const server = createServer((_q, s) => { s.writeHead(200, { 'Content-Type': 'text/html' }); s.end(HTML) }).listen(5199)

async function run(label, url) {
  const browser = await chromium.launch({ headless: false })
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
