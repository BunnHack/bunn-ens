import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'
const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.test/' })
for (const key of ['window','document','Element','HTMLElement','SVGElement','Node','Image']) globalThis[key] = dom.window[key]
const { createApp, h, nextTick } = await import('vue')
const { default: Frame } = await import(await compileFile('src/components/ChartFrame.vue'))
const { serializeChart, exportDimensions } = await import(await compileFile('src/data/chart-image.ts'))
const { geographicPaths } = await import(await compileFile('src/data/map-geography.ts'))
const { basinRegions } = await import(await compileFile('src/data/basin.ts'))
const mount = () => { const app = createApp({ render: () => h(Frame, { filename: 'test-map', title: 'Test map' }, { default: () => h('svg', { viewBox: '0 0 1200 970', style: 'color:#e3edf5;background:#182330' }, [h('rect', { width: 1200, height: 970, fill: '#182330' }), h('text', { fill: 'currentColor' }, 'Test mean')]) }) }); app.mount('#app'); return app }
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 25)); await nextTick() }
await test('SVG serialization preserves currentColor, clipping and native aspect ratio without mutating source', () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 1200 970'); svg.setAttribute('style', 'color:#abcdef;background:#123456')
  svg.innerHTML = '<defs><clipPath id="clip"><rect width="1110" height="815"/></clipPath></defs><text clip-path="url(#clip)" fill="currentColor">Mean</text>'
  const copy = serializeChart(svg)
  assert.match(copy, /width="2000"/); assert.match(copy, /height="1617"/)
  assert.match(copy, /color:#abcdef/); assert.match(copy, /background:#123456/)
  assert.match(copy, /url\(#clip\)/); assert.match(copy, /xmlns=/)
  assert.equal(svg.getAttribute('width'), null)
  assert.deepEqual(exportDimensions('0 0 2000 1580'), { width: 2000, height: 1580 })
  assert.deepEqual(exportDimensions('invalid'), { width: 2000, height: 1580 })
})
await test('Every chart frame downloads complete SVG and correctly sized PNG with real long-press preview', async t => {
  const blobs = [], downloads = [], sizes = []
  t.mock.method(URL, 'createObjectURL', b => { blobs.push(b); return 'blob:frame-'+blobs.length })
  t.mock.method(URL, 'revokeObjectURL', () => {})
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', function () { downloads.push(this.download) })
  t.mock.property(globalThis, 'Image', class { set src(_) { queueMicrotask(()=>this.onload()) } })
  t.mock.method(dom.window.HTMLCanvasElement.prototype, 'getContext', () => ({ drawImage() {} }))
  t.mock.method(dom.window.HTMLCanvasElement.prototype, 'toDataURL', function () { sizes.push([this.width,this.height]); return 'data:image/png;base64,AAAA' })
  const app = mount()
  try {
    document.querySelector('.chart-save-svg').click(); await settle()
    assert.equal(downloads[0], 'test-map.svg'); assert.match(await blobs[0].text(), /Test mean/)
    document.querySelector('.chart-save-png').click(); await settle()
    assert.equal(downloads[1], 'test-map.png'); assert.deepEqual(sizes[0], [2000,1617])
    assert.equal(document.querySelector('.chart-png-preview img').src, 'data:image/png;base64,AAAA')
  } finally { app.unmount() }
})
await test('Chart zoom, drag, fullscreen focus and Escape restore usable map controls', async () => {
  const app = mount()
  try {
    document.querySelector('[aria-label="Zoom in chart"]').click(); await nextTick()
    assert.equal(document.querySelector('.chart-canvas').style.width, '125%')
    const viewport = document.querySelector('.chart-viewport'); viewport.scrollLeft = 10
    for (const [type,x] of [['pointerdown',100],['pointermove',50],['pointerup',50]]) { const event = new dom.window.Event(type,{bubbles:true,cancelable:true}); Object.assign(event,{pointerType:'mouse',clientX:x,clientY:20,pointerId:1}); viewport.dispatchEvent(event) }
    assert.equal(viewport.scrollLeft, 60)
    document.querySelector('.chart-expand').click(); await nextTick()
    assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-modal'),'true')
    assert.equal(document.body.style.overflow,'hidden')
    document.querySelector('.chart-frame').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await nextTick()
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(document.body.style.overflow,'')
  } finally { app.unmount() }
})
await test('PNG failure stays visible with SVG fallback and the detailed map has borders and more coastal islands', async t => {
  t.mock.method(URL,'createObjectURL',()=> 'blob:error'); t.mock.method(URL,'revokeObjectURL',()=>{})
  t.mock.property(globalThis,'Image',class{set src(_){queueMicrotask(()=>this.onerror())}})
  const app=mount()
  try { document.querySelector('.chart-save-png').click(); await settle(); assert.match(document.querySelector('[role="alert"]').textContent,/SVG/) } finally {app.unmount()}
  assert.ok(geographicPaths('land',basinRegions[0]).length>50)
  assert.ok(geographicPaths('borders',basinRegions[0]).length>0)
  const source=JSON.parse(await readFile('src/data/fine-map.json','utf8')); assert.match(source.source,/1:50m/)
  assert.ok(geographicPaths('land',basinRegions[4]).every(path=>! /NaN|Infinity/.test(path)))
})
dom.window.close()
