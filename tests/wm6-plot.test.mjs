import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'
const dom = new JSDOM('<!doctype html><div id="app"></div>', { url: 'http://localhost/' })
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) globalThis[key] = dom.window[key]
const { createApp, h, nextTick } = await import('vue')
const { default: Plot } = await import(await compileFile('src/components/Wm6Plot.vue'))
const point = (latitude, longitude, forecast_hour, max_wind_kt) => ({ valid_at: `t${forecast_hour}`, forecast_hour, latitude, longitude, max_wind_kt })
const cyclone = { tropical_cyclone_id: 'WP292026', storm_name: 'TWENTY-NINE', basins: ['WP'], genesis: { latitude: 10, longitude: 140 }, mean_path: [point(10, 140, 0, 40), point(12, 145, 24, 70)], members_path: [{ member: 0, path: [point(10, 140, 0, 34), point(11, 144, 24, 64), point(12, 145, 48, null)] }, { member: 4, path: [point(10, 140, 0, null), point(13, 147, 24, 150)] }], landfalls: [{ valid_at: 't24', latitude: 15, longitude: 150, ensemble_member: 4 }], cones: [{ members_total: 128, max_forecast_hour: 168, geometry: { type: 'Polygon', coordinates: [[[139, 9], [151, 16], [140, 8], [139, 9]]] } }] }
await test('WM-6 draws clipped coastlines, wind-colored member segments and mean without cones', async () => {
  const app = createApp({ render: () => h(Plot, { cyclone, initializationTime: '2026-10-15T11:00:00Z' }) })
  app.mount('#app'); await nextTick()
  const segments = [...document.querySelectorAll('.wm6-member-tracks line')]
  assert.equal(segments.length, 3)
  assert.deepEqual(segments.map(line => line.getAttribute('stroke')), ['#00aaff', '#f4d500', '#7b8798'])
  assert.equal(document.querySelectorAll('polyline').length, 1)
  assert.equal(document.querySelectorAll('polygon').length, 0)
  assert.ok(document.querySelectorAll('.coastlines path').length > 0)
  assert.match(document.querySelector('.coastlines').getAttribute('clip-path'), /url\(#wm6-/)
  assert.match(document.querySelector('svg').getAttribute('aria-label'), /WP292026/)
  assert.match(document.querySelector('.wm6-intensity-legend').textContent, /Category 5/)
  assert.match(document.querySelector('.wm6-intensity-legend').textContent, /Wind unavailable/)
  assert.ok(!/NaN|Infinity/.test(document.querySelector('svg').outerHTML))
  assert.equal(document.querySelectorAll('circle[fill="#d84a4a"]').length, 0)
  assert.ok(!/landfall|cone/i.test(document.querySelector('svg').textContent))
  app.unmount()
})
await test('WM-6 empty storm has finite map bounds and no invented tracks', async () => {
  const app = createApp({ render: () => h(Plot, { cyclone: { tropical_cyclone_id: 'EMPTY' }, initializationTime: '2026-10-15T11:00:00Z' }) })
  app.mount('#app'); await nextTick()
  assert.equal(document.querySelectorAll('.wm6-member-tracks line').length, 0)
  assert.match(document.body.textContent, /No path points/)
  assert.ok(!/NaN|Infinity/.test(document.querySelector('svg').outerHTML))
  app.unmount()
})
await test('Coastlines cover EP, WP, and southern basins; dateline member paths stay local', async () => {
  for (const [lon, lat] of [[-102, 15], [130, 20], [145, -20], [179, 20]]) {
    const storm = { ...cyclone, genesis: { longitude: lon, latitude: lat }, landfalls: [], mean_path: [], members_path: [{ member: 1, path: [point(lat, lon, 0, 96), point(lat + 5, lon === 179 ? -179 : lon + 3, 24, 113)] }] }
    const app = createApp({ render: () => h(Plot, { cyclone: storm, initializationTime: '2026-10-15T11:00:00Z' }) })
    app.mount('#app'); await nextTick()
    assert.ok(document.querySelector('.coastlines path'), `Expected coastline near ${lon},${lat}`)
    const segment = document.querySelector('.wm6-member-tracks line')
    assert.equal(segment.getAttribute('stroke'), '#ff0000')
    assert.ok(Math.abs(Number(segment.getAttribute('x2')) - Number(segment.getAttribute('x1'))) < 1000)
    app.unmount()
  }
})
await test('Local WNC2 classification supports C1–C5 even when upstream says TS', async () => {
  const winds = [0, 25, 34, 64, 83, 96, 113, 137, 150]
  const path = winds.map((wind, i) => ({ ...point(10 + i, 140 + i, i * 6, wind), storm_type: 'TS' }))
  const app = createApp({ render: () => h(Plot, { cyclone: { ...cyclone, members_path: [{ member: 0, path }] }, initializationTime: 'run' }) })
  app.mount('#app'); await nextTick()
  assert.deepEqual([...document.querySelectorAll('.wm6-member-tracks line')].map(line => line.getAttribute('stroke')), ['#00e617', '#009e00', '#00aaff', '#f4d500', '#ff8000', '#ff0000', '#800000', '#ef50ef'])
  assert.match(document.querySelectorAll('.wm6-member-tracks line')[3].textContent, /Category 2/)
  app.unmount()
})
await test('Hidden remote landfalls cannot expand chart bounds', async () => {
  const app = createApp({ render: () => h(Plot, { cyclone: { ...cyclone, landfalls: [{ latitude: -80, longitude: -50 }] }, initializationTime: 'run' }) })
  app.mount('#app'); await nextTick()
  assert.ok(!document.querySelector('svg').textContent.includes('80°S'))
  app.unmount()
})
dom.window.close()
