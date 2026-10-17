import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'

const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.test/#weather-tools/typhoon' })
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) globalThis[key] = dom.window[key]
const { createApp, nextTick, h } = await import('vue')
const { default: Panel } = await import(await compileFile('src/components/BasinEnsemble.vue'))
const { default: Tools } = await import(await compileFile('src/components/WeatherTools.vue'))
const { loadPotential, wm6Catalog, cycloneCatalog, cycloneChoices, cycloneMean, cycloneRegion } = await import(await compileFile('src/data/potential.ts'))
const { parseCatalog, sourceUrl } = await import(await compileFile('src/data/wnc2.ts'))
const { basinCsv } = await import(await compileFile('src/data/basin.ts'))
const { createWnc2Proxy } = await import(await compileFile('server/wnc2-proxy.ts'))
const csv = 'init_time,track_id,sample,valid_time,lead_time_hours,lat,lon,maximum_sustained_wind_speed_knots,minimum_sea_level_pressure_hpa\n' + [
  '2026-10-16 18:00:00,WP292026,0,2026-10-16 18:00:00,0,12,150,65,990',
  '2026-10-16 18:00:00,WP292026,0,2026-10-17 00:00:00,6,13,145,83,980',
  '2026-10-16 18:00:00,WP292026,1,2026-10-16 18:00:00,0,13,151,34,999',
  '2026-10-16 18:00:00,WP292026,1,2026-10-17 00:00:00,6,14,146,50,990',
  '2026-10-16 18:00:00,EP202026,0,2026-10-16 18:00:00,0,15,-115,40,998',
  '2026-10-16 18:00:00,7,0,2026-10-16 18:00:00,0,15,170,20,1005',
  '2026-10-16 18:00:00,7,1,2026-10-16 18:00:00,0,14,172,22,1004',
  '2026-10-16 18:00:00,WP292026,0,2026-10-30 18:00:00,336,30,130,180,900',
].join('\n')
const init = '2026-10-16T09:00:00Z'
const point = (hour, wind, lon = 140) => ({ forecast_hour: hour, valid_at: new Date(Date.parse(init) + hour * 3600000).toISOString(), latitude: 15 + hour / 24, longitude: lon, max_wind_kt: wind, min_mslp_hpa: 990, storm_type: 'TS' })
const detail = id => ({ tropical_cyclone_id: id, initialization_time: init, forecast_zero: init, mean_path: [point(0, 45), point(6, 50)], members_path: [{ member: 1, path: [point(0, 65), point(6, 83), point(336, 190)] }, { member: 2, path: [point(0, null), point(6, null)] }], matched_members: 2, ens_size: 128 })
const weather = url => Response.json({ csv, run: { model: String(url).includes('WNV3') ? 'WNV3' : 'FNV3P1', date: '2026-10-16', cycle: '18z' }, checkedAt: init })
const wmFetch = async url => {
  const u = new URL(url, 'https://example.test')
  return Response.json(u.pathname === '/api/wm6' ? { initialization_time: init, forecast_zero: init, total: 1, tropical_cyclones: { WP292026: {} } } : detail(decodeURIComponent(u.pathname.split('/').at(-1))))
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 40)); await nextTick() }
async function click(selector, label) { const el = [...document.querySelectorAll(selector)].find(el => el.textContent.includes(label)); assert.ok(el, label); el.click(); await settle() }

await test('WNC3 loads WNV3 exact initialization and source without falling back to WNC2', async () => {
  const calls = []
  const result = await loadPotential('wn3', '2026-10-16|18z', undefined, async url => { calls.push(url); return weather(url) })
  assert.equal(calls[0], '/api/wnc2?model=WNV3&cycle=18z&date=2026-10-16')
  assert.equal(result.url, 'https://deepmind.google.com/science/weatherlab/download/cyclones/WNV3/ensemble/cyclogenesis/csv/WNV3_2026_10_16T18_00_cyclogenesis.csv')
  assert.equal(result.source, 'remote')
  assert.ok(result.catalog.points.every(point => point.leadHours <= 312))
  let failures = 0
  await assert.rejects(loadPotential('wn3', 'latest', undefined, async () => { failures++; return new Response('', { status: 404 }) }), /No local snapshot/)
  assert.equal(failures, 1)
})

await test('Both production and development allow WNV3 but keep upstream path and initialization validation', async t => {
  const worker = (await import('data:text/javascript;base64,' + Buffer.from(await readFile('public/_worker.js')).toString('base64'))).default
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => { calls.push(String(url)); return new Response(csv) })
  globalThis.caches = { default: { match: async () => null, put: async () => {} } }
  const response = await worker.fetch(new Request('https://example.test/api/wnc2?model=WNV3&cycle=18z&date=2026-10-16'), {}, { waitUntil() {} })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).run.model, 'WNV3')
  assert.equal(calls[0], sourceUrl({ model: 'WNV3', date: '2026-10-16', cycle: '18z' }))
  const proxy = createWnc2Proxy(async url => { calls.push(String(url)); return new Response(csv) })
  let body = '', status = 200
  await proxy({ url: '/api/wnc2?model=WNV3&cycle=18z&date=2026-10-16', method: 'GET' }, { setHeader() {}, set statusCode(v) { status = v }, end(text) { body = text } }, () => assert.fail('Unexpected next'))
  assert.equal(status, 200)
  assert.equal(JSON.parse(body).run.model, 'WNV3')
})

await test('WM-6 basin requests real member paths with pinned initialization and at most three concurrent details', async () => {
  const ids = ['WP292026', 'EP202026', 'EP212026', 'SH012026', 'AL012026'], calls = []
  let concurrent = 0, peak = 0
  const result = await loadPotential('wm6', 'latest', undefined, async url => {
    const u = new URL(url, 'https://example.test'); calls.push(u)
    if (u.pathname === '/api/wm6') return Response.json({ initialization_time: init, total: ids.length, tropical_cyclones: Object.fromEntries(ids.map(id => [id, {}])) })
    concurrent++; peak = Math.max(peak, concurrent); await new Promise(resolve => setTimeout(resolve, 3)); concurrent--
    return Response.json(detail(u.pathname.split('/').at(-1)))
  })
  assert.equal(peak, 3)
  for (const url of calls.slice(1)) {
    assert.equal(url.searchParams.get('initialization_time'), init)
    assert.equal(url.searchParams.get('include_members'), 'true')
    assert.equal(url.searchParams.get('include_cones'), 'false')
  }
  assert.equal(Object.keys(result.details).length, 5)
  assert.equal(result.catalog.points.length, 20)
  assert.ok(result.catalog.points.every(point => point.leadHours <= 312))
  assert.equal(Math.max(...result.catalog.points.map(point => point.wind).filter(Number.isFinite)), 83)
  assert.ok(!basinCsv(result.catalog.points).includes('NaN'))
  assert.equal(cycloneMean(result, 'WP292026')[1].wind, 50, 'Use provider mean, not member reconstruction')
})

await test('WM-6 partial failure is disclosed, total failure and initialization mismatch never show a fake map', async () => {
  const fetcher = async url => String(url).includes('/api/wm6?') ? Response.json({ initialization_time: init, total: 2, tropical_cyclones: { WP292026: {}, EP202026: {} } }) : String(url).includes('EP202026') ? new Response('', { status: 502 }) : wmFetch(url)
  const result = await loadPotential('wm6', 'latest', undefined, fetcher)
  assert.match(result.warning, /EP202026/)
  assert.ok(!result.catalog.points.some(point => point.trackId === 'EP202026'))
  await assert.rejects(loadPotential('wm6', 'latest', undefined, async url => String(url).includes('/api/wm6?') ? fetcher(url) : new Response('', { status: 502 })), /成員路徑載入失敗/)
  await assert.rejects(loadPotential('wm6', '2026-10-16|18z', undefined, wmFetch), /起報時間不符/)
})

await test('Cyclone selection keeps genesis sample-scoped and uses dateline-safe bounds and means', () => {
  const result = { catalog: parseCatalog(csv), details: {} }
  assert.equal(cycloneChoices(result).filter(item => item.key.startsWith('genesis:')).length, 2)
  assert.equal(cycloneCatalog(result, 'genesis:0:7').points.length, 1)
  const catalog = { ...result.catalog, points: result.catalog.points.slice(0, 2).map((point, index) => ({ ...point, sample: index, leadHours: 0, lon: index ? 181 : 179 })) }
  const region = cycloneRegion(catalog)
  assert.ok(region.east - region.west < 20)
  assert.equal(region.south, 5)
  const mean = cycloneMean({ ...result, catalog }, 'WP292026')
  assert.equal(mean[0].lon, 180)
  assert.ok(Object.values(cycloneRegion({ ...catalog, points: [] })).every(value => typeof value !== 'number' || Number.isFinite(value)))
})

await test('Typhoon screenshot-style interface renders real wind tracks, mean, member peaks and cyclone buttons', async t => {
  t.mock.method(globalThis, 'fetch', async url => weather(url))
  const app = createApp(Panel, { mode: 'typhoon' }); app.mount('#app'); await settle()
  try {
    assert.equal(document.querySelector('.basin-top h1').textContent, '台風潛勢預報')
    assert.match(document.querySelector('.basin-model-list .active').textContent, /WN2C/)
    assert.equal(document.querySelectorAll('.potential-products button').length, 4)
    assert.equal(document.querySelectorAll('.potential-storms button').length, 2)
    assert.match(document.querySelector('svg title').textContent, /WP292026/)
    assert.equal(document.querySelectorAll('.potential-member-peaks text').length, 2)
    assert.equal(document.querySelectorAll('.basin-track-lines line').length, 2)
    assert.equal(document.querySelectorAll('.potential-mean line').length, 1)
    assert.equal(document.querySelectorAll('.basin-pressure-points').length, 0)
    assert.equal(document.querySelector('.basin-track-lines line').getAttribute('stroke'), '#f4d500')
    assert.ok(!/NaN|Infinity/.test(document.querySelector('svg').outerHTML))
    await click('.potential-products button', '機率預報')
    assert.ok(document.querySelector('.passage-probability-contours'))
    assert.match(document.querySelector('.probability-method').textContent, /分母為完整系集/)
    await click('.potential-products button', '系集海溫')
    assert.match(document.querySelector('.basin-empty').textContent, /不含海溫/)
    await click('.potential-products button', '系集熱焓')
    assert.equal(document.querySelector('svg'), null)
    await click('.potential-products button', '系集預報')
    await click('.potential-storms button', 'EP202026')
    assert.match(document.querySelector('svg title').textContent, /EP202026/)
    assert.ok(!document.querySelector('.potential-member-peaks').textContent.includes('83.0'))
    await click('.basin-model-list button', 'WN3C')
    assert.match(document.querySelector('svg title').textContent, /WN3C/)
  } finally { app.unmount() }
})

await test('WM-6 works in basin and typhoon views without cones, landfalls or invented winds', async t => {
  t.mock.method(globalThis, 'fetch', async url => String(url).startsWith('/api/wm6') ? wmFetch(url) : weather(url))
  const app = createApp(Panel); app.mount('#app'); await settle()
  try {
    await click('.basin-model-list button', 'WM-6')
    assert.match(document.querySelector('.basin-status').textContent, /真實成員路徑/)
    assert.equal(document.querySelectorAll('.basin-pressure-points circle').length, 4)
    assert.match(document.querySelector('svg title').textContent, /WM-6/)
    await click('.basin-buttons button', '北大西洋')
    assert.equal(document.querySelectorAll('.basin-pressure-points circle').length, 0)
  } finally { app.unmount() }
  const second = createApp(Panel, { mode: 'typhoon' }); second.mount('#app'); await settle()
  try {
    await click('.basin-model-list button', 'WM-6')
    assert.equal(document.querySelector('.basin-track-lines line').getAttribute('stroke'), '#f4d500')
    assert.equal([...document.querySelectorAll('.basin-track-lines line')][1].getAttribute('stroke'), '#7b8798')
    assert.match(document.querySelector('.potential-member-peaks').textContent, /83.0 kt/)
    assert.ok(!/NaN|Infinity|cone|landfall/.test(document.querySelector('svg').outerHTML))
    assert.match(document.querySelector('svg').textContent, /Provider mean/)
  } finally { second.unmount() }
})

await test('Typhoon deep link uses full-width workspace instead of unknown-tool fallback', async t => {
  t.mock.method(globalThis, 'fetch', async url => weather(url))
  const app = createApp({ render: () => h(Tools, { toolId: 'typhoon' }) }); app.mount('#app'); await settle()
  try {
    assert.ok(document.querySelector('.tools-page-basin .basin-layout'))
    assert.equal(document.querySelector('.tools-heading'), null)
    assert.equal(document.querySelector('.tools-grid'), null)
    assert.equal(document.querySelector('.basin-top h1').textContent, '台風潛勢預報')
  } finally { app.unmount() }
})

dom.window.close()
