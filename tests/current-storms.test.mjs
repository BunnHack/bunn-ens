import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'
import { handleCurrentStorms } from '../public/_worker.js'
const fixture=JSON.parse(await readFile('tests/fixtures/zoom-storms.json','utf8'))
const {parseCurrentStorms,parseZoomStorm,latestAnalysis,retainStormEntries,loadCurrentStorms}=await import(await compileFile('src/data/current-storms.ts'))
const copy=()=>structuredClone(fixture)
const ctx={waitUntil:p=>p}
await test('Zoom clock, source identities and native units remain distinct from forecast / category indices',()=>{
  const data=parseCurrentStorms(fixture),storm=data.entries[0].data,current=latestAnalysis(storm,data.providerTime)
  assert.equal(storm.id,'champi-2026');assert.equal(current.date,'2026-10-18T00:00:00Z');assert.equal(current.wind,130);assert.equal(current.pressure,934);assert.equal(current.rank,5)
  assert.ok(storm.track.some(p=>p.forecast&&p.wind===140));assert.ok(storm.track.some(p=>p.forecast&&p.pressure===null));assert.equal(storm.track[0].lon,161.2)
  assert.equal('cone' in storm,false);assert.equal('atcfId' in storm,false);assert.equal(data.entries[2].data.centroid,true)
})
await test('Reject wrong IDs, unknown units, conflicting points, impossible dates and coordinates',()=>{
  for(const mutate of [x=>x.windUnit='m/s',x=>x.catalogDate='2026-10-17T18:00Z',x=>x.entries.push(x.entries[0]),x=>x.entries[0].data.id='wati-2027',x=>x.entries[0].data.track[0].date='2026-02-31T00:00:00Z',x=>x.entries[0].data.track[0].coordinates=[181,10],x=>{const p=structuredClone(x.entries[0].data.track[0]);p.wind++;x.entries[0].data.track.push(p)}]){const value=copy();mutate(value);assert.throws(()=>parseCurrentStorms(value))}
  const same=structuredClone(fixture.entries[0].data);same.track.push(same.track[0]);assert.equal(parseZoomStorm(same,same.id).track.length,25)
})
await test('Partial refresh retains only the same source ID, old check date and explicit error',()=>{
  const old=parseCurrentStorms(fixture),value=copy();value.checkedAt='2026-10-18T04:30:00Z';value.entries[0].data=null;value.entries[0].error='unavailable';value.entries[1].id='other-2026';value.entries[1].data=null
  const next=retainStormEntries(parseCurrentStorms(value),old)
  assert.equal(next.entries[0].retained,true);assert.equal(next.entries[0].checkedAt,old.checkedAt);assert.equal(next.entries[1].data,null);assert.equal(next.entries[1].retained,undefined)
})
await test('Public Worker follows provider time, fixed origins and bounded fanout; strips cones and private fields',async t=>{
  const calls=[];t.mock.method(globalThis,'fetch',async(raw,options)=>{const u=new URL(raw);calls.push({u,options});assert.equal(u.origin,'https://zoom.earth');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');assert.equal(options.headers.authorization,undefined)
    if(u.pathname==='/data/time/')return Response.json({time:Date.parse(fixture.providerTime)/1000})
    if(u.searchParams.has('date')){assert.equal(u.searchParams.get('date'),fixture.catalogDate);assert.equal(u.searchParams.get('to'),'12');return Response.json({storms:['champi-2026'],disturbances:[]})}
    assert.equal(u.searchParams.get('lang'),'zh');return Response.json({...fixture.entries[0].data,cone:{coordinates:[[1,2]]},privateKey:'SHOULD_NOT_PASS',track:fixture.entries[0].data.track.map(p=>({...p,spline:[[1,2]],privateKey:'PRIVATE'}))})
  })
  const u=new URL('https://app.test/api/current-storms'),r=await handleCurrentStorms(new Request(u),ctx,u),j=await r.json();assert.equal(r.status,200);assert.equal(calls.length,3);assert.equal(j.providerTime,fixture.providerTime);assert.equal(j.entries[0].data.track[0].wind,29);assert.doesNotMatch(JSON.stringify(j),/cone|spline|PRIVATE|SHOULD_NOT_PASS/);assert.equal(parseCurrentStorms(j).entries.length,1)
})
await test('Worker refuses arbitrary parameters, methods, redirects and all failed storm details without fallback',async t=>{
  const u=new URL('https://app.test/api/current-storms?url=https://example.org');assert.equal((await handleCurrentStorms(new Request(u),ctx,u)).status,400);u.search='';assert.equal((await handleCurrentStorms(new Request(u,{method:'POST'}),ctx,u)).status,405)
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status:302,headers:{location:'http://wrong.test'}}));assert.equal((await handleCurrentStorms(new Request(u),ctx,u)).status,502)
})
await test('Browser shares a five-minute public request, rejects malformed successes and retries',async()=>{
  let count=0;const fetcher=async()=>{count++;return Response.json(count===1?{bad:true}:fixture)}
  await assert.rejects(()=>loadCurrentStorms(undefined,fetcher));await loadCurrentStorms(undefined,fetcher);await loadCurrentStorms(undefined,fetcher);assert.equal(count,2)
})
await test('Current Storm UI selects actual systems, preserves raw values, distinguishes forecast, retains failures and gates background work',async t=>{
  const dom=new JSDOM('<div id="app"></div>',{url:'https://test.local/',pretendToBeVisual:true});for(const key of ['window','document','Element','HTMLElement','SVGElement','Node'])globalThis[key]=dom.window[key]
  const intervals=[],calls=[];let fail=false
  t.mock.method(globalThis,'setInterval',callback=>{const token={callback};intervals.push(token);return token});t.mock.method(globalThis,'clearInterval',()=>{})
  t.mock.method(globalThis,'fetch',async url=>{calls.push(url);return fail?new Response('',{status:502}):Response.json(fixture)})
  const {createApp,h,nextTick,ref}=await import('vue'),{default:View}=await import(await compileFile('src/components/CurrentStorms.vue'));const active=ref(true),app=createApp({render:()=>h(View,{active:active.value})});app.mount('#app');const settle=async()=>{await new Promise(r=>setTimeout(r,40));await nextTick()}
  try{
    await settle();assert.equal(document.querySelector('#storm-select').value,'champi-2026');assert.equal(document.querySelectorAll('#storm-select option').length,3);assert.match(document.querySelector('.storm-details').textContent,/130 kt.*934 hPa/);assert.match(document.querySelector('.cs-analysis').textContent,/2026-10-18 00:00:00 UTC/);assert.ok(document.querySelector('[data-forecast="true"]'));assert.equal(document.querySelector('.current-storm-map .cone'),null)
    const selected=document.querySelector('#storm-select');selected.value='d01l-2026';selected.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await nextTick();assert.match(document.querySelector('.storm-details').textContent,/质心.*未提供.*30%/);assert.equal(calls.length,1)
    active.value=false;await nextTick();intervals[0].callback();await settle();assert.equal(calls.length,1);assert.equal(document.querySelector('.chart-frame'),null);active.value=true;await settle();assert.equal(document.querySelector('#storm-select').value,'d01l-2026');assert.equal(calls.length,1)
    fail=true;document.querySelector('.cs-toolbar button').click();await settle();assert.match(document.querySelector('[role="alert"]').textContent,/保留先前成功资料/);assert.ok(document.querySelector('.current-storm-map'))
  }finally{app.unmount();dom.window.close()}
})
await test('Requested old UI prose, genesis dropdown and screenshot current conditions are removed',async()=>{
  const wn=await readFile('src/components/Wnc2Ensemble.vue','utf8'),wm=await readFile('src/components/Wm6Ensemble.vue','utf8'),app=await readFile('src/App.vue','utf8')
  assert.doesNotMatch(wn,/Selected track is independent|System \/ sample-specific genesis track|<p[^>]*>Initialized/);assert.doesNotMatch(wm,/Wind categories are assigned locally from raw max_wind_kt/);assert.doesNotMatch(app,/9\.7°N|1008 mb|Screenshot reference · not live/);assert.match(app,/<CurrentStorms :active="currentOpen"/)
})
