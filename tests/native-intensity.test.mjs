import assert from 'node:assert/strict'
import {test} from 'node:test'
import {readFile} from 'node:fs/promises'
import {gzipSync} from 'node:zlib'
import {compileFile} from './compile.mjs'
import {handleIntensityAids} from '../public/_worker.js'
const {parseIntensityAids,aidIntensity}=await import(await compileFile('src/data/intensity-aids.ts'))
const {aiIntensity,extraIntensity,guidanceCsv}=await import(await compileFile('src/data/intensity-sources.ts'))
const {overviewWindow,overviewLabels,overviewPointUtc}=await import(await compileFile('src/data/overview-window.ts'))
const {focusTrackRegion}=await import(await compileFile('src/data/overview.ts'))
const {categories}=await import(await compileFile('src/data/wnc2.ts'))
const {zhHans}=await import(await compileFile('src/data/zh-hans.ts'))
const fixture=JSON.parse(await readFile('tests/fixtures/intensity-aids-EP212026.json','utf8'))
await test('Real NHC latest-cycle archive supplies reference aid codes with unaltered VMAX and missing MSLP',()=>{
 const parsed=parseIntensityAids(fixture,'EP212026'),wind=aidIntensity(parsed,'wind'),pressure=aidIntensity(parsed,'pressure')
 assert.equal(parsed.latestCycle,'2026101800');for(const code of ['OFCL','AVNI','CMC2','CTCI','GDMI','HFAI','HFBI','HMNI','HWFI','IVCN','LGEM','SHIP'])assert.ok(wind.some(s=>s.label===code&&s.points.length),code)
 assert.equal(wind.find(s=>s.label==='OFCL').points[0].value,85);assert.equal(parsed.aids.find(s=>s.code==='OFCL').points[0].pressure,null);assert.equal(pressure.find(s=>s.label==='OFCL').points[0].value,976);assert.ok(wind.every(s=>s.denominator===null&&s.definition==='aid'));assert.ok(!wind.some(s=>['GEMI','GEML','CARQ'].includes(s.label)))
})
await test('ATCF refuses mixed cyclone/cycle, excludes member techniques and conflicts field-by-field without blending',()=>{
 const row='EP, 21, 2026101800, 03, OFCL, 0, 179N, 1055W, 85, 0, HU'
 let value={...fixture,rows:row+'\n'+row};assert.equal(parseIntensityAids(value,'EP212026').aids[0].points.length,1)
 value.rows+='\n'+row.replace(', 85,',', 90,');let p=parseIntensityAids(value,'EP212026').aids;assert.equal(p.length,0)
 value.rows=row+'\n'+row.replace('OFCL','AP01');assert.equal(parseIntensityAids(value,'EP212026').aids.length,1)
 assert.throws(()=>parseIntensityAids({...value,rows:row.replace('EP, 21','EP, 22')},'EP212026'));assert.throws(()=>parseIntensityAids({...value,rows:row.replace('2026101800','2026101718')},'EP212026'))
 assert.throws(()=>parseIntensityAids({...value,latestCycle:'2026023100'},'EP212026'));assert.throws(()=>parseIntensityAids({...value,source:'https://example.org/archive'},'EP212026'))
})
await test('NHC Worker streams a gzip archive to one cycle, projects a fixed public source and rejects unsafe requests',async t=>{
 const u=new URL('https://test.local/api/intensity-aids?storm=EP212026'),ctx={waitUntil:p=>p},calls=[]
 t.mock.method(globalThis,'fetch',async(raw,options)=>{calls.push(raw);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');assert.equal(raw,'https://ftp.nhc.noaa.gov/atcf/aid_public/aep212026.dat.gz');return new Response(gzipSync('EP, 21, 2026101718, 03, OFCL, 0, 179N, 1055W, 80, 0, HU\n'+fixture.rows))})
 const response=await handleIntensityAids(new Request(u),ctx,u),data=await response.json();assert.equal(response.status,200);assert.equal(data.latestCycle,'2026101800');assert.equal(parseIntensityAids(data,'EP212026').aids.length,parseIntensityAids(fixture,'EP212026').aids.length);assert.equal(calls.length,1)
 u.search='?storm=EP212026&url=https://wrong.test';assert.equal((await handleIntensityAids(new Request(u),ctx,u)).status,400);u.search='?storm=WP292026';assert.equal((await handleIntensityAids(new Request(u),ctx,u)).status,400);u.search='?storm=EP212026';assert.equal((await handleIntensityAids(new Request(u,{method:'POST'}),ctx,u)).status,405)
})
await test('NHC whole-operation deadline cancels a stalled response body rather than leaving guidance pending indefinitely',async t=>{
 const original=setTimeout;let cancelled=false,signal;
 t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>original(callback,Math.min(ms,15),...args));
 t.mock.method(globalThis,'fetch',async(_,options)=>{signal=options.signal;return new Response(new ReadableStream({cancel(){cancelled=true}}))});
 const u=new URL('https://test.local/api/intensity-aids?storm=EP212026'),response=await handleIntensityAids(new Request(u),{waitUntil:()=>assert.fail('Timeout must not publish/cache')},u);
 assert.equal(response.status,502);assert.equal(signal.aborted,true);assert.equal(cancelled,true);assert.match((await response.json()).error,/no substitute/)
})
await test('AI / SD3 / AIGFS intensity keeps original units, unknown N, provenance, stops and noncommercial credits',()=>{
 const zero='2026-10-17T18:00:00.000Z',points=[0,6].map(h=>({lat:12,lon:145,leadHours:h,validTime:new Date(Date.parse(zero)+h*3600000).toISOString(),windMs:38.94587466487593,pressureHpa:972.1253734458168}))
 const ai={checkedAt:zero,tracks:[{model:'FUXI',code:'20260131',name:'CHAMPI',forecastZero:zero,points,warnings:['HTTP / UTC warning']}]};const series=aiIntensity(ai,'20260131','wind');assert.equal(series[0].points[0].value,points[0].windMs);assert.equal(series[0].unit,'m/s');assert.equal(series[0].denominator,null);assert.equal(aiIntensity(ai,'20260130','wind').length,0)
 const sd3={model:'SD3',systemId:'SD3:WNP:CHAMPI',name:'CHAMPI',kind:'native',directoryRun:'2026-10-17T12:00:00.000Z',timeOrigin:zero,points,method:'Native NetCDF',notes:['raw m/s'],endReason:'native end',retained:false,attribution:'TianJi Weather Science and Technology Company',license:'CC BY-NC 4.0'}
 const native=extraIntensity([sd3],zero,'wind')[0];assert.equal(native.points[0].value,points[0].windMs);assert.equal(native.initializationLabel,'Directory version');assert.equal(native.baseLabel,'First valid UTC');assert.equal(native.forecastZero,zero)
 const low={...sd3,model:'AIGFS',systemId:'WMC:20260131',kind:'low',points:points.map(p=>({...p,windMs:null})),method:'Local L, no wind',endReason:'ambiguous; stop'};assert.equal(extraIntensity([low],zero,'wind')[0].points.length,0);const pressure=extraIntensity([low],zero,'pressure')[0];assert.equal(pressure.definition,'low');assert.equal(pressure.points[0].value,points[0].pressureHpa)
 const csv=guidanceCsv([native,pressure]);assert.match(csv,/38\.94587466487593/);assert.match(csv,/TianJi Weather Science and Technology Company/);assert.match(csv,/CC BY-NC 4.0/);assert.match(csv,/First valid UTC/);assert.doesNotMatch(csv,/1\.943|calibrated wind/)
})
await test('UTC overview display window removes stale-run bias without moving or manufacturing fixes',()=>{
 const base='2026-10-14T12:00:00.000Z',later='2026-10-17T18:00:00.000Z',offset=(Date.parse(later)-Date.parse(base))/3600000
 const track=(model,zero,hours)=>({model,label:model,color:'red',initialization:zero,forecastZero:zero,source:'remote',points:hours.map(h=>({lat:12+h/100,lon:-110+h/100,leadHours:h+(Date.parse(zero)-Date.parse(base))/3600000}))})
 const data={base,tracks:[track('FENGQING',base,[offset,offset+6,offset+144]),track('wn2',later,[0,6,120,126])]};const saved=JSON.stringify(data),view=overviewWindow(data)
 assert.equal(view.base,later);assert.equal(view.tracks.length,1);assert.equal(view.older[0].model,'FENGQING');assert.deepEqual(view.tracks[0].points.map(p=>p.leadHours),[0,6,120]);assert.equal(JSON.stringify(data),saved);assert.equal(overviewWindow(data,0,true).tracks.length,2);assert.equal(overviewPointUtc(view.base,view.tracks[0].points[1]),'2026-10-18T00:00:00.000Z')
 const labels=overviewLabels(view.tracks,view.base,p=>({x:300+p.leadHours,y:300+p.leadHours}));assert.ok(labels.length<=2);assert.ok(labels.every(p=>/^\d\d-\d\d \d\dZ$/.test(p.text)))
})
await test('Medium-range zoom adds context only; existing category thresholds/colors and mean arithmetic are untouched',async()=>{
 const points=[{lat:12,lon:135},{lat:14,lon:140}],fallback={west:100,east:180,south:0,north:60},old=focusTrackRegion(points,fallback),wide=focusTrackRegion(points,fallback,1.5);assert.ok(wide.east-wide.west>old.east-old.west);assert.ok(wide.north-wide.south>old.north-old.south)
 assert.deepEqual(categories.map(c=>[c.min,c.color]),[[137,'#ef50ef'],[113,'#800000'],[96,'#ff0000'],[83,'#ff8000'],[64,'#f4d500'],[34,'#00aaff'],[25,'#009e00'],[0,'#00e617']]);assert.equal(zhHans('機率預報 · 花蓮 · 供應商均線'),'概率预报 · 花莲 · 供应商均线');assert.equal(zhHans(40.625),'40.625')
 const source=await readFile('src/components/IntensityPlot.vue','utf8');assert.match(source,/unit.value==='kt'/);assert.doesNotMatch(source,/stroke-dasharray/);assert.match(source,/CC BY-NC 4.0/)
})
