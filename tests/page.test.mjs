import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { compileFile } from './compile.mjs'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { url: 'http://localhost:5173/', pretendToBeVisual: true })
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  globalThis[key] = dom.window[key]
}
const csv = await readFile(new URL('../public/data/FNV3P1_2026_10_13T00_00_cyclogenesis.csv', import.meta.url), 'utf8')
const requests = []
const intervals = []
const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
globalThis.setInterval = (callback, ms) => { const token = { callback, ms, cleared: false }; intervals.push(token); return token }
globalThis.clearInterval = token => { if (token) token.cleared = true }
let failRemote = false
globalThis.fetch = async (url) => {
  requests.push(url)
  const query = new URL(url, 'http://localhost').searchParams
  if (failRemote || (query.get('cycle') !== 'latest' && query.get('cycle') !== '00z')) return new Response('Unavailable', { status: 404 })
  return Response.json({ csv, run: { model: 'FNV3P1', date: '2026-10-13', cycle: '00z' }, checkedAt: '2026-10-13T06:37:00Z' })
}
const output = await compileFile('src/App.vue')
const { createApp, nextTick } = await import('vue')
const { default: App } = await import(output)
const app = createApp(App)
app.mount('#app')
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 30)); await nextTick() }
await settle()
const click = async (element) => {
  assert.ok(element, 'Expected clickable element to exist')
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await nextTick()
}

await test('Retain reference content rather than the invented dashboard', () => {
  assert.equal(document.querySelector('h1').textContent, 'Global Tropical Cyclone and Disturbance Information')
  assert.equal(document.querySelectorAll('.main-navigation a').length, 6)
  assert.equal(document.querySelectorAll('.storm-details > div').length, 6)
  assert.equal(document.querySelectorAll('.forecast-card').length, 4)
  assert.equal(document.querySelectorAll('.image-button img').length, 4)
  assert.ok(document.body.textContent.includes('WM-6 Ensemble'))
  assert.ok(document.body.textContent.includes('WNC2 Ensembles'))
  assert.ok(!document.body.textContent.includes('GFS Ensembles'))
  assert.equal(document.querySelectorAll('.member-labels [role="button"]').length, 50)
  assert.match(document.querySelector('.data-status').textContent, /WeatherNext CSV connected/)
  assert.ok(document.querySelector('.ensemble-mean'))
  assert.equal(document.querySelector('#storm-select').value, '96W INVEST')
  assert.ok(document.body.textContent.includes('9.7°N 162.6°E'))
  assert.ok(document.body.textContent.includes('1008 mb'))
  assert.ok(document.body.textContent.includes('Screenshot reference · not live'))
  assert.match(document.querySelector('.intensity-reference-note').textContent, /TRUDY.*2026-10-17 00Z.*不是 96W/)
  assert.ok(document.querySelector('.intensity-reference-note a[download]'))
  assert.equal(document.querySelector('.sidebar'), null)
  assert.ok(!document.body.textContent.includes('Jordan'))
})

await test('Expandable data notice discloses static image limitations', async () => {
  await click(document.querySelector('.information-toggle'))
  assert.equal(document.querySelector('.information-toggle').getAttribute('aria-expanded'), 'true')
  assert.match(document.querySelector('#data-information').textContent, /not live feeds/)
  await click(document.querySelector('.information-toggle'))
  assert.equal(document.querySelector('#data-information'), null)
})

await test('Enlarge the real reference image and close the dialog', async () => {
  await click(document.querySelector('.satellite-image'))
  assert.equal(document.querySelector('.preview-image').getAttribute('src'), '/images/infrared.png')
  assert.match(document.querySelector('.dialog-copy').textContent, /animation loop is not available/)
  await click(document.querySelector('[aria-label="Close dialog"]'))
  assert.equal(document.querySelector('.dialog'), null)
})

await test('Model cycle selection never pretends to update the static chart', async () => {
  const image = document.querySelector('.forecast-image img').getAttribute('src')
  await click(document.querySelector('.cycle-selector button'))
  assert.equal(document.querySelector('.cycle-selector button').getAttribute('aria-pressed'), 'true')
  assert.match(document.querySelector('.cycle-note').textContent, /00z unavailable · showing 06z reference/)
  assert.equal(document.querySelector('.forecast-image img').getAttribute('src'), image)
  assert.match(document.querySelector('[role="status"]').textContent, /reference image has not changed/)
  await click(document.querySelector('.snackbar button'))
})

await test('Display settings actually toggle compact spacing', async () => {
  await click(document.querySelector('[aria-label="Display settings"]'))
  await click(document.querySelector('.setting-row input'))
  assert.ok(document.querySelector('.site-shell').classList.contains('compact'))
  await click(document.querySelector('.filled-button'))
})

await test('Model acronym reference opens and closes', async () => {
  await click(document.querySelector('.models-heading .text-button'))
  assert.match(document.querySelector('.acronyms').textContent, /WeatherNext 2 Cyclones/)
  await click(document.querySelector('.filled-button'))
})

await test('Intensity Guidance opens the supplied TRUDY reference without pretending it belongs to 96W', async () => {
  await click(document.querySelector('[aria-label="Enlarge Intensity Guidance reference image"]'))
  assert.equal(document.querySelector('.preview-image').getAttribute('src'), '/images/21E-intensity-reference.png')
  assert.match(document.querySelector('.dialog-copy').textContent, /TRUDY.*00Z Oct 17, 2026.*Not live.*not an intensity forecast for Invest 96W/)
  const bytes = await readFile('public/images/21E-intensity-reference.png')
  assert.equal(bytes.readUInt32BE(16), 768); assert.equal(bytes.readUInt32BE(20), 600)
  await click(document.querySelector('[aria-label="Close dialog"]'))
})
await test('All local reference assets exist with PNG signatures', async () => {
  const paths = [...document.querySelectorAll('img')].map(image => image.getAttribute('src'))
  for (const path of paths) {
    const bytes = await readFile(new URL(`../public${path}`, import.meta.url))
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG', path)
  }
})
await test('WNC2 enlarged SVG highlights members and exports rendering evidence', async () => {
  await click(document.querySelector('.wnc2-controls .text-button'))
  assert.ok(document.querySelector('.wnc2-dialog'))
  await click(document.querySelector('.wnc2-dialog .member-labels [role="button"]'))
  assert.match(document.querySelector('.wnc2-dialog .selected-member').textContent, /Member 1 · peak/)
  assert.match(document.querySelector('#wnc2-dialog-title').textContent, /WP962026/)
  assert.equal(document.querySelector('.wnc2-dialog .member-labels [role="button"]').getAttribute('aria-pressed'), 'true')
  await click(document.querySelector('.wnc2-dialog .selected-member button'))
  await writeFile(new URL('../.tmp/wnc2-rendered.svg', import.meta.url), document.querySelector('.wnc2-dialog svg').outerHTML)
  await click(document.querySelector('[aria-label="Close WNC2 chart"]'))
})

await test('Unavailable manual cycle clears old chart; automatic latest mode recovers', async () => {
  const buttons = document.querySelectorAll('[aria-label="WNC2 Ensembles model cycle"] button')
  await click(buttons[1])
  await settle()
  assert.ok(requests.some(url => url.includes('cycle=06z') && url.includes('date=2026-10-13')))
  assert.match(document.querySelector('.wnc2-state.error').textContent, /No local snapshot/)
  assert.equal(document.querySelector('.wnc2-ensemble svg'), null)
  assert.equal(document.querySelector('.auto-button').getAttribute('aria-pressed'), 'false')
  const count = requests.length
  intervals[0].callback()
  await settle()
  assert.equal(requests.length, count)
  await click(document.querySelector('.auto-button'))
  await settle()
  assert.equal(document.querySelectorAll('.member-labels [role="button"]').length, 50)
})

await test('Auto timer uses 5 minutes, skips hidden tabs and refreshes on visibility', async () => {
  assert.equal(intervals[0].ms, 300000)
  const wnc2Requests = () => requests.filter(url => url.startsWith('/api/wnc2')).length
  let count = wnc2Requests()
  intervals[0].callback()
  await settle()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  assert.equal(wnc2Requests(), count + 1)
  count = wnc2Requests()
  intervals[0].callback()
  await settle()
  assert.equal(wnc2Requests(), count)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.equal(wnc2Requests(), count + 1)
})

await test('Lead filter removes beyond-window segments and diagnostic links never merge tracks', async () => {
  const input = document.querySelector('[aria-label="Maximum forecast lead hours"]')
  input.value = '24'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  for (const title of document.querySelectorAll('.member-tracks title')) assert.ok(Number(title.textContent.match(/\+(\d+)h/)[1]) <= 24)
  assert.equal(document.querySelectorAll('.diagnostic tbody tr').length, 14)
  assert.match(document.querySelector('.diagnostic').textContent, /36 continue beyond/)
  assert.match(document.querySelector('.diagnostic').textContent, /NOT proof of cyclone splitting/)
  await click(document.querySelector('.diagnostic td button'))
  assert.equal(document.querySelectorAll('.member-labels [role="button"]').length, 1)
  input.value = '312'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const select = document.querySelector('[aria-label="WNC2 system"]')
  select.value = 'WP962026(4)'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
})

await test('Refresh failure preserves and labels previous successful run', async () => {
  failRemote = true
  await click(document.querySelector('[aria-label="Reload WNC2 CSV"]'))
  await settle()
  assert.match(document.querySelector('.wnc2-state.error').textContent, /Retaining the previous/)
  assert.ok(document.querySelector('.wnc2-ensemble svg'))
  failRemote = false
})
app.unmount()
assert.ok(intervals[0].cleared)
globalThis.setInterval = originalSetInterval
globalThis.clearInterval = originalClearInterval
dom.window.close()
