import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'
const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.test' })
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'SVGSVGElement', 'Node', 'Image']) globalThis[key] = dom.window[key]
const { createApp, nextTick } = await import('vue')
const { default: Panel } = await import(await compileFile('src/components/Wm6Ensemble.vue'))
const { serializeChart, chartPng } = await import(await compileFile('src/data/chart-image.ts'))
const point = (hour, wind) => ({ valid_at: `t${hour}`, forecast_hour: hour, latitude: 10 + hour, longitude: 140 + hour, max_wind_kt: wind, storm_type: 'TS' })
const run = '2026-10-15T13:00:00Z'
const storm = { tropical_cyclone_id: 'WP292026', storm_name: 'Test', basins: ['WP'], path: [point(0, 40)], max_wind_kt: 40 }
const detail = { ...storm, initialization_time: run, mean_path: [point(0, 40), point(6, 50)], members_path: [{ member: 1, path: [point(0, 137), point(6, 150)] }], landfalls: [{ latitude: -70, longitude: -80 }], ens_size: 2 }
const png = 'data:image/png;base64,iVBORw0KGgo='
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 20)); await nextTick() }
await test('WM-6 downloads self-contained SVG and PNG, exposes long-press image, and uses member peak category', async t => {
  const blobs = [], downloads = [], revoked = [], draws = []
  t.mock.method(globalThis, 'fetch', async url => Response.json(String(url).includes('/WP292026?') ? detail : { initialization_time: run, tropical_cyclones: { WP292026: storm }, total: 1 }))
  t.mock.method(URL, 'createObjectURL', blob => { blobs.push(blob); return `blob:test-${blobs.length}` })
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url))
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', function () { downloads.push({ href: this.href, filename: this.download }) })
  t.mock.method(dom.window.HTMLCanvasElement.prototype, 'getContext', () => ({ drawImage: (...args) => draws.push(args) }))
  t.mock.method(dom.window.HTMLCanvasElement.prototype, 'toDataURL', function (type) { assert.equal(type, 'image/png'); assert.equal(this.width, 2000); assert.equal(this.height, 1580); return png })
  t.mock.property(globalThis, 'Image', class { set src(_) { queueMicrotask(() => this.onload()) } })
  const app = createApp(Panel); app.mount('#app')
  try {
    await settle()
    assert.match(document.querySelector('dd').textContent, /150.0 kt · Category 5/)
    assert.equal(document.querySelectorAll('circle[fill="#d84a4a"]').length, 0)
    ;[...document.querySelectorAll('button')].find(b => b.textContent === 'Save chart SVG').click()
    await settle()
    assert.equal(downloads[0].filename, 'wm-6-WP292026.svg')
    const svg = await blobs[0].text()
    assert.match(svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/)
    assert.match(svg, /width="2000"/)
    assert.match(svg, /font-family:Arial,sans-serif/)
    assert.match(svg, /#ef50ef/)
    assert.ok(!/Member landfall|d84a4a/.test(svg))
    ;[...document.querySelectorAll('button')].find(b => b.textContent === 'Enlarge member chart').click()
    await nextTick()
    document.querySelector('.wm6-image-actions button').click()
    await settle()
    assert.equal(downloads[1].filename, 'wm-6-WP292026.png')
    assert.equal(downloads[1].href, png)
    assert.equal(draws.length, 1)
    assert.equal(document.querySelector('.wm6-png-preview').src, png)
    assert.equal(document.querySelector('.wm6-png-preview').tagName, 'IMG')
    assert.equal(document.querySelector('.wm6-image-actions'), null, 'image preview replaces enlarged SVG')
    assert.ok(revoked.includes('blob:test-2'))
    document.querySelector('[aria-label="Close PNG image"]').click(); await nextTick()
    assert.equal(document.querySelector('.wm6-png-preview'), null)
  } finally { app.unmount() }
})
await test('PNG export failure revokes temporary source and suggests SVG fallback', async t => {
  let revoked = false
  t.mock.method(URL, 'createObjectURL', () => 'blob:error')
  t.mock.method(URL, 'revokeObjectURL', () => { revoked = true })
  t.mock.property(globalThis, 'Image', class { set src(_) { queueMicrotask(() => this.onerror()) } })
  await assert.rejects(() => chartPng('<svg/>'), /Download SVG/)
  assert.equal(revoked, true)
})
await test('SVG serialization keeps clipping, labels and namespace without mutating the live chart', () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.innerHTML = '<defs><clipPath id="clip"><rect width="100" height="100"/></clipPath></defs><path clip-path="url(#clip)"/><text>Category 5</text>'
  const saved = serializeChart(svg)
  assert.match(saved, /clip-path="url\(#clip\)"/)
  assert.match(saved, /Category 5/)
  assert.equal(svg.getAttribute('width'), null)
})
dom.window.close()
