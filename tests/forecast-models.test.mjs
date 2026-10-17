import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'
const dom=new JSDOM('<div id="app"></div>',{url:'https://example.test/',pretendToBeVisual:true})
for(const key of ['window','document','Element','HTMLElement','SVGElement','Node'])globalThis[key]=dom.window[key]
const {createApp,nextTick}=await import('vue')
const data=await import(await compileFile('src/data/forecast-models.ts'))
const {default:Panel}=await import(await compileFile('src/components/ForecastModels.vue'))
const {default:App}=await import(await compileFile('src/App.vue'))
const makeRun=(hour)=>{const id=`20261017T0${hour}00Z`,zero='2026-10-17T00:00:00Z';return{id,initializationTime:`2026-10-17T0${hour}:00:00Z`,forecastZero:zero,generatedAt:'2026-10-17T04:00:00Z',upstreamInProgress:false,requestedMaxHour:312,upstreamHours:[0,3,6,9,12,15,18],failures:[],animations:{'east-asia':{precip:`runs/${id}/east-asia/precip/forecast.gif`}},trends:hour===3?{'east-asia':{precip:{12:`runs/${id}/east-asia/precip/trend-012.gif`}}}:{},frames:[0,6,12,18].map(h=>({hour:h,validTime:new Date(Date.parse(zero)+h*3600000).toISOString(),files:Object.fromEntries(['east-asia','west-pacific'].map(r=>[r,Object.fromEntries(['precip','wind','upper','temperature'].filter(p=>h>0||p!=='precip').map(p=>[p,{png:`runs/${id}/${r}/${p}/${String(h).padStart(3,'0')}.png`,svg:`runs/${id}/${r}/${p}/${String(h).padStart(3,'0')}.svg` }]))]))}))}}
const fixture=()=>({version:1,model:'WM-6',statistic:'ensemble_mean',ensembleSize:128,resolutionDegrees:.25,runs:[makeRun(3),makeRun(2)]})
const settle=async()=>{await new Promise(r=>setTimeout(r,40));await nextTick()}
const click=async(selector,text)=>{const button=[...document.querySelectorAll(selector)].find(e=>!text||e.textContent.includes(text));assert.ok(button,selector+' '+text);button.click();await settle()}
const select=async(selector,value)=>{const node=document.querySelector(selector);node.value=value;node.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle()}
await test('Generated chart manifest enforces WM-6 statistic, source paths, run identity and forecast_zero rather than publication init',()=>{
 const parsed=data.parseForecastManifest(fixture());assert.equal(parsed.runs[0].frames[2].validTime,'2026-10-17T12:00:00.000Z')
 assert.equal(data.availableForecastFrames(parsed.runs[0],'east-asia','precip').length,3)
 assert.equal(data.availableForecastFrames(parsed.runs[0],'east-asia','wind').length,4)
 for(const mutate of [x=>x.model='GFS',x=>x.statistic='deterministic',x=>x.runs[0].id='20261017T0400Z',x=>x.runs[0].frames[2].validTime='2026-10-17T15:00:00Z',x=>x.runs[0].frames[2].hour=318,x=>x.runs[0].frames[2].files['east-asia'].precip.png='https://evil.test/map.png',x=>x.runs[0].frames.push(x.runs[0].frames[2])]){const bad=fixture();mutate(bad);assert.throws(()=>data.parseForecastManifest(bad))}
 assert.throws(()=>data.forecastAssetUrl('../secrets.json'));assert.throws(()=>data.forecastAssetUrl('https://evil.test/x.png'))
 assert.match(data.forecastAssetUrl(parsed.runs[0].frames[2].files['east-asia'].precip.svg),/^https:\/\/bunnhack.github.io\/bunn-ens\/forecast-models\/runs\//)
})
await test('Manifest fetch is public and rejects missing or malformed publication instead of falling back to a screenshot',async()=>{
 let options
 const good=await data.loadForecastManifest(undefined,async(url,o)=>{options=o;assert.equal(url,data.FORECAST_BASE+'index.json');return Response.json(fixture())})
 assert.equal(good.runs.length,2);assert.equal(options.credentials,'omit');assert.equal(options.headers,undefined)
 await assert.rejects(data.loadForecastManifest(undefined,async()=>new Response('',{status:404})),/尚未發布/)
 await assert.rejects(data.loadForecastManifest(undefined,async()=>Response.json({model:'GFS'})),/格式/)
})
await test('Screenshot-style viewer switches products, runs, regions and actual frames; absent hours cannot show stale charts',async t=>{
 t.mock.method(globalThis,'fetch',async()=>Response.json(fixture()))
 const app=createApp(Panel);app.mount('#app');await settle()
 try{
  assert.equal(document.querySelectorAll('.fm-tabs button').length,5);assert.equal(document.querySelectorAll('.fm-tabs button:disabled').length,4)
  assert.equal(document.querySelectorAll('.fm-products > button').length,4)
  assert.equal(document.querySelectorAll('.fm-hour-grid button').length,53)
  assert.ok(document.querySelector('[aria-label="Forecast hour 0"]').disabled);assert.ok(document.querySelector('[aria-label="Forecast hour 312"]').disabled)
  assert.match(document.querySelector('.fm-chart-image').src,/20261017T0300Z\/east-asia\/precip\/012.png$/)
  assert.match(document.querySelector('.fm-time-anchor').textContent,/Forecast zero: 2026-10-17 00:00:00 UTC/)
  assert.match(document.querySelector('.fm-time-anchor').textContent,/Valid: 2026-10-17 12:00:00 UTC/)
  await click('[aria-label="Previous forecast frame"]');assert.match(document.querySelector('.fm-chart-image').src,/006.png$/)
  await click('.fm-products > button','Lower Dynamics');await click('[aria-label="Forecast hour 0"]');assert.match(document.querySelector('.fm-chart-image').src,/wind\/000.png$/)
  await click('.fm-bottom-controls button','Prev. Run');assert.match(document.querySelector('.fm-chart-image').src,/20261017T0200Z/)
  await select('[aria-label="Forecast region"]','north-america');assert.equal(document.querySelector('.fm-chart-image'),null);assert.match(document.querySelector('.fm-empty').textContent,/尚無已發布圖資/)
  await select('[aria-label="Forecast region"]','west-pacific');assert.match(document.querySelector('.fm-chart-image').src,/west-pacific\/wind\/000.png$/)
  document.querySelector('.fm-chart-image').dispatchEvent(new dom.window.Event('error'));await settle();assert.match(document.querySelector('[role="alert"]').textContent,/未以其他初始化或產品替代/)
 }finally{app.unmount()}
})
await test('Viewer supports keyboard/playback, fullscreen/Escape, zoom and blob-backed SVG/PNG/GIF downloads',async t=>{
 const intervals=[],downloads=[]
 t.mock.method(globalThis,'setInterval',(callback,ms)=>{intervals.push({callback,ms});return intervals.length})
 t.mock.method(globalThis,'clearInterval',()=>{})
 t.mock.method(globalThis,'fetch',async url=>String(url).endsWith('index.json')?Response.json(fixture()):new Response('test generated image'))
 t.mock.method(URL,'createObjectURL',()=> 'blob:forecast-test');t.mock.method(URL,'revokeObjectURL',()=>{})
 t.mock.method(dom.window.HTMLAnchorElement.prototype,'click',function(){downloads.push(this.download)})
 const app=createApp(Panel);app.mount('#app');await settle()
 try{
  document.querySelector('.fm-chart-image').dispatchEvent(new dom.window.Event('load'));await settle()
  await click('.fm-play');intervals.find(i=>i.ms===900).callback();await settle();assert.match(document.querySelector('.fm-chart-image').src,/018.png$/)
  await click('.fm-play');document.querySelector('#forecast-models').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));await settle();assert.match(document.querySelector('.fm-chart-image').src,/012.png$/)
  await click('.fm-image-controls button','放大地圖');assert.ok(document.querySelector('.fm-display-enlarged'));assert.equal(document.body.style.overflow,'hidden')
  await click('[aria-label="Zoom in forecast map"]');assert.match(document.querySelector('.fm-chart-image').style.width,/125%/)
  document.querySelector('.fm-display').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await settle();assert.equal(document.querySelector('.fm-display-enlarged'),null);assert.equal(document.body.style.overflow,'')
  for(const label of ['下載 SVG','下載 PNG'])await click('.fm-image-controls button',label)
  await click('.fm-bottom-controls button','FORECAST GIF');await click('.fm-bottom-controls button','TREND GIF')
  assert.deepEqual(downloads.map(n=>n.split('-').pop()),['012.svg','012.png','forecast.gif','012.gif'])
 }finally{app.unmount()}
})
await test('Refresh failure preserves and labels previously published chart data',async t=>{
 let fail=false;t.mock.method(globalThis,'fetch',async()=>fail?new Response('',{status:503}):Response.json(fixture()))
 const app=createApp(Panel);app.mount('#app');await settle()
 try{const src=document.querySelector('.fm-chart-image').src;fail=true;await click('.fm-refresh');assert.equal(document.querySelector('.fm-chart-image').src,src);assert.match(document.querySelector('[role="alert"]').textContent,/保留先前已發布圖資/)}finally{app.unmount()}
})
await test('Forecast Models is an internal deep link and returning to storms preserves the existing ensemble selection',async t=>{
 const csv=await readFile('public/data/FNV3P1_2026_10_13T00_00_cyclogenesis.csv','utf8')
 t.mock.method(globalThis,'fetch',async url=>String(url).startsWith(data.FORECAST_BASE)?Response.json(fixture()):String(url).startsWith('/api/wnc2')?Response.json({csv,run:{model:'FNV3P1',date:'2026-10-13',cycle:'00z'},checkedAt:'2026-10-17T04:00:00Z'}):new Response('',{status:502}))
 const app=createApp(App);app.mount('#app');await settle()
 try{
  const lead=document.querySelector('[aria-label="Maximum forecast lead hours"]');lead.value='120';lead.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await settle()
  const link=[...document.querySelectorAll('.main-navigation a')].find(a=>a.textContent==='Forecast Models');assert.equal(link.getAttribute('href'),'#forecast-models');assert.equal(link.getAttribute('target'),null)
  window.location.hash='#forecast-models';await settle();assert.ok(document.querySelector('.fm-layout'));assert.equal(document.querySelector('.main-navigation [aria-current="page"]').textContent,'Forecast Models');assert.equal(document.querySelector('#main-content').style.display,'none');assert.equal(document.activeElement,document.querySelector('#forecast-models h1'))
  window.location.hash='#main-content';await settle();assert.equal(document.querySelector('#forecast-models'),null);assert.equal(lead.value,'120');assert.equal(document.querySelector('#main-content').style.display,'')
 }finally{app.unmount();window.location.hash=''}
})
await test('Actions limits credentials to generation and publishes only chart assets on a schedule',async()=>{
 const yaml=await readFile('.github/workflows/wm6-forecast-charts.yml','utf8')
 assert.match(yaml,/schedule:/);assert.match(yaml,/secrets.WM_API_KEY/);assert.match(yaml,/id-token: write/);assert.match(yaml,/actions\/deploy-pages@/);assert.match(yaml,/path: .generated-site\n/);assert.ok(!/secrets.GITHUB|ghp_|wb_[A-Za-z0-9_-]{20}/.test(yaml))
 const py=await readFile('scripts/wm6_forecast.py','utf8');assert.match(py,/ThreadPoolExecutor\(max_workers=2\)/);assert.match(py,/verify_metadata\(dataset.attrs, run, hour\)/)
})
dom.window.close()
