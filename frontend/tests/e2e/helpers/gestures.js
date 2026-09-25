/**
 * Shared harness pieces the rescued e2e suites each reinvented separately
 * (V2.md §2.7.1): a faked pointer lock for chrome-headless-shell (which
 * cannot take a real one), rAF-synced settling, console-error collection,
 * and the radial-menu gesture helpers `e2e_app.mjs` originally defined
 * inline as `window.__t`.
 */

/** Ignore the one warning SwiftShader spams on every readback. */
export function collectConsoleErrors(page) {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('ReadPixels')) {
      errors.push(`${m.type()}: ${m.text()}`)
    }
  })
  return errors
}

/**
 * Fakes `document.pointerLockElement` and wires up the gesture helpers the
 * app's own input handlers read: mouse look/click, the radial menu's
 * right-hold, and the wedge labels. Switchable rather than always-on, so
 * Tab into the overview really does release the lock and Tab back really
 * does ask for it again.
 */
export async function installGestures(page, canvasId = 'viewport') {
  await page.evaluate((canvasId) => {
    const canvas = document.getElementById(canvasId)
    let locked = true
    Object.defineProperty(document, 'pointerLockElement', { get: () => (locked ? canvas : null), configurable: true })
    canvas.requestPointerLock = () => { locked = true; document.dispatchEvent(new Event('pointerlockchange')) }
    document.exitPointerLock = () => { locked = false; document.dispatchEvent(new Event('pointerlockchange')) }
    document.dispatchEvent(new Event('pointerlockchange'))
    const fire = (type, init) => canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
    window.__t = {
      hud: () => document.getElementById('hud').textContent,
      locked: () => locked,
      overlay: () => !document.getElementById('overlay').hidden,
      crosshair: () => !document.getElementById('crosshair').hidden,
      look: (dx, dy) => document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: dx, movementY: dy })),
      doubleClick: () => { fire('mousedown', { button: 0, buttons: 1 }); fire('mouseup', { button: 0 }); fire('mousedown', { button: 0, buttons: 1 }); fire('mouseup', { button: 0 }) },
      click: () => { fire('mousedown', { button: 0, buttons: 1 }); fire('mouseup', { button: 0 }) },
      rightDown: () => fire('mousedown', { button: 2, buttons: 2 }),
      rightUp: () => fire('mouseup', { button: 2 }),
      // main.js's requestLock listens for a real `click` event, which two
      // separately dispatched mousedown/mouseup events do not synthesize —
      // only a genuine click (or canvas.click()) does. Panels the app opens
      // itself take the lock back on their own (pointerLock.js); this is for
      // after an unlock the user caused, e.g. Esc — see `escape()`.
      relock: () => fire('click', {}),
      // What the browser does on a real Esc under pointer lock: drops it
      // without the page asking. A faked lock never sees that on its own.
      escape: () => document.exitPointerLock(),
      wedges: () => [...document.querySelectorAll('#radial-menu .wedge text')].map((t) => t.textContent),
      armed: () => document.querySelector('#radial-menu .wedge.armed text')?.textContent ?? null,
    }
  }, canvasId)
}

/** Runs a `window.__t.<expr>` call installed by `installGestures`. */
export const t = (page, expr) => page.evaluate((e) => new Function('return window.__t.' + e)(), expr)

/**
 * SwiftShader draws the stars on the CPU and a frame can take longer than
 * any fixed wait, so wait for frames: after `n`, the app's loop has raycast
 * the crosshair and rewritten the HUD at least once since the last input.
 */
export const frames = (page, n = 3) => page.evaluate((n) => new Promise((done) => {
  const step = (left) => (left ? requestAnimationFrame(() => step(left - 1)) : done())
  step(n)
}), n)

export const settle = async (page, ms = 0) => {
  await frames(page)
  if (ms) await page.waitForTimeout(ms)
  await frames(page)
}

/** Right-hold, look toward a wedge, release — as the radial menu is driven. */
export async function pickMenu(page, dx, dy) {
  await t(page, 'rightDown()')
  await settle(page)
  const labels = await t(page, 'wedges()')
  await t(page, `look(${dx}, ${dy})`)
  await settle(page)
  const armed = await t(page, 'armed()')
  await t(page, 'rightUp()')
  await settle(page)
  return { labels, armed }
}

/**
 * `page.evaluate` runs outside Vite, so a bare `import 'three'` will not
 * resolve there. Lifts the rewritten specifier Vite gave `graphView.js` out
 * of the transformed source instead of hard-coding a `/node_modules/.vite/
 * deps/three.js` path, which changes across Vite upgrades (V2.md §2.7.1).
 * Pass the result into `page.evaluate(fn, { threeUrl })` and
 * `await import(threeUrl)` inside the browser.
 */
export async function threeModuleUrl(page) {
  return page.evaluate(async () => {
    const transformed = await (await fetch('/src/graphView.js')).text()
    return transformed.match(/["']([^"']*deps\/three\.js[^"']*)["']/)[1]
  })
}
