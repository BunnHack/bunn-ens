import assert from 'node:assert/strict'
import{test}from'node:test'
import{readFile}from'node:fs/promises'
import{JSDOM}from'jsdom'
import{compileFile}from'./compile.mjs'
import{projectNcep}from'../shared/ncep-protocol.js'
const dom=new JSDOM('<div id="app"></div>',{url:'https://tropical-tidbits-material.pages.dev/',pretendToBeVisual:true})
for(const key of['window','document','Element','HTMLElement','SVGElement','Node'])globalThis[key]=dom.window[key]
const{createApp,h,ref,nextTick}=await import('vue')
const{loadPotential,cycloneMean,cycloneChoices}=await import(await compileFile('src/data/potential.ts'))
const{ncepCatalog,ncepAsset,loadNcepManifest}=await import(await compileFile('src/data/ncep.ts'))
const{memberIntensity}=await import(await compileFile('src/data/intensity.ts'))
const{potentialDenominator}=await import(await compileFile('src/data/extended-potential.ts'))
const{associateAiSources}=await import(await compileFile('src/data/source-association.ts'))
const{parseZoomStorm}=await import(await compileFile('src/data/current-storms.ts'))
const{default:Panel}=await import(await compileFile('src/components/NcepPublishedCharts.vue'))
const{default:StormPlot}=await import(await compileFile('src/components/CurrentStormPlot.vue'))
const raw={};for(const m of['GEFS','AIGEFS'])raw[m]=JSON.parse(await readFile(`tests/fixtures/ncep/${m}-native-subset.json`,'utf8'))
const charts=JSON.parse(await readFile('tests/fixtures/ncep/chart-index.json','utf8'))
const settle=async()=>{await new Promise(r=>setTimeout(r,45));await nextTick()}
function potential(data){return{ncep:data,catalog:ncepCatalog(data),details:{},source:'remote',checkedAt:data.checkedAt}}
await test('Main-site NOAA catalog preserves native control/member IDs, exact cycle, VMAX and full31 denominator',async()=>{
 const calls=[],result=await loadPotential('aigefs','2026-10-18|06z',undefined,async(url,options)=>{calls.push(url);assert.equal(options.credentials,'omit');return Response.json(raw.AIGEFS)})
 assert.deepEqual(calls,['https://raw.githubusercontent.com/BunnHack/bunn-ens/ensemble-track-data/AIGEFS-20261018T060000Z.json']);assert.equal(result.catalog.totalSamples,31)
 const p=result.catalog.points.find(p=>p.sample===1&&p.leadHours===0);assert.equal(p.wind,92);assert.equal(p.pressure,989);assert.equal(p.nativeMember,'A001');assert.equal(p.sourceId,'WP292026');assert.equal(Date.parse(p.validTime),Date.parse(raw.AIGEFS.run))
 const wind=memberIntensity(result,'aigefs','WP292026','wind'),values=raw.AIGEFS.tracks.filter(t=>t.kind==='matched').flatMap(t=>t.points.filter(p=>p.hour===0&&p.windKt!==null).map(p=>p.windKt));assert.equal(wind.denominator,31);assert.equal(wind.minimumMembers,8);assert.equal(wind.points[0].value,values.reduce((a,b)=>a+b,0)/values.length);assert.equal(wind.points[0].count,values.length)
 let seen=0;await assert.rejects(loadPotential('gefs','latest',undefined,async()=>{seen++;return new Response('',{status:404})}));assert.equal(seen,1)
})
await test('Missing members never shrink N; weak native genesis is retained and independent across members',()=>{
 const data=projectNcep(raw.GEFS,'GEFS'),result=potential({...data,tracks:data.tracks.filter(t=>t.sample<3)})
 assert.equal(result.catalog.totalSamples,31);assert.equal(potentialDenominator(result),31);assert.equal(cycloneMean(result,'WP292026').length,0);assert.equal(memberIntensity(result,'gefs','WP292026','wind').points.length,0)
 const gens=cycloneChoices(potential(data)).filter(c=>c.kind==='genesis');assert.ok(gens.length);assert.ok(gens.every(c=>c.points.every(p=>p.sourceKind==='genesis')));assert.ok(gens.some(c=>c.points.some(p=>p.wind<34)))
 assert.throws(()=>projectNcep({...data,windUnit:'m/s'},'GEFS'));assert.throws(()=>projectNcep(data,'AIGEFS'));assert.throws(()=>projectNcep(data,'GEFS','2026-10-17T06:00:00Z'))
})
await test('Field-L vector speed remains m/s metadata, not tracker kt or an invented named intensity curve',()=>{
 const data=structuredClone(raw.AIGEFS),token='L_AIGEFS_2026101806_M000_F006_13.00_140.00';data.fixtureNote='Explicitly synthetic field-L edge case only';data.tracks.push({sample:0,trackId:token,sourceId:token,nativeMember:'A000',kind:'derived_low',sourceFile:'https://nomads.ncep.noaa.gov/pub/data/nccf/com/aigefs/prod/aigefs.20261018/06/mem000/',method:'local-field-l-v1',points:[6,12].map(hour=>({hour,lat:13,lon:140,windKt:null,pressureHpa:1000,windMs:22.1}))});const projected=projectNcep(data,'AIGEFS'),result=potential(projected),p=result.catalog.points.find(p=>p.sourceKind==='derived_low');assert.ok(Number.isNaN(p.wind));assert.equal(p.fieldWindMs,22.1);assert.equal(p.pressure,1000);assert.equal(cycloneMean(result,p.trackId).length,0);assert.throws(()=>potentialDenominator(result,p.trackId))
 data.tracks[data.tracks.length-1].points[0].windKt=42;assert.throws(()=>projectNcep(data,'AIGEFS'))
})
await test('ATCF/WMC forecast-reference association works without WM6, but never merges ambiguous systems',()=>{
 // Synthetic geometry tests the explicit matching rule, not an operational identity claim.
 const result=potential(projectNcep(raw.AIGEFS,'AIGEFS')),mean=cycloneMean(result,'WP292026'),track={model:'FUXI',code:'20260131',name:'CHAMPI',basin:'W',points:mean.map(p=>({...p,validTime:new Date(Date.parse(raw.AIGEFS.run)+p.leadHours*3600000).toISOString()}))},catalog={tracks:[track]}
 const match=associateAiSources(catalog,{aigefs:result},'WP292026');assert.equal(match.code,'20260131');assert.match(match.rule,/预报参考.*不是观测/)
 assert.equal(associateAiSources({tracks:[track,{...track,code:'20260132'}]},{aigefs:result},'WP292026'),null)
 const ambiguity={...result,catalog:{...result.catalog,points:[...result.catalog.points,...result.catalog.points.filter(p=>p.trackId==='WP292026').map(p=>({...p,trackId:'WP302026'}))]}};assert.equal(associateAiSources(catalog,{aigefs:ambiguity},'WP292026'),null)
})
await test('Main-site image component selects real workflow assets without GRIB and hides old-model images',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async url=>{calls.push(String(url));assert.ok(String(url).endsWith('/ncep-ensembles/index.json'));return Response.json(charts)})
 const active=ref(false),model=ref('gefs'),app=createApp({render:()=>h(Panel,{active:active.value,model:model.value})});app.mount('#app');await settle();assert.equal(calls.length,0);active.value=true;await settle();await settle()
 try{let image=document.querySelector('.ncep-published img');assert.match(image.src,/GEFS\/.*\/regions\/wp.png/);assert.equal(image.style.display,'none');image.dispatchEvent(new dom.window.Event('load'));await nextTick();assert.notEqual(image.style.display,'none');const select=document.querySelector('[aria-label="Published NCEP product"]');select.value='wind';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await nextTick();assert.match(document.querySelector('.ncep-published img').src,/WP292026-wind.png/);model.value='aigefs';await nextTick();await nextTick();image=document.querySelector('.ncep-published img');assert.match(image.src,/AIGEFS\//);assert.equal(image.style.display,'none');assert.match(document.querySelector('.ncep-status').textContent,/240h.*31\/31/);assert.equal(calls.length,1);assert.ok(!calls.some(u=>/grib|nomads/.test(u)));active.value=false;await nextTick();assert.equal(document.querySelector('.ncep-published img').hasAttribute('src'),false)}finally{app.unmount()}
 const record=charts.records[0];assert.throws(()=>ncepAsset('https://evil.example/x.png',record));assert.throws(()=>ncepAsset(record.assets[0].replace(record.model,'FAKE'),record))
})
await test('Current Storm uses only genuine source cone/spline, unchanged wind category colours, larger points and no gap bridging',async()=>{
 const rawStorm=JSON.parse(await readFile('tests/fixtures/zoom-geometry.json','utf8')),storm=parseZoomStorm(rawStorm,rawStorm.id);assert.deepEqual(storm.cone,rawStorm.cone);assert.deepEqual(storm.track[1].spline,rawStorm.track[1].spline)
 const forecast=ref(true),app=createApp({render:()=>h(StormPlot,{storm,providerTime:'2026-10-18T10:00:00Z',historyHours:48,showForecast:forecast.value})});app.mount('#app');await nextTick()
 try{assert.ok(document.querySelector('.current-storm-source-cone'));assert.ok(document.querySelector('[data-source-spline="true"]'));assert.ok([...document.querySelectorAll('.current-storm-fix circle')].every(n=>Number(n.getAttribute('r'))>=7));assert.ok([...document.querySelectorAll('.current-storm-fix circle')].some(n=>n.getAttribute('fill')==='#800000'));forecast.value=false;await nextTick();assert.equal(document.querySelector('.current-storm-source-cone'),null);assert.equal(document.querySelector('.current-storm-fix[data-forecast="true"]'),null)}finally{app.unmount()}
 const broken=structuredClone(rawStorm);broken.cone=[[500,13]];assert.throws(()=>parseZoomStorm(broken,broken.id))
})
