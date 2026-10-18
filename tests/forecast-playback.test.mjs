import assert from 'node:assert/strict'
import {test} from 'node:test'
import {writeFile} from 'node:fs/promises'
import {JSDOM} from 'jsdom'
import {compileFile} from './compile.mjs'
const dom=new JSDOM('<div id="app"></div>',{url:'https://example.test',pretendToBeVisual:true})
for(const key of ['window','document','Element','HTMLElement','SVGElement','Node','Image'])globalThis[key]=dom.window[key]
const {createApp,nextTick}=await import('vue'),data=await import(await compileFile('src/data/forecast-playback.ts')),{default:Dialog}=await import(await compileFile('src/components/ForecastGifDialog.vue'))
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGOUqzjBwMDAxMDAwMDAAAAP6AFiUX/w7AAAAABJRU5ErkJggg==','base64')
const asset=(hour=0,id='20261017T0300Z')=>`https://bunnhack.github.io/bunn-ens/forecast-models/runs/${id}/east-asia/wind/${String(hour).padStart(3,'0')}.png?publication=2026-10-17T04%3A00%3A00Z`
const item=hour=>({url:asset(hour),label:'+'+hour+'h'})
const tick=async()=>{await new Promise(resolve=>setTimeout(resolve,25));await nextTick()}
await test('Playback downloads every selected published hour with at most three requests, deduplicates compressed blobs and releases them',async t=>{
 let count=0,active=0,peak=0;const progress=[],revoked=[]
 t.mock.method(URL,'createObjectURL',()=>`blob:prepared-${++count}`);t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url))
 const fetcher=async(url,options)=>{assert.equal(options.credentials,'omit');assert.equal(options.cache,'force-cache');assert.equal(options.headers,undefined);active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,3));active--;return new Response(png)}
 const result=await data.preloadForecastImages([item(0),item(6),item(12),item(18),item(6)],new AbortController().signal,(done,total)=>progress.push([done,total]),fetcher)
 assert.equal(result.urls.size,4);assert.ok(peak<=3);assert.deepEqual(progress.at(-1),[4,4]);assert.equal(count,4);assert.equal(revoked.length,0);result.dispose();assert.equal(revoked.length,4);result.dispose();assert.equal(revoked.length,4)
})
await test('An incomplete or cancelled preload never returns a playable set; allocated URLs are revoked and private/invalid PNG inputs are rejected',async t=>{
 let count=0;const revoked=[],pending=[],progress=[];t.mock.method(URL,'createObjectURL',()=>`blob:pending-${++count}`);t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url))
 const controller=new AbortController(),fetcher=(url,options)=>new Promise((resolve,reject)=>{pending.push(()=>resolve(new Response(png)));options.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true})})
 let returned=false;const promise=data.preloadForecastImages([item(0),item(6),item(12),item(18)],controller.signal,done=>progress.push(done),fetcher).then(value=>{returned=true;return value});await tick();assert.equal(pending.length,3);pending[0]();await tick();assert.equal(returned,false);assert.deepEqual(progress,[1]);controller.abort();await assert.rejects(promise,/Cancelled/);assert.deepEqual(revoked,['blob:pending-1'])
 for(const url of ['https://private.example/a.png',asset().replace('000.png','../secret.png'),asset()+'&signed=private'])await assert.rejects(data.publicForecastPng(url,new AbortController().signal,async()=>{throw Error('must not fetch')}))
 await assert.rejects(data.publicForecastPng(asset(),new AbortController().signal,async()=>new Response('not PNG')),/有效PNG/)
 await assert.rejects(data.publicForecastPng(asset(),new AbortController().signal,async()=>new Response(png,{headers:{'Content-Length':9*1024*1024}})),/大小上限/)
 await assert.rejects(data.preloadForecastImages([item(0)],new AbortController().signal,()=>{},async()=>new Response('',{status:404})),/404/)
})
function canvasMocks(t){
 let count=0;const revoked=[];t.mock.method(URL,'createObjectURL',()=>`blob:gif-${++count}`);t.mock.method(URL,'revokeObjectURL',url=>revoked.push(url))
 class MockImage{naturalWidth=4;naturalHeight=2;onload=null;onerror=null;set src(value){this._src=value;if(value)queueMicrotask(()=>this.onload?.())}get src(){return this._src}}
 t.mock.property(globalThis,'Image',MockImage)
 t.mock.method(dom.window.HTMLCanvasElement.prototype,'getContext',()=>({fillStyle:'#fff',fillRect(){},drawImage(){},getImageData(){return{data:Uint8ClampedArray.from(Array.from({length:8},(_,i)=>[i*30,100,200,255]).flat())}}}))
 return revoked
}
await test('GIF encoder creates real GIF89a frames with the requested speed, honors abort and never requires a private API',async t=>{
 const revoked=canvasMocks(t),progress=[];const bytes=await data.forecastGifBlob([item(6),item(12)],4,new AbortController().signal,done=>progress.push(done),new Map([[asset(6),'blob:cached6'],[asset(12),'blob:cached12']]))
 assert.equal(bytes.type,'image/gif');const buffer=Buffer.from(await bytes.arrayBuffer());assert.equal(buffer.subarray(0,6).toString(),'GIF89a');assert.equal(buffer.readUInt16LE(6),4);assert.equal(buffer.readUInt16LE(8),2);assert.equal(buffer.at(-1),59);assert.equal(buffer.toString('latin1').split('\x21\xf9\x04').length-1,2);assert.ok(buffer.includes(Buffer.from([33,249,4,4,25,0,0,0])));assert.deepEqual(progress,[1,2]);assert.equal(revoked.length,0);await writeFile('.tmp/forecast-gif-unit.gif',buffer)
 const controller=new AbortController();controller.abort();await assert.rejects(data.forecastGifBlob([item(6)],4,controller.signal,()=>{}),/Cancelled/);await assert.rejects(data.forecastGifBlob([item(6)],0,new AbortController().signal,()=>{}),/設定無效/)
})
const run=(id,zero)=>({id,forecastZero:zero,initializationTime:id==='20261017T0300Z'?'2026-10-17T03:00:00Z':'2026-10-16T21:00:00Z',generatedAt:'2026-10-17T04:00:00Z',frames:[0,6,12,18,24].map(hour=>({hour,validTime:new Date(Date.parse(zero)+hour*3600000).toISOString(),files:{'east-asia':{wind:{png:`runs/${id}/east-asia/wind/${String(hour).padStart(3,'0')}.png`,svg:`runs/${id}/east-asia/wind/${String(hour).padStart(3,'0')}.svgz`}}}}))})
const select=async(selector,value)=>{const node=document.querySelector(selector);node.value=String(value);node.dispatchEvent(new dom.window.Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));await tick()}
await test('Forecast GIF dialog applies start/end/skip/speed, produces preview and actual download, invalidates it after setting changes',async t=>{
 canvasMocks(t);const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return new Response(png)})
 const current=run('20261017T0300Z','2026-10-17T00:00:00Z'),app=createApp(Dialog,{kind:'forecast',run:current,runs:[current],region:'east-asia',product:'wind',hour:12});app.mount('#app');await tick()
 try{assert.equal(document.body.style.overflow,'hidden');await select('[aria-label="GIF start hour"]',6);await select('[aria-label="GIF end hour"]',18);await select('[aria-label="GIF skip every"]',1);await select('[aria-label="GIF speed"]',4);document.querySelector('.fg-create').click();await tick();await tick();assert.ok(document.querySelector('.fg-preview'));assert.match(document.querySelector('.fg-body a').download,/6-18h-skip1-4fps.gif$/);assert.deepEqual(calls.map(call=>new URL(call.url).pathname.split('/').pop()),['006.png','018.png']);assert.ok(calls.every(call=>call.options.credentials==='omit'));await select('[aria-label="GIF speed"]',5);assert.equal(document.querySelector('.fg-preview'),null);assert.equal(document.querySelector('.fg-body a'),null)}finally{app.unmount();assert.equal(document.body.style.overflow,'')}
})
await test('Trend GIF compares distinct forecast bases at exactly one UTC valid time, not equal lead hours or duplicate hourly versions',async t=>{
 canvasMocks(t);const calls=[];t.mock.method(globalThis,'fetch',async url=>{calls.push(String(url));return new Response(png)})
 const current=run('20261017T0300Z','2026-10-17T00:00:00Z'),old=run('20261016T2100Z','2026-10-16T18:00:00Z'),duplicate={...current,id:'20261017T0200Z'}
 const app=createApp(Dialog,{kind:'trend',run:current,runs:[current,duplicate,old],region:'east-asia',product:'wind',hour:12});app.mount('#app');await tick()
 try{assert.match(document.querySelector('.fg-dialog').textContent,/可用 2 個不同預報基準/);assert.match(document.querySelector('.fg-dialog').textContent,/2026-10-17 12:00:00 UTC/);assert.equal(document.querySelector('.fg-create').disabled,false);await select('[aria-label="GIF runs"]',3);assert.equal(document.querySelector('.fg-create').disabled,true);await select('[aria-label="GIF runs"]',2);document.querySelector('.fg-create').click();await tick();await tick();assert.ok(document.querySelector('.fg-preview'));assert.match(calls[0],/20261016T2100Z.+018.png/);assert.match(calls[1],/20261017T0300Z.+012.png/);assert.equal(calls.length,2)}finally{app.unmount()}
})
dom.window.close()
