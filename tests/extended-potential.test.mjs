import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'
const dom=new JSDOM('<div id="app"></div>',{url:'https://example.test/',pretendToBeVisual:true})
for(const key of ['window','document','Element','HTMLElement','SVGElement','Node'])globalThis[key]=dom.window[key]
const {createApp,h,nextTick,ref}=await import('vue')
const {passageAt,passageField}=await import(await compileFile('src/data/probability.ts'))
const {potentialDenominator,windowCatalog,windowValidTimes}=await import(await compileFile('src/data/extended-potential.ts'))
const {default:Panel}=await import(await compileFile('src/components/ExtendedPotential.vue'))
const {default:App}=await import(await compileFile('src/App.vue'))
const {serializeChart}=await import(await compileFile('src/data/chart-image.ts'))
const init='2026-10-16 18:00:00',zero='2026-10-17T00:00:00Z',wmInit='2026-10-17T01:00:00Z'
const p=(sample,leadHours,lon=120.67,trackId='WP292026',lat=24.14)=>({sample,leadHours,lon,trackId,lat,wind:56.9,pressure:949.8,initTime:init,validTime:new Date(Date.parse('2026-10-16T18:00:00Z')+leadHours*3600000).toISOString()})
const cat=points=>({points,initTime:init,totalSamples:4,rawMaxLead:336})
const base=points=>({catalog:cat(points),source:'remote',checkedAt:'2026-10-17T08:00:00Z',details:{}})
const r={id:'test',label:'Test',west:115,east:130,south:15,north:30}
await test('Both time boundaries clip spherical segments; pre-window, post-window and >12h gaps never count',()=>{
 const c=cat([p(0,114,114,'WP292026',0),p(0,126,126,'WP292026',0)])
 const at=lon=>passageAt(c,{lon,lat:0},4,30,123,{minLead:117}).hits
 assert.equal(at(120),1);assert.equal(at(117),1);assert.equal(at(123),1);assert.equal(at(116),0);assert.equal(at(124),0)
 assert.equal(passageAt(cat([p(0,108,114,'WP292026',0),p(0,132,126,'WP292026',0)]),{lon:120,lat:0},4,30,126,{minLead:120}).hits,0)
 assert.throws(()=>passageAt(c,{lat:0,lon:0},4,120,120,{minLead:126}),/window/)
 assert.throws(()=>passageField(c,r,4,120,312,{minLead:NaN}),/window/)
})
await test('Explicit all-system union never links different IDs or double-counts a member, including at the dateline',()=>{
 const c=cat([p(0,120,179,'A',0),p(0,126,-179,'B',0)])
 assert.throws(()=>passageAt(c,{lon:180,lat:0},4),/單一/)
 assert.equal(passageAt(c,{lon:180,lat:0},4,30,312,{minLead:120,allSystems:true}).hits,0)
 const overlaps=cat([p(0,120,120.67,'A'),p(0,126,120.67,'B'),p(1,120,120.67,'C')])
 assert.deepEqual(passageAt(overlaps,{lon:120.67,lat:24.14},4,120,312,{minLead:120,allSystems:true}),{hits:2,percent:50})
 const f=passageField(overlaps,r,4,120,312,{minLead:120,allSystems:true})
 assert.equal(f.minLead,120);assert.equal(f.allSystems,true);assert.equal(f.trackedMembers,2);assert.equal(f.denominator,4)
 for(let row=0;row<f.rows;row+=13)for(let col=0;col<f.columns;col+=13){const q={lon:r.west+(col+.5)*(r.east-r.west)/f.columns,lat:r.north-(row+.5)*(r.north-r.south)/f.rows};assert.equal(f.values[row*f.columns+col],passageAt(overlaps,q,4,120,312,{minLead:120,allSystems:true}).percent)}
})
await test('Window catalog preserves raw units, IDs and full CSV denominator; WM-6 requires a verified consistent provider size',()=>{
 const source=base([p(0,114),p(0,120),p(0,312),p(0,336)])
 const windowed=windowCatalog(source.catalog,120,312)
 assert.deepEqual(windowed.points.map(p=>p.leadHours),[120,312]);assert.equal(windowed.totalSamples,4);assert.equal(windowed.points[0],source.catalog.points[1]);assert.equal(windowed.points[0].wind,56.9);assert.equal(windowed.points[0].pressure,949.8)
 assert.equal(potentialDenominator(source),4)
 source.wm6={forecastZero:zero,matchedCount:1,unmatchedCount:0,includedUnofficial:true};source.details.WP292026={ens_size:128}
 assert.equal(potentialDenominator(source),128);assert.equal(potentialDenominator(source,'WP292026'),128)
 source.details.EP212026={ens_size:64};assert.throws(()=>potentialDenominator(source),/分母/);delete source.details.EP212026
 source.warning='missing path';assert.throws(()=>potentialDenominator(source),/不完整/);delete source.warning
 source.wm6.includedUnofficial=false;assert.throws(()=>potentialDenominator(source),/未匹配/);source.wm6.includedUnofficial=true
 delete source.details.WP292026.ens_size;assert.throws(()=>potentialDenominator(source),/分母/)
})
await test('Valid window uses WM-6 forecast_zero, not init or the wall clock, and missing anchors are not guessed',()=>{
 const source={...base([p(0,120)]),wm6:{forecastZero:zero}}
 assert.deepEqual(windowValidTimes(source,120,312),['2026-10-22T00:00:00.000Z','2026-10-30T00:00:00.000Z'])
 source.wm6.forecastZero=undefined;assert.throws(()=>windowValidTimes(source,120,312),/anchor/)
})
const hours=[108,114,120,126,132,144,168,192,216,240,264,288,312]
const points=[...hours.flatMap(h=>[p(0,h),p(1,h)]),p(0,120,160,'7',15),p(0,126,161,'7',15),p(2,336),p(3,336)]
const csv=['init_time,track_id,sample,valid_time,lead_time_hours,lat,lon,maximum_sustained_wind_speed_knots,minimum_sea_level_pressure_hpa',...points.map(p=>[p.initTime,p.trackId,p.sample,p.validTime,p.leadHours,p.lat,p.lon,p.wind,p.pressure].join(','))].join('\n')
const genesis='2026101701_F120_15p0N_160p0E_M080'
const wp=(hour,longitude=120.67,latitude=24.14)=>({forecast_hour:hour,valid_at:new Date(Date.parse(zero)+hour*3600000).toISOString(),longitude,latitude,max_wind_kt:56.9,min_mslp_hpa:949.8})
const detail={initialization_time:wmInit,forecast_zero:zero,tropical_cyclone_id:'WP292026',ens_size:128,mean_path:hours.map(h=>wp(h)),members_path:[0,1].map(member=>({member,path:hours.map(h=>wp(h))}))}
const requests=[]
function fixtureFetch(url){
 const u=new URL(url,'https://example.test');requests.push(u)
 if(u.pathname==='/api/wnc2')return Promise.resolve(Response.json({csv,run:{model:u.searchParams.get('model'),date:'2026-10-16',cycle:'18z'},checkedAt:'2026-10-17T08:00:00Z'}))
 if(u.pathname==='/api/wm6')return Promise.resolve(Response.json({initialization_time:wmInit,forecast_zero:zero,total:2,tropical_cyclones:{WP292026:{},[genesis]:{path:[wp(120,160,15),wp(126,161,15)]}}}))
 if(u.pathname.includes('/WP292026')){assert.equal(u.searchParams.get('initialization_time'),wmInit);assert.equal(u.searchParams.get('include_cones'),'false');return Promise.resolve(Response.json(detail))}
 return Promise.resolve(new Response('Unavailable',{status:503}))
}
const settle=async()=>{await new Promise(r=>setTimeout(r,50));await nextTick()}
const click=async(selector,text)=>{const el=[...document.querySelectorAll(selector)].find(e=>!text||e.textContent.includes(text));assert.ok(el,selector+' '+text);el.click();await settle()}
const set=async(selector,value,event='change')=>{const el=document.querySelector(selector);el.value=String(value);el.dispatchEvent(new dom.window.Event(event,{bubbles:true}));await settle()}
await test('New workspace shows real 120–312h tracks, one peak per member, English labels, real IDs and no all-storm mean',async t=>{
 t.mock.method(globalThis,'fetch',fixtureFetch)
 const app=createApp(Panel);app.mount('#app');await settle()
 try{
  assert.equal(document.querySelector('h1').textContent,'中遠期襲擊潛勢');assert.equal(document.querySelector('[aria-label="Potential start hour"]').value,'120')
  assert.match(document.querySelector('.ep-provenance').textContent,/2026-10-16 18:00:00 UTC/)
  assert.equal(document.querySelectorAll('.potential-member-peaks > text').length,2)
  assert.equal(document.querySelectorAll('.potential-mean line').length,0);assert.equal(document.querySelector('.potential-mean-legend-line'),null)
  assert.ok(document.querySelectorAll('.potential-lead-labels text').length>0)
  assert.ok([...document.querySelectorAll('.basin-track-lines title')].every(el=>Number(/\+(\d+)h/.exec(el.textContent)[1])>=120))
  assert.ok([...document.querySelectorAll('.basin-place-labels text')].every(el=>/^[A-Z]{3,4}$/.test(el.textContent)))
  await click('.ep-product-tabs button','機率預報');assert.match(document.querySelector('svg').textContent,/N=4/);assert.equal(document.querySelector('.probability-mean-legend'),null)
  assert.match(document.querySelector('svg > desc').textContent,/All-system union/);assert.match(document.querySelector('svg > title').textContent,/120–312h/)
  await click('.ep-storm-tabs button','WP292026');assert.ok(document.querySelectorAll('.potential-mean line').length>0)
  await set('[aria-label="Potential cyclone"]','genesis:0:7');assert.equal(document.querySelector('svg'),null);assert.match(document.querySelector('.ep-warning').textContent,/單成員生成候選/)
  await click('.ep-product-tabs button','系集預報');assert.equal(document.querySelectorAll('.potential-member-peaks > text').length,1)
  await set('[aria-label="Potential model"]','wn3');assert.ok(requests.some(u=>u.searchParams.get('model')==='WNV3'));assert.match(document.querySelector('svg > title').textContent,/WN3C/)
  await set('[aria-label="Potential start hour"]',168,'input');await set('[aria-label="Potential end hour"]',240,'input');assert.match(document.querySelector('svg > title').textContent,/168–240h/)
  const svg=serializeChart(document.querySelector('svg'));assert.ok(!/NaN|Infinity/.test(svg));assert.match(svg,/168–240h/)
 }finally{app.unmount()}
})
await test('WM-6 includes real unmatched tracks but cannot give one candidate 100%; all-system denominator stays 128',async t=>{
 t.mock.method(globalThis,'fetch',fixtureFetch)
 const app=createApp(Panel);app.mount('#app');await settle()
 try{
  await set('[aria-label="Potential model"]','wm6');assert.equal(document.querySelectorAll('.potential-member-peaks > text').length,3)
  assert.match(document.querySelector('.ep-provenance').textContent,/2026-10-22 00:00:00 UTC/)
  assert.match(document.querySelector('.basin-track-lines').textContent,/56\.9 kt · 949\.8 hPa/)
  await click('.ep-product-tabs button','機率預報');assert.match(document.querySelector('svg').textContent,/N=128/)
  await set('[aria-label="Potential cyclone"]',genesis);assert.equal(document.querySelector('svg'),null);assert.match(document.querySelector('.ep-warning').textContent,/單成員生成候選/)
  await click('.ep-product-tabs button','系集預報');assert.equal(document.querySelectorAll('.potential-mean line').length,0)
 }finally{app.unmount()}
})
await test('CSV contains only the selected window/region and exact values; hidden workspace releases modal scroll lock',async t=>{
 t.mock.method(globalThis,'fetch',fixtureFetch)
 const blobs=[],downloads=[],active=ref(true)
 t.mock.method(URL,'createObjectURL',blob=>{blobs.push(blob);return 'blob:test'})
 t.mock.method(URL,'revokeObjectURL',()=>{})
 t.mock.method(dom.window.HTMLAnchorElement.prototype,'click',function(){downloads.push(this.download)})
 const app=createApp({render:()=>h(Panel,{active:active.value})});app.mount('#app');await settle()
 try{
  await click('.ep-download');const text=await blobs[0].text();assert.match(downloads[0],/120-312h\.csv$/);assert.match(text,/"56.9","949.8"/)
  for(const row of text.split('\n').slice(1)){const lead=Number(row.split(',')[4].replaceAll('"',''));assert.ok(lead>=120&&lead<=312)}
  await click('.chart-expand');assert.equal(document.body.style.overflow,'hidden');active.value=false;await settle();assert.equal(document.body.style.overflow,'');active.value=true;await settle();assert.equal(document.querySelector('[aria-label="Potential start hour"]').value,'120')
 }finally{app.unmount()}
})
await test('Internal medium-range route preserves both the existing storm controls and its own selected window during navigation',async t=>{
 t.mock.method(globalThis,'fetch',fixtureFetch)
 window.location.hash='#main-content';const app=createApp(App);app.mount('#app');await settle()
 try{
  const lead=document.querySelector('[aria-label="Maximum forecast lead hours"]');lead.value='120';lead.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await settle()
  window.location.hash='#weather-tools/extended';await settle();assert.ok(document.querySelector('.ep-layout'));await set('[aria-label="Potential start hour"]',168,'input')
  window.location.hash='#main-content';await settle();assert.equal(lead.value,'120');assert.equal(document.querySelector('.tools-surface').style.display,'none')
  window.location.hash='#weather-tools/extended';await settle();assert.equal(document.querySelector('[aria-label="Potential start hour"]').value,'168')
 }finally{app.unmount();window.location.hash=''}
})
dom.window.close()
