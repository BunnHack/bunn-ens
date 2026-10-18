import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { JSDOM } from 'jsdom'
import { compileFile } from './compile.mjs'
const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost/',pretendToBeVisual:true})
for(const key of ['window','document','Element','HTMLElement','SVGElement','Node','Event','MouseEvent','KeyboardEvent'])globalThis[key]=dom.window[key]
const fixture=JSON.parse(await readFile('tests/fixtures/zoom-storms.json','utf8')),csv=await readFile('public/data/FNV3P1_2026_10_13T00_00_cyclogenesis.csv','utf8'),requests=[],intervals=[]
const set=globalThis.setInterval,clear=globalThis.clearInterval,originalFetch=globalThis.fetch
globalThis.setInterval=(callback,ms)=>{const token={callback,ms};intervals.push(token);return token};globalThis.clearInterval=token=>{if(token)token.cleared=true}
globalThis.fetch=async raw=>{requests.push(raw);if(raw==='/api/current-storms')return Response.json(fixture);if(String(raw).startsWith('/api/wnc2'))return Response.json({csv,run:{model:'FNV3P1',date:'2026-10-13',cycle:'00z'},checkedAt:'2026-10-13T06:37:00Z'});return new Response('',{status:502})}
const {createApp,nextTick}=await import('vue'),{default:App}=await import(await compileFile('src/App.vue')),app=createApp(App);app.mount('#app')
const settle=async()=>{await new Promise(r=>setTimeout(r,50));await nextTick()},click=async selector=>{const el=document.querySelector(selector);assert.ok(el,selector);el.click();await settle()}
await settle()
await test('Current Storm home is data-backed instead of the obsolete screenshot dashboard',()=>{
 assert.equal(document.querySelector('h1').textContent,'Global Tropical Cyclone and Disturbance Information');assert.equal(document.querySelectorAll('.main-navigation a').length,6);assert.equal(document.querySelectorAll('#storm-select option').length,3);assert.equal(document.querySelector('#storm-select').value,'champi-2026');assert.match(document.querySelector('.storm-details').textContent,/130 kt.*934 hPa/);assert.ok(document.querySelector('.current-storm-map'));assert.equal(document.querySelectorAll('.satellite-image,.surface-image,.advertisement').length,0);assert.equal(document.querySelectorAll('.wnc2-ensemble,.wm6-ensemble').length,0);assert.ok(document.querySelector('.intensity-guidance'));assert.equal(document.querySelector('.main-navigation a').getAttribute('href'),'#main-content')
})
await test('Data notice explains the source identity boundary and never presents screenshots as live',async()=>{await click('.information-toggle');assert.match(document.querySelector('#data-information').textContent,/不按 Zoom 名字或编号尾数自动配对/);await click('.information-toggle');assert.equal(document.querySelector('#data-information'),null)})
await test('Display settings work, modal focus is trapped and Escape closes',async()=>{await click('[aria-label="Display settings"]');assert.equal(document.activeElement.getAttribute('aria-label'),'Close dialog');await click('.setting-row input');assert.ok(document.querySelector('.site-shell').classList.contains('compact'));document.querySelector('.dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await nextTick();assert.equal(document.querySelector('.dialog'),null)})
await test('Model source reference keeps ensemble, individual and derived definitions distinct',async()=>{await click('.models-heading .text-button');assert.match(document.querySelector('.acronyms').textContent,/WeatherNext 2 Cyclones.*forecast_zero.*CC BY-NC 4.0/);await click('.filled-button')})
await test('Internal navigation retains storm selection and suppresses all hidden Current Storm polling',async()=>{
 const selection=document.querySelector('#storm-select');selection.value='96a-2026';selection.dispatchEvent(new Event('change',{bubbles:true}));await nextTick();const count=requests.filter(u=>u==='/api/current-storms').length
 window.location.hash='#forecast-models';window.dispatchEvent(new Event('hashchange'));await settle();assert.equal(document.querySelector('#main-content').style.display,'none');for(const token of intervals)token.callback();await settle();assert.equal(requests.filter(u=>u==='/api/current-storms').length,count);assert.equal(document.querySelector('.current-storm-map'),null)
 window.location.hash='#main-content';window.dispatchEvent(new Event('hashchange'));await settle();assert.equal(document.querySelector('#storm-select').value,'96a-2026');assert.ok(document.querySelector('.current-storm-map'));assert.equal(requests.filter(u=>u==='/api/current-storms').length,count)
})
app.unmount();assert.ok(intervals.every(token=>token.cleared));globalThis.setInterval=set;globalThis.clearInterval=clear;globalThis.fetch=originalFetch;dom.window.close()
