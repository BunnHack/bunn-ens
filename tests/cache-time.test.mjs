import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compileFile } from './compile.mjs'
import worker from '../public/_worker.js'
const { cachedJson, clearRequestCache } = await import(await compileFile('src/data/request-cache.ts'))
const { loadWm6Availability } = await import(await compileFile('src/data/wm6-availability.ts'))
const { publicationStatus } = await import(await compileFile('src/data/forecast-status.ts'))
await test('Same-tab JSON shares in-flight requests; aborting one reader does not cancel another; resolved entries expire after five minutes', async t => {
 let clock=0,calls=0,finish,upstreamSignal
 t.mock.method(Date,'now',()=>clock)
 const fetcher=async (url,options)=>{calls++;upstreamSignal=options.signal;return new Promise(resolve=>{finish=()=>resolve(Response.json({version:calls}))})}
 const a=new AbortController(),b=new AbortController()
 const first=cachedJson('/api/wm6?b=2&a=1',a.signal,fetcher),second=cachedJson('/api/wm6?a=1&b=2',b.signal,fetcher)
 assert.equal(calls,1);a.abort();await assert.rejects(first,{name:'AbortError'});assert.equal(upstreamSignal.aborted,false)
 finish();assert.deepEqual(await second,{version:1});assert.deepEqual(await cachedJson('/api/wm6?a=1&b=2',undefined,fetcher),{version:1});assert.equal(calls,1)
 clock=300000;const expired=cachedJson('/api/wm6?a=1&b=2',undefined,fetcher);finish();assert.deepEqual(await expired,{version:2})
 clearRequestCache(fetcher,'/api/wm6');const forced=cachedJson('/api/wm6?a=1&b=2',undefined,fetcher);finish();assert.deepEqual(await forced,{version:3})
})
await test('Cancelling all readers aborts and evicts the shared request; failed HTTP responses are never cached',async()=>{
 let signal,calls=0
 const pending=async(url,options)=>{calls++;signal=options.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}
 const controller=new AbortController(),request=cachedJson('/api/wm6',controller.signal,pending);controller.abort();await assert.rejects(request,{name:'AbortError'});assert.equal(signal.aborted,true)
 const another=new AbortController(),retry=cachedJson('/api/wm6',another.signal,pending);assert.equal(calls,2);another.abort();await assert.rejects(retry,{name:'AbortError'})
 let attempts=0;const fails=async()=>{attempts++;return new Response('',{status:503})}
 for(let i=0;i<2;i++)await assert.rejects(cachedJson('/api/wm6',undefined,fails),/503/)
 assert.equal(attempts,2)
})
await test('Availability is separate from publication; hourly provider versions never become forecast-zero or a false latest claim',async()=>{
 const zero='2026-10-17T00:00:00Z',published={initializationTime:'2026-10-17T03:00:00Z',forecastZero:zero}
 assert.match(publicationStatus(published,{initializationTime:'2026-10-17T08:00:00Z',forecastZero:'2026-10-17T06:00:00Z'}),/較舊/)
 assert.match(publicationStatus(published,{initializationTime:'2026-10-17T02:00:00Z',forecastZero:zero}),/查詢落後/)
 assert.match(publicationStatus(published,{...published,forecastZero:'2026-10-16T18:00:00Z'}),/不一致/)
 assert.match(publicationStatus(published,published),/此次查詢/)
 assert.match(publicationStatus(published,{initializationTime:'2026-10-17T08:00:00Z',forecastZero:zero}),/同一預報基準/)
 assert.match(publicationStatus(published,{initializationTime:'2026-10-17T08:00:00Z',forecastZero:zero}),/未宣稱其數值相同/)
 assert.ok(!publicationStatus(published,{initializationTime:'2026-10-17T08:00:00Z',forecastZero:zero}).includes('等待排程產圖'))
 const good={initializationTime:'2026-10-17T08:00:00Z',forecastZero:'2026-10-17T06:00:00Z',inProgress:false,hours:[0,3,312],checkedAt:'2026-10-17T09:00:00Z'}
 assert.deepEqual(await loadWm6Availability(undefined,async()=>Response.json(good)),good)
 await assert.rejects(loadWm6Availability(undefined,async()=>Response.json({...good,forecastZero:'not known'})),/無效/)
})
await test('Public availability endpoint authenticates one fixed metadata request, strips unknown fields, caches, and never exposes its credential',async t=>{
 const entries=new Map(),jobs=[],calls=[]
 const previous=globalThis.caches;t.after(()=>{globalThis.caches=previous})
 globalThis.caches={default:{match:async key=>entries.get(key.url)?.clone(),put:async(key,response)=>{entries.set(key.url,response)}}}
 t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return Response.json({initialization_time:'2026-10-17T08:00:00Z',forecast_zero:'2026-10-17T06:00:00Z',in_progress:false,available:[{forecast_hour:0},{forecast_hour:3},{forecast_hour:312},{forecast_hour:315},{forecast_hour:-1}],private_url:'https://private.invalid/',unneeded:'discard'})})
 const env={WM_API_KEY:'test-key',ASSETS:{fetch:()=>new Response('asset')}},ctx={waitUntil:promise=>jobs.push(promise)},request=new Request('https://example.test/api/wm6/availability')
 const response=await worker.fetch(request,env,ctx),value=await response.json();await Promise.all(jobs)
 assert.equal(response.status,200);assert.deepEqual(value.hours,[0,3,312]);assert.equal(value.forecastZero,'2026-10-17T06:00:00Z');assert.equal(calls[0].url,'https://api.windbornesystems.com/forecasts/v1/wm-6/run_information');assert.equal(calls[0].options.headers.authorization,'Bearer test-key');assert.ok(!JSON.stringify(value).includes('test-key'));assert.equal(value.private_url,undefined)
 assert.equal((await worker.fetch(request,env,ctx)).status,200);assert.equal(calls.length,1)
 assert.equal((await worker.fetch(new Request(request.url+'?url=https://private.invalid'),env,ctx)).status,400)
 assert.equal((await worker.fetch(new Request(request.url,{method:'POST'}),env,ctx)).status,405)
})
