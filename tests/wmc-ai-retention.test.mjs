import assert from 'node:assert/strict'
import {test} from 'node:test'
import {JSDOM} from 'jsdom'
import {compileFile} from './compile.mjs'
const dom=new JSDOM('<div id="app"></div>',{url:'https://example.test/'})
for(const k of ['window','document','Element','HTMLElement','SVGElement','Node'])globalThis[k]=dom.window[k]
const {createApp,h,ref,nextTick}=await import('vue'),{default:Panel}=await import(await compileFile('src/components/TrackOverview.vue'))
const points=[0,6].map(lead=>({datetime:'2026-10-17 12:00:00',validtime:`2026-10-17 ${lead?18:12}:00:00`,fcsthour:lead,lat:13,lon:145,windv:26.8,pressure:'',engname:'CHAMPI',fcsttype:'FUXI',xuhao:20260131,zone:'W'}))
const payload={entries:[{FCSTType:'FUXI',xuhao:20260131,enname:'CHAMPI',cname:'蔷琵',points}],source:'http://ew4all.wmc-bj.net/EW4ALL/typh/api/cmes-typhoonOcean/api/tcRealtime/getTyphoonConversionByCode',transport:'http',cycloneCode:'20260131',checkedAt:'2026-10-18T00:00:00Z'}
const settle=async()=>{await new Promise(r=>setTimeout(r,90));await nextTick()}
await test('AI refresh failures preserve dated tracks and both catalog/detail warnings across inactive return',async t=>{
 let fail=false,calls=0;t.mock.method(globalThis,'fetch',async url=>{calls++;return String(url).startsWith('/api/wmc')&&!fail?Response.json(payload):Response.json({error:'source unavailable'},{status:502})});const active=ref(true),app=createApp({render:()=>h(Panel,{active:active.value})});app.mount('#app');for(let i=0;i<4;i++)await settle();try{assert.ok(document.querySelector('[data-model="FUXI"]'));fail=true;document.querySelector('.track-overview header button').click();for(let i=0;i<4;i++)await settle();assert.ok(document.querySelector('[data-model="FUXI"]'));assert.match(document.querySelector('.track-overview').textContent,/AI目錄.*保留先前目錄/);assert.match(document.querySelector('.track-overview').textContent,/保留上次成功資料，非本次確認更新/);const previous=calls;active.value=false;await settle();active.value=true;await settle();assert.equal(calls,previous);assert.match(document.querySelector('.track-overview').textContent,/保留上次成功資料，非本次確認更新/)}finally{app.unmount()}
})
