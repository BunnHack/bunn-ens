import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'
const dom=new JSDOM('<div id="app"></div>',{url:'https://example.test/',pretendToBeVisual:true})
for(const key of ['window','document','Element','HTMLElement','SVGElement','Node'])globalThis[key]=dom.window[key]
const {createApp,nextTick}=await import('vue')
const {candidateGroups,candidateMean}=await import(await compileFile('src/data/candidate-groups.ts'))
const {passageAt}=await import(await compileFile('src/data/probability.ts'))
const {basinCsv}=await import(await compileFile('src/data/basin.ts'))
const {serializeChart}=await import(await compileFile('src/data/chart-image.ts'))
const {default:Panel}=await import(await compileFile('src/components/ExtendedPotential.vue'))
const init='2026-10-17 00:00:00',base=Date.parse('2026-10-17T00:00:00Z')
const p=(sample,leadHours,lon=150,trackId=`future-${sample}`,lat=15)=>({sample,leadHours,lon,trackId,lat,wind:56.9,pressure:949.8,initTime:init,validTime:new Date(base+leadHours*3600000).toISOString()})
const path=(sample,lon=150,id=`future-${sample}`,start=120)=>Array.from({length:9},(_,i)=>p(sample,start+i*6,lon,id))
const catalog=(points,totalSamples=8)=>({points,initTime:init,totalSamples,rawMaxLead:312})
await test('Local groups preserve sample zero, raw IDs and values; official storms stay independent; input order cannot change group identity',()=>{
 const points=[...path(0,179.8),...path(1,-179.9),...path(2,180.1),...path(3,179.9,'WP292026')],source=catalog(points),original=JSON.stringify(source)
 const {groups}=candidateGroups(source);assert.equal(groups.length,1);assert.equal(groups[0].members,3);assert.ok(groups[0].tracks.some(t=>t.sample===0));assert.ok(groups[0].tracks.every(t=>t.trackId!=='WP292026'))
 assert.ok(groups[0].points.every(point=>points.includes(point)));assert.equal(JSON.stringify(source),original)
 assert.equal(candidateGroups(catalog([...points].reverse())).groups[0].key,groups[0].key)
 const means=candidateMean(groups[0]);assert.ok(means.every(point=>Math.abs(point.lon-180)<1));assert.ok(means.every(point=>Math.abs(point.wind-56.9)<1e-9));assert.match(basinCsv(groups[0].points),/949.8/)
 const fraction=passageAt(catalog(groups[0].points),{lat:15,lon:180},8,120,312,{minLead:120,allSystems:true});assert.equal(fraction.hits,3);assert.equal(fraction.percent,37.5)
})
await test('Spatially separate systems in the same members form separate groups, never duplicate a member, and never average between storms',()=>{
 const source=catalog([0,1,2,3].flatMap(sample=>[...path(sample,120,`west-${sample}`),...path(sample,160,`east-${sample}`)]))
 const groups=candidateGroups(source).groups;assert.equal(groups.length,2)
 for(const group of groups){assert.equal(group.members,4);assert.equal(new Set(group.tracks.map(t=>t.sample)).size,4);const means=candidateMean(group);assert.ok(means.every(p=>Math.abs(p.lon-120)<.01||Math.abs(p.lon-160)<.01))}
 assert.equal(new Set(groups.flatMap(group=>group.tracks.map(t=>`${t.sample}:${t.trackId}`))).size,8)
})
await test('Temporal separation, sparse overlap, >12h holes and conflicting simultaneous fixes are not affirmative grouping evidence',()=>{
 assert.equal(candidateGroups(catalog([...path(0),...path(1,150,'later',240),...path(2,150,'last',24)])).groups.length,0)
 const holes=[0,1,2].flatMap(sample=>[p(sample,120),p(sample,144),p(sample,168)]);assert.equal(candidateGroups(catalog(holes)).groups.length,0)
 const conflict=[...path(0),p(0,120,90),...path(1),...path(2)];assert.equal(candidateGroups(catalog(conflict)).groups.length,0)
 assert.equal(candidateGroups(catalog([0,1,2].flatMap(sample=>[p(sample,120),p(sample,126)]))).groups.length,0)
})
await test('An ambiguous pair of same-member paths is left unassigned, including as a possible seed',()=>{
 const source=catalog([0,1,2,3].flatMap(sample=>path(sample)).concat(path(0,150.1,'ambiguous-twin')))
 const groups=candidateGroups(source).groups;assert.equal(groups.length,1);assert.equal(groups[0].members,3);assert.ok(groups[0].tracks.every(t=>t.sample!==0))
})
await test('A neighbor chain cannot grow without bound; all members must match a direct reference trajectory',()=>{
 const groups=candidateGroups(catalog(Array.from({length:9},(_,sample)=>path(sample,sample*3,`chain-${sample}`)).flat(),9)).groups
 assert.ok(groups.length>0);assert.ok(groups.every(group=>group.members<=3));assert.ok(groups.every(group=>Math.max(...group.points.map(p=>p.lon))-Math.min(...group.points.map(p=>p.lon))<=6))
})
await test('Provider-generated embedded genesis lead never truncates genuine earlier fixes; group means require actual coverage',()=>{
 const points=[0,1,2,3].flatMap(sample=>path(sample,150,`2026101701_F200_15p0N_150p0E_M${String(sample).padStart(3,'0')}`,108))
 const group=candidateGroups(catalog(points)).groups[0];assert.equal(group.firstLead,108);assert.equal(candidateMean(group)[0].leadHours,108)
 const sparse={...group,points:group.points.filter(point=>point.leadHours<156||point.sample<2)}
 assert.ok(!candidateMean(sparse).some(point=>point.leadHours===156));assert.ok(candidateMean(sparse).every(point=>point.count>=3))
})
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,45));await nextTick()}
await test('Candidate UI selects a local system, preserves original CSV IDs, exports association provenance, uses the full denominator, and is reversible',async t=>{
 const points=[...Array.from({length:8},(_,sample)=>[p(sample,0,120,'WP292026'),p(sample,6,120,'WP292026')]).flat(),...[0,1,2,3].flatMap(sample=>path(sample,150,String(700+sample)))]
 const csv=['init_time,track_id,sample,valid_time,lead_time_hours,lat,lon,maximum_sustained_wind_speed_knots,minimum_sea_level_pressure_hpa',...points.map(p=>[p.initTime,p.trackId,p.sample,p.validTime,p.leadHours,p.lat,p.lon,p.wind,p.pressure].join(','))].join('\n')
 t.mock.method(globalThis,'fetch',async()=>Response.json({csv,run:{model:'FNV3P1',date:'2026-10-17',cycle:'00z'},checkedAt:'2026-10-17T08:00:00Z'}))
 let exported;t.mock.method(URL,'createObjectURL',blob=>{exported=blob;return 'blob:group-test'});t.mock.method(URL,'revokeObjectURL',()=>{});t.mock.method(dom.window.HTMLAnchorElement.prototype,'click',()=>{})
 const app=createApp(Panel);app.mount('#app');await settle()
 try{
  assert.equal(document.querySelectorAll('.ep-group-button').length,1);document.querySelector('.ep-group-button').click();await settle()
  assert.match(document.querySelector('svg > title').textContent,/本站 G1/);assert.match(document.querySelector('svg > desc').textContent,/not provider storm identity/);assert.match(document.querySelector('.ep-group-members').textContent,/sample\/member=0/)
  assert.ok(document.querySelectorAll('.potential-mean line').length>0);assert.match(document.querySelector('.ep-counts').textContent,/完整分母 8；不按群組或圖域縮小/)
  const svg=serializeChart(document.querySelector('svg'));assert.match(svg,/local geometric association/);assert.match(svg,/700/)
  document.querySelector('.ep-download').click();await settle();const output=await exported.text();assert.match(output,/700/);assert.match(output,/949.8/);assert.ok(!output.includes('local:'));assert.ok(!output.includes('WP292026'))
  const probability=[...document.querySelectorAll('.ep-product-tabs button')].find(button=>button.textContent.includes('機率'));probability.click();await settle()
  assert.match(document.querySelector('svg > desc').textContent,/Selected local candidate group only/);assert.match(document.querySelector('svg > desc').textContent,/Full ensemble denominator 8/);assert.ok(!document.querySelector('svg > desc').textContent.includes('Single matched cyclone'))
  document.querySelector('[aria-label="Associate candidate systems"]').click();await settle();assert.equal(document.querySelectorAll('.ep-group-button').length,0);assert.equal(document.querySelector('[aria-label="Potential cyclone"]').value,'all');assert.match(document.querySelector('svg > desc').textContent,/All-system union/)
 }finally{app.unmount()}
})
dom.window.close()
