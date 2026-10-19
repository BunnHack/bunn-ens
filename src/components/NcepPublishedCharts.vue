<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { loadNcepManifest, ncepAsset, ncepCatalog, NCEP_CHARTS, type NcepManifest } from '../data/ncep'
import { projectNcep, type NcepDataset } from '../../shared/ncep-protocol.js'
import { currentPotentialId, currentSelectionNote, type CurrentSelection } from '../data/current-selection'
import { clearRequestCache } from '../data/request-cache'
import ChartFrame from './ChartFrame.vue'
const props=withDefaults(defineProps<{model?:'gefs'|'aigefs';mode?:'basin'|'typhoon';active?:boolean;selection?:CurrentSelection}>(),{mode:'basin',active:true})
const manifest=shallowRef<NcepManifest>(),data=shallowRef<NcepDataset>(),modelChoice=ref('GEFS'),run=ref('latest'),product=ref(props.mode==='typhoon'?'track':'region'),region=ref('wp'),manualStorm=ref('WP292026'),error=ref(''),loading=ref(false),loaded=ref('')
const model=computed(()=>props.model?.toUpperCase()??modelChoice.value),records=computed(()=>manifest.value?.records.filter(r=>r.model===model.value).sort((a,b)=>b.run.localeCompare(a.run))??[]),record=computed(()=>run.value==='latest'?records.value[0]:records.value.find(r=>r.run===run.value))
const storm=computed(()=>props.selection?(data.value?currentPotentialId(props.selection,{catalog:ncepCatalog(data.value),ncep:data.value,details:{},source:'remote',checkedAt:data.value.checkedAt}):''):manualStorm.value)
const pair=computed(()=>{const r=record.value;if(!r||props.selection&&!storm.value)return;return product.value==='region'?r.regions.find(v=>v.id===region.value):r.storms.find(v=>v.id===storm.value)?.[product.value as 'track'|'wind'|'pressure']})
const image=computed(()=>{try{return record.value&&pair.value?ncepAsset(pair.value.png,record.value)+'?v='+record.value.sourceSha256.slice(0,12):''}catch{return ''}})
const filename=computed(()=>`${model.value}-${record.value?.run.replace(/[-:]/g,'')}-${product.value==='region'?region.value:storm.value}-${product.value}`)
const labels:Record<string,string>={world:'全球',wp:'西北太平洋',ep:'东北太平洋',al:'大西洋',ni:'北印度洋',si:'南印度洋',sp:'南太平洋'}
let controller:AbortController|undefined,sourceController:AbortController|undefined,revision=0,sourceRevision=0
async function refresh(force=false){controller?.abort();if(!props.active)return;const token=++revision;controller=new AbortController();loading.value=true;error.value='';if(force)clearRequestCache(fetch,NCEP_CHARTS+'index.json');try{const value=await loadNcepManifest(controller.signal);if(token===revision)manifest.value=value}catch(e){if(token===revision&&!controller.signal.aborted)error.value=e instanceof Error?e.message:String(e)}finally{if(token===revision)loading.value=false}}
async function source(){
 const token=++sourceRevision;sourceController?.abort();data.value=undefined;const r=record.value;if(!props.active||!props.selection||!r)return
 sourceController=new AbortController();const signal=AbortSignal.any([sourceController.signal,AbortSignal.timeout(30_000)]);error.value=''
 try{
  const response=await fetch(ncepAsset(r.data,r)+'?v='+r.sourceSha256.slice(0,12),{signal,credentials:'omit',redirect:'error'});if(!response.ok||!response.body)throw Error('此起报来源未能读取')
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
  try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>16_000_000){await reader.cancel();throw Error('来源资料过大')}chunks.push(chunk.value)}}finally{reader.releaseLock()}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length}
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');if(digest!==r.sourceSha256)throw Error('成图与来源版本不符，等待同步；不借其他系统补图')
  const value=projectNcep(JSON.parse(new TextDecoder().decode(bytes)),r.model,r.run);if(token===sourceRevision&&!signal.aborted)data.value=value
 }catch(e){if(token===sourceRevision)error.value=e instanceof Error?e.message:String(e)}
}
watch(()=>props.model,()=>run.value='latest');watch([record,()=>props.active],()=>void source());watch(()=>!!props.selection,()=>void source())
watch(image,()=>loaded.value='',{flush:'sync'})
watch(()=>props.active,a=>{if(a)void refresh();else{++revision;++sourceRevision;controller?.abort();sourceController?.abort();loading.value=false}},{immediate:true})
function imageLoaded(event:Event){const img=event.target as HTMLImageElement;if(img.currentSrc===image.value||img.src===image.value)loaded.value=image.value}
onBeforeUnmount(()=>{++revision;++sourceRevision;controller?.abort();sourceController?.abort()})
</script>
<template>
<section class="ncep-published" :data-model="model">
<header><h3>{{ model }} 集合预报</h3><button :disabled="loading" @click="refresh(true)">更新资料</button></header>
<div class="ncep-controls"><label v-if="!props.model">模型<select v-model="modelChoice" @change="run='latest'" aria-label="Published NCEP model"><option>GEFS</option><option>AIGEFS</option></select></label><label>起报UTC<select v-model="run" aria-label="Published NCEP initialization"><option value="latest">最新已发布</option><option v-for="r in records" :key="r.run" :value="r.run">{{ r.run }}</option></select></label><label>产品<select v-model="product" aria-label="Published NCEP product"><option v-if="!selection" value="region">洋区轨迹</option><option value="track">成员路径</option><option value="wind">风速kt</option><option value="pressure">气压hPa</option></select></label><label v-if="product==='region'&&!selection">洋区<select v-model="region" aria-label="Published NCEP basin"><option v-for="r in record?.regions??[]" :key="r.id" :value="r.id">{{ labels[r.id]??r.label }}</option></select></label><label v-else-if="!selection">系统<select v-model="manualStorm" aria-label="Published NCEP cyclone"><option v-for="s in record?.storms??[]" :key="s.id" :value="s.id">{{ s.id }}</option></select></label></div>
<p v-if="selection">{{ selection.storm?.name??'等待Current Storm' }}{{ storm?' · '+storm:' · 尚无唯一来源对照，不借其他系统补图' }}</p>
<p v-if="loading" role="status">读取已发布资料…</p><p v-if="error" role="alert">{{ error }}</p>
<template v-if="record"><p class="ncep-status">{{ record.run }} · +0–{{ record.horizonHours }}h · tracker {{ record.trackerMembers }}/31<span v-if="model==='AIGEFS'"> · 场L {{ record.derived.fields }}/1271</span> · 产图 {{ record.generatedAt }}</p>
<ChartFrame v-if="image&&active" :key="image" :filename="filename" :title="`${model} ${storm} ${product}`" :png="image"><img class="ncep-image" :src="image" v-show="loaded===image" :alt="`${model} ${record.run} ${storm} ${product}`" @load="imageLoaded" @error="error='所选成图未能读取，不显示其他图替代'"/><p v-if="loaded!==image&&!error">读取成图…</p></ChartFrame><p v-else-if="!image">此系统／产品暂无可用成图。</p></template>
<small v-if="selection">{{ currentSelectionNote }}</small>
</section>
</template>
<style scoped>
.ncep-published{min-width:0;background:white;color:#526f85;padding:12px;border-radius:9px}.ncep-published header,.ncep-controls{display:flex;flex-wrap:wrap;align-items:end;gap:10px 16px}.ncep-published header{justify-content:space-between;align-items:center}.ncep-published h3{font-size:17px;margin:5px 0 12px}.ncep-published label{display:grid;gap:4px;font-size:12px;max-width:100%;min-width:0}.ncep-published select{padding:7px;border:1px solid #cbdce7;border-radius:5px;background:white;max-width:100%;color:inherit}.ncep-published button{font-size:12px;color:#217d9b;padding:8px 12px;border:1px solid #80b8ca;background:#f1fafc;border-radius:18px}.ncep-published p,.ncep-published small{font-size:11px;line-height:1.8}.ncep-image{display:block;width:100%;height:auto}@media(max-width:600px){.ncep-published{padding:7px}.ncep-controls label{flex:1 1 42%}}
</style>
