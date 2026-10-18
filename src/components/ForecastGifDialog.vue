<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { availableForecastFrames, forecastAssetUrl, forecastUtc, type ForecastRun, type ForecastProduct, type ForecastRegion } from '../data/forecast-models'
import { forecastGifBlob, type ForecastImage } from '../data/forecast-playback'
const props=defineProps<{ kind:'forecast'|'trend'; run:ForecastRun; runs:ForecastRun[]; region:ForecastRegion; product:ForecastProduct; hour:number; cached?:ReadonlyMap<string,string> }>()
const emit=defineEmits<{close:[]}>()
const root=ref<HTMLElement|null>(null),frames=availableForecastFrames(props.run,props.region,props.product)
const start=ref(frames[0]?.hour??0),end=ref(frames[frames.length-1]?.hour??0),fps=ref(3),skip=ref(0),runsCount=ref(2),busy=ref(false),progress=ref(0),error=ref(''),preview=ref(''),ready=ref(false)
let controller:AbortController|undefined,revision=0,oldOverflow='',previousFocus:HTMLElement|null=null
const validTime=props.run.frames.find(item=>item.hour===props.hour)?.validTime
const matching=computed(()=>{
 const seen=new Set<number>()
 return props.runs.filter(run=>Date.parse(run.forecastZero)<=Date.parse(props.run.forecastZero)).sort((a,b)=>Date.parse(b.forecastZero)-Date.parse(a.forecastZero)).flatMap(run=>{
   const key=Date.parse(run.forecastZero),frame=availableForecastFrames(run,props.region,props.product).find(item=>item.validTime===validTime)
   if(seen.has(key)||!frame)return[];seen.add(key);return[{run,frame}]
 })
})
function asset(run:ForecastRun,path:string){return forecastAssetUrl(path)+'?publication='+encodeURIComponent(run.generatedAt)}
const images=computed<ForecastImage[]>(()=>props.kind==='forecast'?frames.filter(item=>item.hour>=start.value&&item.hour<=end.value).filter((_,index)=>index%(skip.value+1)===0).map(item=>({url:asset(props.run,item.files[props.region]![props.product]!.png),label:'+'+item.hour+'h · '+item.validTime})):matching.value.slice(0,runsCount.value).reverse().map(({run,frame})=>({url:asset(run,frame.files[props.region]![props.product]!.png),label:run.forecastZero+' · +'+frame.hour+'h'})))
const valid=computed(()=>Number.isInteger(fps.value)&&fps.value>=1&&fps.value<=12&&Number.isInteger(skip.value)&&skip.value>=0&&skip.value<=12&&images.value.length>0&&(props.kind==='forecast'?start.value<=end.value:Number.isInteger(runsCount.value)&&runsCount.value>=2&&runsCount.value<=matching.value.length))
const filename=computed(()=>'WM6-'+props.run.id+'-'+props.region+'-'+props.product+'-'+props.kind+'-'+(props.kind==='forecast'?start.value+'-'+end.value+'h-skip'+skip.value:props.hour+'h-'+runsCount.value+'bases')+'-'+fps.value+'fps.gif')
function resetPreview(){if(preview.value)URL.revokeObjectURL(preview.value);preview.value='';ready.value=false}
watch([start,end,fps,skip,runsCount],resetPreview)
async function create(){
 if(!valid.value||busy.value)return
 resetPreview();const token=++revision,active=new AbortController();controller=active;busy.value=true;error.value='';progress.value=0
 try{const blob=await forecastGifBlob(images.value,fps.value,active.signal,done=>{if(token===revision)progress.value=done},props.cached);if(token===revision&&!active.signal.aborted){preview.value=URL.createObjectURL(blob);ready.value=true}}
 catch(cause){if(!active.signal.aborted&&token===revision)error.value=cause instanceof Error?cause.message:String(cause)}
 finally{if(token===revision)busy.value=false}
}
function close(){++revision;controller?.abort();emit('close')}
function keyboard(event:KeyboardEvent){
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close()}
 if(event.key==='Tab'){const nodes=[...root.value!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')],first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&(document.activeElement===first||document.activeElement===root.value)){event.preventDefault();last?.focus()}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===root.value)){event.preventDefault();first?.focus()}}
}
onMounted(async()=>{previousFocus=document.activeElement as HTMLElement;oldOverflow=document.body.style.overflow;document.body.style.overflow='hidden';await nextTick();root.value?.focus()})
onBeforeUnmount(()=>{++revision;controller?.abort();resetPreview();document.body.style.overflow=oldOverflow;previousFocus?.focus()})
</script>
<template>
 <Teleport to="body"><div class="fg-backdrop" @click.self="close"><section ref="root" class="fg-dialog" role="dialog" aria-modal="true" :aria-label="kind==='forecast'?'Make a Forecast GIF':'Make a Trend GIF'" tabindex="-1" @keydown="keyboard">
 <header><h2>Make a {{ kind==='forecast'?'Forecast':'Trend' }} GIF</h2><button aria-label="Close GIF dialog" @click="close">×</button></header>
 <div class="fg-body"><template v-if="kind==='forecast'"><label>Start Hour:<select v-model.number="start" aria-label="GIF start hour" :disabled="busy"><option v-for="frame in frames" :key="frame.hour" :value="frame.hour">{{ frame.hour }}</option></select></label><label>End Hour:<select v-model.number="end" aria-label="GIF end hour" :disabled="busy"><option v-for="frame in frames" :key="frame.hour" :value="frame.hour">{{ frame.hour }}</option></select></label><label>Skip Every:<input v-model.number="skip" aria-label="GIF skip every" type="number" min="0" max="12" :disabled="busy"/></label></template><template v-else><p>Valid: {{ validTime?forecastUtc(validTime):'無圖資' }}</p><label>Runs:<input v-model.number="runsCount" aria-label="GIF runs" type="number" min="2" :max="Math.max(2,matching.length)" :disabled="busy"/></label><p>可用 {{ matching.length }} 個不同預報基準；固定相同UTC有效時間，不是比較同一時效。</p><p v-if="matching.length<2" class="fg-error">尚無兩個不同基準的已發布圖片，無法製作Trend GIF。</p></template>
 <label>Speed (frames per second):<input v-model.number="fps" aria-label="GIF speed" type="number" min="1" max="12" :disabled="busy"/></label><p class="fg-hint">{{ images.length }} 張真實已發布圖片 · 最多910×650 · 瀏覽器製作，無缺圖替代。變更設定後請重新製作。</p><p v-if="kind==='forecast'" class="fg-hint">Forecast base {{ forecastUtc(run.forecastZero) }} · Provider run {{ forecastUtc(run.initializationTime) }}</p><p v-else class="fg-hint" v-for="item in matching.slice(0,runsCount)" :key="item.run.id">Base {{ forecastUtc(item.run.forecastZero) }} · Provider {{ forecastUtc(item.run.initializationTime) }} · +{{ item.frame.hour }}h</p>
 <p v-if="busy" role="status">製作中 {{ progress }}/{{ images.length }}…</p><p v-if="error" class="fg-error" role="alert">{{ error }}</p><img v-if="preview" class="fg-preview" :src="preview" alt="Generated forecast GIF preview"/><a v-if="ready" :href="preview" :download="filename">Download GIF</a></div>
 <footer><button class="fg-create" :disabled="!valid||busy" @click="create">Create GIF</button><button @click="close">{{ busy?'Cancel':'Close' }}</button></footer>
 </section></div></Teleport>
</template>
<style scoped>
.fg-backdrop{position:fixed;inset:0;z-index:2100;background:#0006;display:grid;place-items:start center;overflow:auto;padding:55px 14px}.fg-dialog{width:600px;max-width:100%;background:white;box-shadow:0 6px 26px #0004;border:1px solid #aaa;border-radius:5px;color:#444;font-size:14px}.fg-dialog header{display:flex;justify-content:space-between;padding:16px;border-bottom:1px solid #ddd;align-items:center}.fg-dialog h2{font-size:18px;font-weight:500}.fg-dialog header button{background:none;font-size:25px;color:#999}.fg-body{padding:18px}.fg-body label{display:flex;align-items:center;gap:16px;margin:10px 0 20px}.fg-body select,.fg-body input{width:90px;max-width:40%;border:1px solid #aaa;padding:6px;font-size:14px;background:white;color:#444}.fg-body select{width:130px}.fg-body p{font-size:12px;line-height:1.8}.fg-hint{color:#8b9299}.fg-preview{display:block;max-width:100%;height:auto;margin-top:12px}.fg-body a{display:block;padding:10px;color:#268bce}.fg-dialog footer{display:flex;justify-content:flex-end;gap:8px;padding:14px;border-top:1px solid #ddd}.fg-dialog footer button{border:1px solid #ccc;background:white;color:#555;border-radius:4px;padding:10px 15px;font-size:14px}.fg-dialog footer button.fg-create{background:#337ab7;color:white;border-color:#2e6da4}.fg-dialog button:disabled{opacity:.5}.fg-error{color:#b74a3e}@media(max-width:600px){.fg-backdrop{padding:25px 10px}.fg-body label{gap:10px;font-size:12px}.fg-body{padding:14px}}
</style>
