import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'
const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.test/' })
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) globalThis[key] = dom.window[key]
const { createApp, nextTick } = await import('vue')
const { default: Panel } = await import(await compileFile('src/components/BasinEnsemble.vue'))
const { loadPotential, cycloneChoices, cycloneCatalog, cycloneMean, generatedMember } = await import(await compileFile('src/data/potential.ts'))
const { windPressureAudit } = await import(await compileFile('src/data/wm6-audit.ts'))
const { basinCsv } = await import(await compileFile('src/data/basin.ts'))
const init = '2026-10-17T01:00:00Z', zero = '2026-10-17T00:00:00Z'
const a = '2026101701_F120_15p0N_145p0E_M028', b = '2026101701_F168_14p0N_165p0E_M028'
const p = (h, kt, hPa, lon = 140) => ({ valid_at: new Date(Date.parse(zero) + h * 3600000).toISOString(), forecast_hour: h, latitude: 15, longitude: lon, max_wind_kt: kt, min_mslp_hpa: hPa })
const official = { tropical_cyclone_id: 'WP292026', initialization_time: init, forecast_zero: zero, mean_path: [p(126, 45, 980), p(159, 50, 985)], members_path: [{ member: 28, path: [p(126, 56.9, 949.8), p(159, 64.3, 969.5)] }] }
const summaries = {
  WP292026: { tropical_cyclone_id: 'WP292026', path: official.mean_path },
  [a]: { tropical_cyclone_id: a, path: [p(120, 25, 1000), p(126, 28, 998), p(336, 90, 940)] },
  [b]: { tropical_cyclone_id: b, path: [p(168, 25, 1001, 165), p(174, 30, 997, 166)] },
}
function upstream(calls = []) {
  return async url => {
    const u = new URL(url, 'https://example.test'); calls.push(u)
    if (u.pathname === '/api/wm6') {
      const include = u.searchParams.get('include_unofficial_ids') === 'true'
      return Response.json({ initialization_time: init, forecast_zero: zero, tropical_cyclones: include ? summaries : { WP292026: summaries.WP292026 }, total: include ? 3 : 1 })
    }
    assert.equal(decodeURIComponent(u.pathname.split('/').at(-1)), 'WP292026', 'List already contains the real unmatched single-member paths; do not fetch hundreds of details')
    assert.equal(u.searchParams.get('initialization_time'), init)
    return Response.json(official)
  }
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 40)); await nextTick() }
async function chooseWm6() { const button = [...document.querySelectorAll('.basin-model-list button')].find(el => el.textContent.includes('WM-6')); button.click(); await settle() }

await test('Default WM-6 includes unmatched paths without 1 request per generated ID, and preserves original identity and units', async () => {
  const calls = [], result = await loadPotential('wm6', 'latest', undefined, upstream(calls))
  assert.equal(calls.length, 2)
  assert.equal(calls[0].searchParams.get('include_unofficial_ids'), 'true')
  assert.equal(result.wm6.forecastZero, zero)
  assert.equal(result.catalog.initTime, '2026-10-17 01:00:00')
  assert.equal(result.wm6.matchedCount, 1)
  assert.equal(result.wm6.unmatchedCount, 2)
  assert.equal(result.catalog.points.length, 6)
  const options = cycloneChoices(result)
  assert.equal(options.filter(option => option.kind === 'unmatched').length, 2)
  assert.equal(cycloneCatalog(result, a).points.length, 2)
  assert.ok(cycloneCatalog(result, a).points.every(point => point.sample === 28 && point.trackId === a))
  assert.deepEqual(cycloneMean(result, a), [], 'An unmatched single-member path must not become a fake ensemble mean')
  assert.equal(cycloneCatalog(result, 'WP292026').points.length, 2)
  assert.equal(generatedMember(a), 28)
  assert.equal(generatedMember('unknown-id'), null)
  assert.ok(result.catalog.points.every(point => point.leadHours <= 312))
  assert.ok(basinCsv(result.catalog.points).includes('"56.9","949.8"'))
})

await test('Official-only opt-out is explicit, and unknown generated ID formats resolve real member detail', async () => {
  const calls = [], result = await loadPotential('wm6', 'latest', undefined, upstream(calls), { includeUnofficial: false })
  assert.equal(calls[0].searchParams.get('include_unofficial_ids'), 'false')
  assert.ok(result.catalog.points.every(point => point.trackId === 'WP292026'))
  const unknown = 'new-provider-generated-id'
  const fallback = await loadPotential('wm6', 'latest', undefined, async url => String(url).startsWith('/api/wm6?') ? Response.json({ initialization_time: init, forecast_zero: zero, total: 1, tropical_cyclones: { [unknown]: { tropical_cyclone_id: unknown, path: [p(12, 30, 1000)] } } }) : Response.json({ ...official, tropical_cyclone_id: unknown, mean_path: [], members_path: [{ member: 7, path: [p(12, 30, 1000)] }] }))
  assert.equal(fallback.catalog.points[0].sample, 7)
  assert.deepEqual(cycloneMean(fallback, unknown), [])
})

await test('Matched storm detail failures do not erase successfully returned unmatched member paths', async () => {
  const source = upstream()
  const result = await loadPotential('wm6', 'latest', undefined, async url => String(url).startsWith('/api/wm6?') ? source(url) : new Response('', { status: 502 }))
  assert.match(result.warning, /WP292026/)
  assert.equal(result.catalog.points.length, 4)
  assert.ok(result.catalog.points.every(point => point.trackId !== 'WP292026'))
})

await test('Wind-pressure audit pairs each extremum with its actual member/time, never pairs unrelated minima/maxima', async () => {
  const result = await loadPotential('wm6', 'latest', undefined, upstream())
  const audit = windPressureAudit(result.catalog.points)
  assert.equal(audit.minimumPressure.pressure, 949.8)
  assert.equal(audit.minimumPressure.wind, 56.9)
  assert.equal(audit.minimumPressure.sample, 28)
  assert.equal(audit.minimumPressure.leadHours, 126)
  assert.equal(audit.maximumWind.wind, 64.3)
  assert.equal(audit.maximumWind.pressure, 969.5)
  assert.equal(audit.maximumWind.leadHours, 159)
  assert.deepEqual(windPressureAudit([]), { minimumPressure: null, maximumWind: null, missingWind: 0, missingPressure: 0 })
  const missing = windPressureAudit([{ ...result.catalog.points[0], wind: NaN, pressure: null }])
  assert.equal(missing.missingWind, 1); assert.equal(missing.missingPressure, 1)
})

await test('Basin map enables genesis by default, reports scope and paired raw data, and toggle hides it without stale tracks', async t => {
  const fetcher = upstream(), calls = []
  t.mock.method(globalThis, 'fetch', async url => { calls.push(String(url)); return String(url).startsWith('/api/wm6') ? fetcher(url) : new Response('', { status: 502 }) })
  const app = createApp(Panel); app.mount('#app'); await chooseWm6()
  try {
    assert.equal(document.querySelector('.wm6-unofficial-toggle input').checked, true)
    assert.equal(document.querySelectorAll('.basin-pressure-points circle').length, 4)
    assert.match(document.querySelector('.wm6-track-counts').textContent, /1 個匹配氣旋、2 條未匹配成員路徑/)
    assert.match(document.querySelector('.wm6-track-counts').textContent, /當前圖中：1 個匹配氣旋、1 條未匹配路徑/)
    assert.match(document.querySelector('.wm6-audit-pair').textContent, /949.8 hPa.*56.9 kt/)
    assert.match(document.querySelector('.wm6-audit').textContent, /forecast_zero.*2026-10-17T00:00:00Z/)
    const titles = [...document.querySelectorAll('.basin-pressure-points title')].map(el => el.textContent)
    assert.ok(titles.some(text => text.includes(a) && text.includes('998 hPa') && text.includes('28.0 kt')))
    const input = document.querySelector('.wm6-unofficial-toggle input'); input.click(); await settle()
    assert.equal(document.querySelectorAll('.basin-pressure-points circle').length, 2)
    assert.match(document.querySelector('.wm6-track-counts').textContent, /未匹配路徑已隱藏/)
    assert.ok(calls.some(url => url.includes('include_unofficial_ids=false')))
  } finally { app.unmount() }
})

await test('Typhoon selector separates generated tracks from ATCF buttons and never draws a mean for an unmatched track', async t => {
  const fetcher = upstream()
  t.mock.method(globalThis, 'fetch', async url => String(url).startsWith('/api/wm6') ? fetcher(url) : new Response('', { status: 502 }))
  const app = createApp(Panel, { mode: 'typhoon' }); app.mount('#app'); await chooseWm6()
  try {
    assert.equal(document.querySelectorAll('.potential-storms button').length, 1)
    const select = document.querySelector('[aria-label="氣旋與單成員生成路徑"]')
    assert.equal(select.querySelectorAll('optgroup:nth-child(2) option').length, 2)
    select.value = a; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await settle()
    assert.equal(document.querySelectorAll('.basin-track-lines line').length, 1)
    assert.equal(document.querySelectorAll('.potential-mean line').length, 0)
    assert.equal(document.querySelector('.potential-mean-legend-line'), null)
    assert.equal(document.querySelectorAll('.potential-member-peaks text').length, 1)
    assert.match(document.querySelector('svg').textContent, /Single member · no mean/)
    assert.match(document.querySelector('svg title').textContent, new RegExp(a))
    assert.ok(!/NaN|Infinity/.test(document.querySelector('svg').outerHTML))
  } finally { app.unmount() }
})
dom.window.close()
