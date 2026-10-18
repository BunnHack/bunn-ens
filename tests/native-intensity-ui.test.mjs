import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'
import {JSDOM} from 'jsdom'
import {compileFile} from './compile.mjs'
const dom=new JSDOM('<div id="app"></div>',{url:'https://example.test/',pretendToBeVisual:true})
for(const key of ['window','document','Element','HTMLElement','SVGElement','SVGSVGElement','Node'])globalThis[key]=dom.window[key]
const {createApp,nextTick}=await import('vue'),{default:Panel}=await import(await compileFile('src/components/IntensityGuidance.vue'))
const fixture=JSON.parse(await readFile(new URL('./fixtures/intensity-aids-EP212026.json',import.meta.url),'utf8'))
const settle=async()=>{await new Promise(r=>setTimeout(r,90));await nextTick()}
const q=s=>document.querySelector(s)
async function query(id){const input=q('[aria-label="NHC cyclone ID"]');input.value=id;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));q('.ig-nhc-query button').click();await settle();await settle()}
await test('Explicit NHC queries work without ensemble catalogues, preserve per-ID failures during backoff, and retry only NHC without consuming WM-6 quota',async t=>{
 const counts={};let total=0
 t.mock.method(globalThis,'fetch',async url=>{total++;const u=new URL(url,'https://example.test');if(u.pathname==='/api/intensity-aids'){const id=u.searchParams.get('storm');counts[id]=(counts[id]??0)+1;if(id==='EP212026'&&counts[id]>1)return Response.json(fixture)}return new Response('',{status:503})})
 const app=createApp(Panel);app.mount('#app');await settle();await settle()
 try{
  await query('champi-2026');assert.match(q('.ig-warning:last-of-type')?.textContent??q('.intensity-guidance').textContent,/请输入完整NHC编号/);assert.deepEqual(counts,{})
  await query('ep212026');assert.equal(q('[aria-label="Intensity cyclone"]').value,'EP212026');assert.equal(counts.EP212026,1);assert.match(q('.intensity-guidance').textContent,/NHC：.*503/);assert.equal(q('.intensity-model-curve'),null)
  await query('AL012026');assert.equal(counts.AL012026,1)
  const selected=q('[aria-label="Intensity cyclone"]');selected.value='EP212026';selected.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle();assert.equal(counts.EP212026,1);assert.match(q('.intensity-guidance').textContent,/NHC：.*503/)
  const before=total;q('.ig-nhc-retry').click();await settle();await settle();assert.equal(total,before+1);assert.equal(counts.EP212026,2);assert.ok(q('.intensity-model-curve[data-model="aid:OFCL"]'));assert.match(q('.intensity-model-curve[data-model="aid:OFCL"] .intensity-fix').textContent,/85.00 kt/);assert.match(q('[aria-label="Intensity cyclone"] option:checked').textContent,/NHC已验证归档/)
  assert.ok(![...document.querySelectorAll('.ig-warning')].some(e=>e.textContent.startsWith('NHC：')))
 }finally{app.unmount()}
})
