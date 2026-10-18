import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'

const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.test/' })
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) globalThis[key] = dom.window[key]
const { createApp, nextTick, h } = await import('vue')
const { default: Panel } = await import(await compileFile('src/components/BasinEnsemble.vue'))
const { default: Plot } = await import(await compileFile('src/components/BasinPlot.vue'))
const { basinRegions, basinTracks, regionLongitude, pressureColor, basinCsv } = await import(await compileFile('src/data/basin.ts'))
const { parseCatalog } = await import(await compileFile('src/data/wnc2.ts'))
const csv = 'init_time,track_id,sample,valid_time,lead_time_hours,lat,lon,maximum_sustained_wind_speed_knots,minimum_sea_level_pressure_hpa\n' + [
  '2026-10-16 06:00:00,1,0,2026-10-16 06:00:00,0,15,140,50,935',
  '2026-10-16 06:00:00,1,0,2026-10-16 12:00:00,6,16,139,55,950',
  '2026-10-16 06:00:00,1,1,2026-10-16 06:00:00,0,13,135,40,990',
  '2026-10-16 06:00:00,1,1,2026-10-16 12:00:00,6,14,134,45,',
  '2026-10-16 06:00:00,AL012026,0,2026-10-16 06:00:00,0,20,-60,50,1001',
  '2026-10-16 06:00:00,AL012026,0,2026-10-16 12:00:00,6,21,-61,55,1000',
  '2026-10-16 06:00:00,1,0,2026-10-30 06:00:00,336,25,120,60,900',
].join('\n')
const catalog = parseCatalog(csv)
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 30)); await nextTick() }
const clickText = async (selector, text) => { const button = [...document.querySelectorAll(selector)].find(el => el.textContent.includes(text)); assert.ok(button, text); button.click(); await settle() }

await test('Basin grouping keeps local numeric IDs sample-scoped and clips to 312h', () => {
  const tracks = basinTracks(catalog, basinRegions[0])
  assert.deepEqual(tracks.map(track => track.key), ['0:1', '1:1'])
  assert.ok(tracks.every(track => track.points.length === 2))
  assert.equal(regionLongitude(-179, basinRegions.find(region => region.id === 'cp')), 181)
  assert.equal(pressureColor(935), '#b40075')
  assert.equal(pressureColor(955), '#ff4c23')
  assert.equal(pressureColor(978), '#ff9f00')
  assert.equal(pressureColor(988), '#c3c600')
  assert.equal(pressureColor(1000), '#365cff')
  assert.equal(pressureColor(1001), '#9bc9ef')
  assert.equal(pressureColor(null), '#8b929c')
  assert.equal(pressureColor(0), '#8b929c')
  assert.equal(parseCatalog(basinCsv(catalog.points)).points.length, 6)
})

await test('Basin plot renders independent pressure-colored tracks, global coastlines and finite empty regions', async () => {
  const app = createApp({ render: () => h(Plot, { catalog, region: basinRegions[0], theme: 'dark' }) }); app.mount('#app')
  try {
    assert.equal(document.querySelectorAll('.basin-track-lines line').length, 2)
    assert.equal(document.querySelectorAll('.basin-pressure-points circle').length, 4)
    assert.deepEqual([...document.querySelectorAll('.basin-pressure-points circle')].map(el => el.getAttribute('stroke')), ['#b40075', '#ff4c23', '#365cff', '#8b929c'])
    assert.match(document.querySelector('svg').textContent, /935.0 hPa/)
    assert.ok(!/NaN|Infinity/.test(document.querySelector('svg').outerHTML))
  } finally { app.unmount() }
  const empty = createApp({ render: () => h(Plot, { catalog: { ...catalog, points: [] }, region: basinRegions.find(r => r.id === 'au'), theme: 'light' }) }); empty.mount('#app')
  try {
    assert.match(document.querySelector('svg').textContent, /没有 0–312h/)
    assert.ok(!/NaN|Infinity/.test(document.querySelector('svg').outerHTML))
  } finally { empty.unmount() }
})

await test('Live WNC3 screen has three-column controls and no reference screenshot substitution', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => { calls.push(String(url)); return Response.json({ csv, run: { model: 'WNV3', date: '2026-10-16', cycle: '06z' }, checkedAt: 'now' }) })
  const app = createApp(Panel); app.mount('#app'); await settle()
  try {
    assert.ok(document.querySelector('.basin-sidebar'))
    assert.ok(document.querySelector('.basin-chart-panel'))
    assert.ok(document.querySelector('.basin-controls'))
    assert.equal(document.querySelectorAll('.basin-model-list button').length, 8)
    assert.match(document.querySelector('.basin-model-list .active').textContent, /WN3C/)
    assert.ok(calls.some(url => url.includes('model=WNV3')))
    assert.equal(document.querySelector('.basin-reference'), null)
    assert.match(document.querySelector('svg').textContent, /WN3C/)
    assert.equal(document.querySelector('.basin-csv').disabled, false)
    await clickText('.basin-buttons button', '深色')
    assert.equal(document.querySelector('.basin-viewer').dataset.theme, 'dark')
    await clickText('.basin-buttons button', '北大西洋')
    assert.equal(document.querySelectorAll('.basin-pressure-points circle').length, 2)
    await clickText('.basin-model-list button', 'ECMWF')
    assert.match(document.querySelector('.basin-empty').textContent, /尚未接入/)
    assert.equal(document.querySelector('svg'), null)
  } finally { app.unmount() }
})

await test('WNC2 run selection, themes, basin filtering and CSV export use actual selected data', async t => {
  let fail = false
  const calls = [], downloads = [], blobs = []
  t.mock.method(globalThis, 'fetch', async url => { calls.push(String(url)); return fail ? new Response('Not published', { status: 404 }) : Response.json({ csv, run: { model: 'FNV3P1', date: '2026-10-16', cycle: '06z' }, checkedAt: 'now' }) })
  t.mock.method(URL, 'createObjectURL', blob => { blobs.push(blob); return 'blob:basin-export' })
  t.mock.method(URL, 'revokeObjectURL', () => {})
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', function () { downloads.push(this.download) })
  const app = createApp(Panel); app.mount('#app')
  try {
    await clickText('.basin-model-list button', 'WN2C')
    assert.ok(calls.some(url => /model=FNV3P1&cycle=latest/.test(url)))
    assert.match(document.querySelector('.basin-status').textContent, /已连接/)
    assert.equal(document.querySelectorAll('.basin-pressure-points circle').length, 4)
    await clickText('.basin-buttons button', '北大西洋')
    assert.equal(document.querySelectorAll('.basin-pressure-points circle').length, 2)
    await clickText('.basin-buttons button', '深色')
    assert.ok(document.querySelector('svg').getAttribute('style').includes('24, 35, 48'))
    document.querySelector('.basin-csv').click(); await settle()
    assert.equal(downloads[0], 'WNC2-al-2026-10-16-06z-0-312h.csv')
    const saved = await blobs[0].text()
    assert.ok(saved.includes('AL012026'))
    assert.ok(!saved.includes('336'))
    assert.equal(parseCatalog(saved).points.length, 2)
    fail = true
    const select = document.querySelector('.basin-run select'); select.value = '2026-10-16|18z'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await settle()
    assert.ok(calls.some(url => url.includes('cycle=18z&date=2026-10-16')))
    assert.equal(document.querySelector('svg'), null, 'previous run must not survive manual failure')
    assert.ok(document.querySelector('[role="alert"]'))
    assert.equal(document.querySelector('.basin-csv').disabled, true)
  } finally { app.unmount() }
})

await test('Basin reference image is a local valid WebP file', async () => {
  const bytes = await readFile('public/images/weather-tools/wn3-basin-reference.webp')
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF')
  assert.equal(bytes.subarray(8, 12).toString(), 'WEBP')
})
dom.window.close()
