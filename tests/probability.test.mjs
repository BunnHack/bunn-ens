import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'
const dom = new JSDOM('<div id="app"></div>', { url: 'https://example.test/' })
for (const key of ['window','document','Element','HTMLElement','SVGElement','Node']) globalThis[key] = dom.window[key]
const { createApp, h, nextTick } = await import('vue')
const { passageAt, passageField } = await import(await compileFile('src/data/probability.ts'))
const { default: Plot } = await import(await compileFile('src/components/BasinPlot.vue'))
const { default: Panel } = await import(await compileFile('src/components/BasinEnsemble.vue'))
const { serializeChart } = await import(await compileFile('src/data/chart-image.ts'))
const point=(sample,h,lon,lat=0)=>({sample,trackId:'WP292026',initTime:'2026-10-16 18:00:00',validTime:'2026-10-16T18:00:00Z',leadHours:h,lon,lat,wind:50,pressure:990})
const catalog=points=>({points,initTime:'2026-10-16 18:00:00',totalSamples:4,rawMaxLead:312})
const region={id:'test',label:'Test',west:-5,east:5,south:-5,north:5}
await test('120 km passage interpolates spherical track between fixes and counts a member once against full denominator',()=>{
 const c=catalog([point(0,0,-2),point(0,6,2),point(0,12,-2),point(1,0,40),point(1,6,42)])
 assert.deepEqual(passageAt(c,{lat:0,lon:0},4),{hits:1,percent:25})
 assert.equal(passageAt(c,{lat:0,lon:0},4,120,0).hits,0)
 assert.equal(passageAt(c,{lat:0,lon:0},4,120,3).hits,1)
 assert.equal(passageAt(c,{lat:2,lon:0},4).hits,0)
 assert.throws(()=>passageAt(c,{lat:0,lon:0},1),/分母/)
 assert.throws(()=>passageField(catalog([...c.points,{...point(2,0,0),trackId:'EP212026'}]),region,4),/單一/)
})
await test('Stationary positions use real radial distance, long gaps are not bridged and >312h is excluded',()=>{
 const c=catalog([point(0,0,140,15),point(0,6,140,15)])
 assert.equal(passageAt(c,{lat:15,lon:140},4).hits,1)
 assert.equal(passageAt(c,{lat:16,lon:141},4).hits,0,'Outside circle but within its bounding square')
 assert.equal(passageAt(catalog([point(0,0,-2),point(0,48,2)]),{lat:0,lon:0},4).hits,0)
 assert.equal(passageAt(catalog([point(0,336,0)]),{lat:0,lon:0},4).hits,0)
})
await test('Date-line passages stay local and grid probabilities agree with independently queried locations',()=>{
 const c=catalog([point(0,0,179),point(0,6,-179),point(1,0,178,1),point(1,6,-178,1)])
 assert.equal(passageAt(c,{lat:0,lon:180},4).hits,2)
 assert.equal(passageAt(c,{lat:0,lon:0},4).hits,0)
 const r={...region,west:175,east:185,south:-3,north:3},f=passageField(c,r,4)
 assert.ok(f.values.every(v=>v>=0&&v<=100))
 for(let row=0;row<f.rows;row+=7)for(let col=0;col<f.columns;col+=7){const q={lon:r.west+(col+.5)*(r.east-r.west)/f.columns,lat:r.north-(row+.5)*(r.north-r.south)/f.rows};assert.equal(f.values[row*f.columns+col],passageAt(c,q,4).percent)}
 assert.equal(f.trackedMembers,2);assert.equal(f.denominator,4)
})
await test('Probability SVG has actual contours, mean and city point badges, exports provenance and no member-pressure coloring',()=>{
 const c=catalog([point(0,0,120,24),point(0,6,121,24),point(1,0,120,24),point(1,6,121,24)])
 const r={...region,west:115,east:130,south:15,north:30},f=passageField(c,r,4)
 assert.ok(f.cities.some(city=>city.name==='台中'&&city.percent===50))
 const app=createApp({render:()=>h(Plot,{catalog:c,region:r,theme:'light',modelLabel:'WN3C',storm:'WP292026',probability:f,mean:[{leadHours:0,lon:120,lat:24,wind:50,count:2},{leadHours:6,lon:121,lat:24,wind:50,count:2}]})});app.mount('#app')
 try{
  assert.equal(document.querySelectorAll('.passage-probability-contours path').length,5)
  assert.ok(document.querySelector('.passage-probability-contours path').getAttribute('d').length>0)
  assert.equal(document.querySelector('.basin-pressure-points'),null)
  assert.equal(document.querySelector('.potential-member-peaks'),null)
  assert.equal(document.querySelectorAll('.potential-mean line').length,1)
  assert.match(document.querySelector('.passage-city-labels').textContent,/台中 50%/)
  const svg=serializeChart(document.querySelector('svg'))
  assert.match(svg,/Local estimate, not official/);assert.match(svg,/N=4/);assert.match(svg,/120 km/)
  assert.match(svg,/Natural Earth 1:50m/);assert.ok(!/NaN|Infinity/.test(svg))
 }finally{app.unmount()}
})
const init='2026-10-17T01:00:00Z',genesis='2026101701_F120_15p0N_140p0E_M028'
const wp=(h,lon)=>({valid_at:init,forecast_hour:h,latitude:15,longitude:lon,max_wind_kt:50,min_mslp_hpa:990})
const detail={tropical_cyclone_id:'WP292026',initialization_time:init,forecast_zero:'2026-10-17T00:00:00Z',ens_size:128,mean_path:[wp(0,140),wp(6,141)],members_path:[{member:0,path:[wp(0,140),wp(6,141)]},{member:1,path:[wp(0,140),wp(6,141)]}]}
const settle=async()=>{await new Promise(r=>setTimeout(r,40));await nextTick()}
await test('Probability UI uses WM-6 ens_size, adjustable window and export controls, but rejects single-member genesis',async t=>{
 t.mock.method(globalThis,'fetch',async url=>{const u=new URL(url,'https://example.test');if(u.pathname==='/api/wm6')return Response.json({initialization_time:init,forecast_zero:init,total:2,tropical_cyclones:{WP292026:{},[genesis]:{tropical_cyclone_id:genesis,path:[wp(0,140),wp(6,141)]}}});if(u.pathname.includes('/WP292026'))return Response.json(detail);return new Response('',{status:502})})
 const app=createApp(Panel,{mode:'typhoon'});app.mount('#app')
 try{
  const click=async(sel,text)=>{[...document.querySelectorAll(sel)].find(e=>e.textContent.includes(text)).click();await settle()}
  await click('.basin-model-list button','WM-6');await click('.potential-products button','機率預報')
  assert.ok(document.querySelector('.passage-probability-contours'))
  assert.match(document.querySelector('.probability-method').textContent,/完整系集 128/)
  assert.match(document.querySelector('svg').textContent,/N=128/)
  assert.ok(document.querySelector('.chart-save-svg'));assert.ok(document.querySelector('.chart-save-png'))
  const slider=document.querySelector('[aria-label="Probability maximum forecast hour"]');slider.value='6';slider.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await settle()
  assert.match(document.querySelector('.probability-method').textContent,/0–6h/)
  const select=document.querySelector('[aria-label="氣旋與單成員生成路徑"]');select.value=genesis;select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle()
  assert.equal(document.querySelector('svg'),null);assert.match(document.querySelector('.probability-unavailable').textContent,/不能顯示為 100%/)
 }finally{app.unmount()}
})
dom.window.close()
