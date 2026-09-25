// Renaming in place (Enter), notes in the sidebar (Ctrl/Cmd+Enter, N), and the
// pointer lock coming back by itself after panels the app opened. Pointer
// lock is faked (helpers/gestures.js), so "comes back" means the app asked
// for it; tests/e2e/headed-lock covers a real browser granting it.
import { test, expect } from '@playwright/test'
import { collectConsoleErrors, installGestures, t, settle } from '../helpers/gestures.js'

const state = (page) =>
  page.evaluate(() => {
    const aside = document.getElementById('notes-sidebar')
    return {
      overlay: !document.getElementById('overlay').hidden,
      pill: !document.getElementById('resume-pill').hidden,
      editor: !document.getElementById('editor').hidden,
      sidebar: !aside.hidden,
      sidebarEditing: aside.classList.contains('notes-sidebar--editing'),
      sidebarTitle: aside.querySelector('.notes-title')?.textContent ?? '',
      sidebarBody: aside.querySelector('.notes-body')?.textContent ?? '',
      focus: document.activeElement?.className ?? '',
    }
  })

test('rename in place, notes sidebar, automatic relock', async ({ page }, testInfo) => {
  const errors = collectConsoleErrors(page)
  await page.goto('/')
  await page.waitForTimeout(1500)
  await installGestures(page)

  await t(page, 'doubleClick()')
  await settle(page)
  expect.soft((await t(page, 'hud()')).startsWith('node n1'), 'aimed at the new node').toBe(true)

  // --- Enter: rename in place, lock kept throughout ---
  await page.keyboard.press('Enter')
  await settle(page)
  let s = await state(page)
  expect.soft(s.focus, 'hidden title field focused').toContain('title-edit-input')
  expect.soft(s.editor, 'no centred panel').toBe(false)
  expect.soft(await t(page, 'locked()'), 'still locked while typing').toBe(true)
  await page.keyboard.type('Vega')
  await page.keyboard.press('Enter')
  await settle(page, 200)
  expect.soft(await t(page, 'locked()'), 'still locked after Enter').toBe(true)
  expect.soft(await t(page, 'hud()'), 'renamed').toBe('node Vega · 0 links')

  // WASD while typing goes to the text, not the camera.
  await page.keyboard.press('Enter')
  await settle(page)
  await page.keyboard.type('wasd')
  await settle(page)
  // --- Esc: discards the text; the browser drops the lock → full key list ---
  await page.keyboard.press('Escape')
  await t(page, 'escape()')
  await settle(page, 200)
  s = await state(page)
  expect.soft(s.overlay, 'Esc brings the full key list').toBe(true)
  await t(page, 'relock()')
  await settle(page)
  expect
    .soft(await t(page, 'hud()'), 'Esc discarded the text, and typing wasd did not fly')
    .toBe('node Vega · 0 links')

  // --- Ctrl+Enter: notes with a real cursor ---
  await page.keyboard.press('ControlOrMeta+Enter')
  await settle(page, 200)
  s = await state(page)
  expect.soft(await t(page, 'locked()'), 'lock released for the notes cursor').toBe(false)
  expect.soft(s.sidebar && s.sidebarEditing, 'sidebar open in edit mode').toBe(true)
  expect.soft(s.sidebarTitle, 'sidebar names the node').toBe('Vega')
  expect.soft(s.focus, 'textarea focused').toContain('notes-textarea')
  expect.soft(s.overlay || s.pill, 'no click-to-fly surface over a panel of ours').toBe(false)
  await page.keyboard.type('line one')
  await page.keyboard.press('Enter')
  await page.keyboard.type('line two')
  s = await state(page)
  expect.soft(s.sidebarEditing, 'Enter is a newline, not a save').toBe(true)
  await page.click('#notes-sidebar .editor-button--primary')
  await settle(page, 200)
  s = await state(page)
  expect.soft(await t(page, 'locked()'), 'lock back after Save with no click').toBe(true)
  expect.soft(s.sidebar, 'sidebar closes again (it was off before)').toBe(false)
  expect.soft(s.overlay || s.pill, 'nothing to click through').toBe(false)

  // --- N: the read-only view follows the crosshair strictly ---
  await page.keyboard.press('n')
  await settle(page)
  s = await state(page)
  expect.soft(s.sidebar && !s.sidebarEditing, 'N opens the view').toBe(true)
  expect.soft(s.sidebarBody, 'notes saved with their newline').toBe('line one\nline two')
  await page.screenshot({ path: testInfo.outputPath('notes_view.png') })
  await t(page, 'look(0, -300)')
  await settle(page)
  s = await state(page)
  expect.soft(s.sidebar, 'off the star: no panel at all').toBe(false)
  await t(page, 'look(0, 300)')
  await settle(page)
  expect.soft((await state(page)).sidebar, 'back on the star: panel returns').toBe(true)

  // --- Esc in the notes editor: cancel, and the lock still comes back ---
  await page.keyboard.press('ControlOrMeta+Enter')
  await settle(page, 200)
  await page.keyboard.type(' discarded')
  await page.keyboard.press('Escape')
  await settle(page, 200)
  s = await state(page)
  expect.soft(await t(page, 'locked()'), 'lock back after Esc-cancel').toBe(true)
  expect.soft(s.sidebar && !s.sidebarEditing, 'view mode again (it was on before)').toBe(true)
  expect.soft(s.sidebarBody, 'notes unchanged').toBe('line one\nline two')

  // --- the same chord saves: open, add a line, Ctrl/Cmd+Enter ---
  await page.keyboard.press('ControlOrMeta+Enter')
  await settle(page, 200)
  await page.keyboard.press('Enter')
  await page.keyboard.type('line three')
  await page.keyboard.press('ControlOrMeta+Enter')
  await settle(page, 200)
  s = await state(page)
  expect.soft(await t(page, 'locked()'), 'lock back after a keyboard save').toBe(true)
  expect.soft(s.sidebarBody, 'keyboard save kept the new line').toBe('line one\nline two\nline three')

  await page.keyboard.press('n')
  await settle(page)
  expect.soft((await state(page)).sidebar, 'N closes the view').toBe(false)

  expect.soft(errors, 'no console errors').toEqual([])
})
