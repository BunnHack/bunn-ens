import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'
const dom=new JSDOM('<div id="app"></div>',{url:'https://example.test/',pretendToBeVisual:true})
for(const key of ['window','document','Element','HTMLElement','SVGElement','SVGSVGElement','Node'])globalThis[key]=dom.window[key]
const {createApp,h,nextTick,ref}=await import('vue')
const data=await import(await compileFile('src/data/intensity.ts'))
const {wm6Catalog}=await import(await compileFile('src/data/potential.ts'))
const {serializeChart}=await import(await compileFile('src/data/chart-image.ts'))
const {default:Panel}=await import(await compileFile('src/components/IntensityGuidance.vue'))
const {default:Plot}=await import(await compileFile('src/components/IntensityPlot.vue'))
const {default:App}=await import(await compileFile('src/App.vue'))
const init='2026-10-17 00:00:00',zero='2026-10-17T00:00:00Z',wmInit='2026-10-17T03:00:00Z'
const p=(sample,leadHours,wind,pressure=949.8,trackId='WP292026')=>({sample,leadHours,wind,pressure,trackId,initTime:init,validTime:new Date(Date.parse(zero)+leadHours*3600000).toISOString(),lat:15,lon:150})
const source=(points,totalSamples=8)=>({catalog:{points,initTime:init,totalSamples,rawMaxLead:312},source:'remote',checkedAt:'2026-10-17T09:00:00Z',details:{}})
const wpoint=(hour,wind=56.9,pressure=949.8,base=zero)=>({forecast_hour:hour,valid_at:new Date(Date.parse(base)+hour*3600000).toISOString(),latitude:15,longitude:150,max_wind_kt:wind,min_mslp_hpa:pressure})
const wmSource=(members=32,ens_size=128)=>{const detail={tropical_cyclone_id:'WP292026',initialization_time:wmInit,forecast_zero:zero,ens_size,mean_path:[wpoint(0,44,958)],members_path:Array.from({length:members},(_,member)=>({member,path:[wpoint(0),wpoint(6)]}))};return{...source([]),catalog:wm6Catalog([detail],wmInit),details:{WP292026:detail},wm6:{forecastZero:zero}}}
await test('Intensity means count distinct reporting members, retain raw kt/hPa, exclude unrelated IDs/conflicts, and never fill missing intensity with zero',()=>{
 const points=[p(0,0,40),p(0,0,40),p(1,0,60),p(2,0,NaN),p(0,6,80),p(0,12,44),p(1,12,64),p(0,18,40),p(0,18,80),p(1,18,60),p(2,18,100),p(3,0,999,900,'EP212026')]
 const result=source(points),original=points.map(point=>({...point})),series=data.memberIntensity(result,'wn2','WP292026','wind')
 assert.deepEqual(series.points.map(point=>[point.leadHours,point.value,point.count]),[[0,50,2],[12,54,2],[18,80,2]])
 assert.equal(series.denominator,8);assert.equal(series.minimumMembers,2);assert.equal(series.conflicts,1);assert.equal(series.missingValues,1);assert.deepEqual(points,original)
 const pressure=data.memberIntensity(result,'wn2','WP292026','pressure');assert.ok(pressure.points.every(point=>Math.abs(point.value-949.8)<1e-8));assert.equal(series.points[0].min,40);assert.equal(series.points[0].max,60)
})
await test('WM-6 means use declared 128, not surviving tracks; a raw 56.9 kt / 949.8 hPa pair is never converted or inflated',()=>{
 const result=wmSource(),wind=data.memberIntensity(result,'wm6','WP292026','wind'),pressure=data.memberIntensity(result,'wm6','WP292026','pressure')
 assert.equal(result.catalog.totalSamples,32);assert.equal(wind.denominator,128);assert.equal(wind.minimumMembers,32);assert.equal(wind.points[0].count,32);assert.ok(Math.abs(wind.points[0].value-56.9)<1e-8);assert.ok(Math.abs(pressure.points[0].value-949.8)<1e-8)
 assert.equal(data.memberIntensity(wmSource(31),'wm6','WP292026','wind').points.length,0)
})
await test('Valid times anchor to forecast_zero, never provider initialization or a mocked wall clock; inconsistent times and mixed runs are rejected',t=>{
 t.mock.method(Date,'now',()=>Date.parse('2030-01-01T00:00:00Z'))
 const result=wmSource(),series=data.memberIntensity(result,'wm6','WP292026','wind');assert.equal(series.initializationTime,'2026-10-17T03:00:00.000Z');assert.equal(series.points[1].validTime,'2026-10-17T06:00:00.000Z')
 result.catalog.points.forEach(point=>{point.validTime=new Date(Date.parse(point.validTime)+3*3600000).toISOString()})
 const invalid=data.memberIntensity(result,'wm6','WP292026','wind');assert.equal(invalid.points.length,0);assert.equal(invalid.invalidTimes,64)
 delete result.wm6.forecastZero;assert.throws(()=>data.memberIntensity(result,'wm6','WP292026','wind'),/基準|初始化/)
 const mixed=wmSource();mixed.details.WP292026.initialization_time='2026-10-17T04:00:00Z';assert.throws(()=>data.memberIntensity(mixed,'wm6','WP292026','wind'),/不混合/)
 assert.equal(data.forecastEpoch('2026-10-18'),Date.parse('2026-10-18T00:00:00Z'))
})
await test('Provider mean is a separate raw statistic; unknown per-hour contributors stay unknown, invalid counts fail, and single/local candidates cannot masquerade as matched intensity',()=>{
 const result=wmSource(),member=data.memberIntensity(result,'wm6','WP292026','wind'),provider=data.providerIntensity(result,'WP292026','wind')
 assert.equal(provider.points[0].value,44);assert.equal(provider.points[0].count,null);assert.equal(provider.definition,'provider_mean');assert.equal(member.definition,'member_mean');assert.notEqual(member.points[0].value,provider.points[0].value)
 result.details.WP292026.mean_path[0].contributing_members_count=129;assert.throws(()=>data.providerIntensity(result,'WP292026','wind'),/成員數無效/)
 for(const id of ['local:G1','genesis:0:7','2026101701_F120_15N_150E_M001'])assert.throws(()=>data.memberIntensity(result,'wm6',id,'wind'),/ATCF/)
 const csv=data.intensityCsv([{...member,source:'snapshot'}]);assert.match(csv,/source_kind,checked_at/);assert.match(csv,/,snapshot,/);assert.match(csv,/forecast_zero,valid_time/);assert.ok(!csv.includes(',949.8,'))
})
await test('WM-6 intensity fetches only the selected real cyclone, pinned to list version, with no cones or guessed forecast-zero',async()=>{
 const original=wmSource(),detail=original.details.WP292026,list={initialization_time:wmInit,forecast_zero:zero,total:2,tropical_cyclones:{WP292026:{},EP212026:{}}},calls=[]
 const loaded=await data.loadWm6Intensity(list,'WP292026',undefined,async url=>{calls.push(new URL(url,'https://example.test'));return Response.json(detail)})
 assert.equal(calls.length,1);assert.equal(calls[0].pathname,'/api/wm6/WP292026');assert.equal(calls[0].searchParams.get('initialization_time'),wmInit);assert.equal(calls[0].searchParams.get('include_cones'),'false');assert.equal(calls[0].searchParams.get('include_members'),'true');assert.equal(loaded.wm6.forecastZero,zero)
 await assert.rejects(data.loadWm6Intensity({...list,forecast_zero:undefined},'WP292026',undefined,async()=>Response.json(detail)),/forecast_zero/)
})
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,55));await nextTick()}
const select=async(selector,value)=>{const node=document.querySelector(selector);node.value=value;node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle()}
const click=async(selector)=>{const node=document.querySelector(selector);assert.ok(node,selector);node.click();await settle()}
function fixture(){
 const calls=[],base6='2026-10-17T06:00:00Z',version='2026-10-17T08:00:00Z';let fail=false,extra=0
 const wxCsv=(model)=>{const runBase=model==='WNV3'?base6:zero,points=Array.from({length:8},(_,sample)=>[0,6,12,18].map(hour=>({...p(sample,hour,40+sample+extra),validTime:new Date(Date.parse(runBase)+hour*3600000).toISOString(),initTime:runBase.replace('T',' ').replace('Z','')}))).flat();if(model!=='WNV3')points.push(...Array.from({length:8},(_,sample)=>p(sample,0,90,950,'EP212026')));return ['init_time,track_id,sample,valid_time,lead_time_hours,lat,lon,maximum_sustained_wind_speed_knots,minimum_sea_level_pressure_hpa',...points.map(p=>[p.initTime,p.trackId,p.sample,p.validTime,p.leadHours,p.lat,p.lon,p.wind,p.pressure].join(','))].join('\n')}
 const detail={tropical_cyclone_id:'WP292026',storm_name:null,basins:['WP'],initialization_time:version,forecast_zero:base6,ens_size:128,mean_path:[0,3,6,12].map(h=>wpoint(h,44,958,base6)),members_path:Array.from({length:32},(_,member)=>({member,path:[0,3,6,12].map(h=>wpoint(h,56.9,949.8,base6))}))}
 const fetcher=async url=>{const value=new URL(url,'https://example.test');calls.push(value);if(fail)return new Response('Unavailable',{status:503});if(value.pathname==='/api/wnc2'){const model=value.searchParams.get('model');return Response.json({csv:wxCsv(model),run:{model,date:'2026-10-17',cycle:model==='WNV3'?'06z':'00z'},checkedAt:'2026-10-17T09:00:00Z'})}if(value.pathname==='/api/wm6')return Response.json({initialization_time:version,forecast_zero:base6,total:2,tropical_cyclones:{WP292026:{...detail,path:detail.mean_path},EP212026:{tropical_cyclone_id:'EP212026',storm_name:'TRUDY',basins:['EP'],path:[]}}});if(value.pathname==='/api/wm6/WP292026')return Response.json(detail);return new Response('Unavailable',{status:503})}
 return{fetcher,calls,fail:()=>{fail=true},change:()=>{extra=10}}
}
await test('Three-model UI uses UTC alignment and real means; wind/pressure/model toggles recalculate locally; separate provider line and CSV/SVG keep definitions and counts',async t=>{
 const f=fixture();t.mock.method(globalThis,'fetch',f.fetcher);let blob;t.mock.method(URL,'createObjectURL',value=>{blob=value;return 'blob:intensity-test'});t.mock.method(URL,'revokeObjectURL',()=>{});t.mock.method(dom.window.HTMLAnchorElement.prototype,'click',()=>{})
 const app=createApp(Panel);app.mount('#app');await settle();await settle()
 try{
  assert.equal(document.querySelectorAll('.intensity-model-curve').length,4);assert.equal(f.calls.length,7);assert.match(document.querySelector('.ig-sources').textContent,/128/);assert.match(document.querySelector('.ig-sources').textContent,/08:00:00/);assert.match(document.querySelector('.ig-sources').textContent,/06:00:00/)
  const wn2=[...document.querySelectorAll('[data-model="wn2"] .intensity-fix')].find(node=>node.textContent.includes('+6h')),wm6=document.querySelector('[data-model="wm6"] .intensity-fix');assert.equal(wn2.getAttribute('cx'),wm6.getAttribute('cx'));assert.match(wm6.textContent,/56.90 kt/);assert.match(wm6.textContent,/32\/128/)
  const svg=serializeChart(document.querySelector('.intensity-chart'));assert.match(svg,/forecast_zero \+ forecast_hour/);assert.match(svg,/definition=member_mean/);assert.match(svg,/N=128/)
  await select('[aria-label="Intensity metric"]','pressure');assert.equal(f.calls.length,7);assert.match(document.querySelector('[data-model="wm6"] .intensity-fix').textContent,/949.80 hPa/)
  await select('[aria-label="Intensity metric"]','wind');await click('[aria-label="Show WM-6 provider intensity mean"]');assert.equal(document.querySelectorAll('.intensity-model-curve').length,5);assert.match(document.querySelector('[data-definition="provider_mean"] .intensity-fix').textContent,/44.00 kt/);assert.match(document.querySelector('[data-definition="provider_mean"] .intensity-fix').textContent,/unknown\/128/);assert.equal(f.calls.length,7)
  await click('.ig-option-actions button:last-child');const csv=await blob.text();assert.match(csv,/member_mean/);assert.match(csv,/provider_mean/);assert.match(csv,/"32","128"/)
  await click('[aria-label="Show WNC3 intensity"]');assert.equal(document.querySelectorAll('.intensity-model-curve').length,4);assert.equal(f.calls.length,7)
  await select('[aria-label="Intensity cyclone"]','EP212026');assert.ok([...document.querySelectorAll('.intensity-model-curve')].every(node=>['wn2','genc'].includes(node.dataset.model)));assert.match(document.querySelector('.intensity-chart > title').textContent,/EP212026/);assert.match(document.querySelector('.intensity-guidance').textContent,/保留先前/)
 }finally{app.unmount()}
})
await test('Failed refresh retains explicitly dated model curves rather than artwork, and a same-version successful refresh invalidates old export previews',async t=>{
 const f=fixture();t.mock.method(globalThis,'fetch',f.fetcher);const downloads=[];t.mock.method(URL,'createObjectURL',()=> 'blob:intensity-test');t.mock.method(URL,'revokeObjectURL',()=>{});t.mock.method(dom.window.HTMLAnchorElement.prototype,'click',function(){downloads.push(this.download)});const app=createApp(Panel);app.mount('#app');await settle();await settle()
 try{await click('.chart-save-svg');const oldFile=downloads[0],before=document.querySelector('[data-model="wn2"] .intensity-fix').textContent;f.change();await click('.ig-refresh');await settle();assert.notEqual(document.querySelector('[data-model="wn2"] .intensity-fix').textContent,before);await click('.chart-save-svg');assert.notEqual(downloads[1],oldFile);f.fail();const previous=document.querySelector('[data-model="wn2"] .intensity-fix').textContent;await click('.ig-refresh');await settle();assert.equal(document.querySelector('[data-model="wn2"] .intensity-fix').textContent,previous);assert.match(document.querySelector('.intensity-guidance').textContent,/保留先前成功来源/);assert.equal(document.querySelectorAll('.intensity-model-curve').length,4);assert.equal(document.querySelector('.intensity-guidance img'),null)}finally{app.unmount()}
})
await test('Inactive intensity performs no API work, releases fullscreen, and reuses completed guidance when returning within five minutes',async t=>{
 const f=fixture();t.mock.method(globalThis,'fetch',f.fetcher);const active=ref(false),app=createApp({render:()=>h(Panel,{active:active.value})});app.mount('#app');await settle()
 try{assert.equal(f.calls.length,0);active.value=true;await settle();await settle();assert.equal(f.calls.length,7);await click('.chart-expand');assert.equal(document.body.style.overflow,'hidden');active.value=false;await settle();assert.equal(document.body.style.overflow,'');assert.equal(document.querySelector('.intensity-chart'),null);active.value=true;await settle();assert.equal(f.calls.length,7);assert.equal(document.querySelectorAll('.intensity-model-curve').length,4)}finally{app.unmount()}
})
await test('Homepage shares WNC2 and matched WM-6 requests with intensity and keeps the supplied TRUDY artwork only as collapsed historical reference',async t=>{
 const f=fixture();t.mock.method(globalThis,'fetch',f.fetcher);window.location.hash='';const app=createApp(App);app.mount('#app');await settle();await settle()
 try{assert.equal(f.calls.filter(url=>url.pathname==='/api/wm6').length,1);assert.equal(f.calls.filter(url=>url.pathname==='/api/wm6/WP292026').length,1);assert.equal(f.calls.filter(url=>url.pathname==='/api/wnc2'&&url.searchParams.get('model')==='FNV3P1').length,1);assert.equal(document.querySelectorAll('.intensity-guidance .intensity-model-curve').length,4);assert.equal(document.querySelector('.intensity-reference-note').open,false);assert.equal(document.querySelector('.intensity-live-card > .forecast-image'),null)}finally{app.unmount()}
})
await test('Intensity renderer never bridges >12h mean gaps or fabricates an empty time axis',async()=>{
 const series=data.memberIntensity(source([p(0,0,40),p(1,0,60),p(0,24,70),p(1,24,90)]),'wn2','WP292026','wind'),app=createApp(Plot,{series:[series],cyclone:'WP292026',metric:'wind'});app.mount('#app');await settle();try{assert.equal(document.querySelectorAll('.intensity-model-curve > line').length,0);assert.equal(document.querySelectorAll('.intensity-fix').length,2)}finally{app.unmount()}
 const empty=createApp(Plot,{series:[],cyclone:'WP292026',metric:'wind'});empty.mount('#app');await settle();try{assert.equal(document.querySelector('svg'),null);assert.match(document.querySelector('#app').textContent,/不补造/)}finally{empty.unmount()}
})
dom.window.close()
