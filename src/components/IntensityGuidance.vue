<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import ChartFrame from './ChartFrame.vue'
import IntensityPlot from './IntensityPlot.vue'
import { loadPotential, type PotentialModel, type PotentialResult } from '../data/potential'
import { loadWm6, type Wm6Response } from '../data/wm6'
import { intensityModels, loadWm6Intensity, memberIntensity, type IntensityMetric } from '../data/intensity'
import { aiModels, loadAi, type AiResult } from '../data/wmc'
import { extraModels, loadModelTracks, type ModelTracks } from '../data/model-tracks'
import { aiIntensity, extraIntensity, windGuidanceInKnots, type GuidanceSeries } from '../data/intensity-sources'
import { currentPotentialId, currentReference, type CurrentSelection } from '../data/current-selection'
import { clearRequestCache } from '../data/request-cache'
const props=withDefaults(defineProps<{active?:boolean;selection?:CurrentSelection}>(),{active:true})
const results=shallowRef<Partial<Record<PotentialModel,PotentialResult>>>({}),wm6List=shallowRef<Wm6Response>(),catalog=shallowRef<AiResult>(),aiResults=shallowRef<Record<string,AiResult>>({}),extras=shallowRef<ModelTracks>()
const metric=ref<IntensityMetric>('wind'),enabled=ref<string[]>([...intensityModels.map(m=>m.id),...aiModels.map(m=>m.id),...extraModels.map(m=>m.id)]),errors=ref<Record<string,string>>({}),loading=ref(false),detailLoading=ref(false),aiLoading=ref(false),dataRevision=ref(0)
const selectedName=computed(()=>props.selection?.storm?.name??'请选择Current Storm')
const sourceIds=computed(()=>Object.fromEntries(intensityModels.filter(m=>m.id!=='wm6').map(m=>[m.id,currentPotentialId(props.selection,results.value[m.id])])))
const wm6Id=computed(()=>{
 const list=wm6List.value;if(!list)return ''
 const direct=currentReference(props.selection,Object.entries(list.tropical_cyclones).map(([id,t])=>({id,points:(t.mean_path??t.path??[]).filter(p=>Date.parse(p.valid_at)===Date.parse(list.forecast_zero)+p.forecast_hour*3600000).map(p=>({validTime:p.valid_at,lat:p.latitude,lon:p.longitude}))})))
 if(direct)return direct
 const ids=[...new Set(Object.values(sourceIds.value).filter(id=>id&&list.tropical_cyclones[id]))];return ids.length===1?ids[0]!:''
})
const aiCode=computed(()=>currentReference(props.selection,(catalog.value?.tracks??[]).map(t=>({id:t.code,points:t.points.map(p=>({validTime:p.validTime,lat:p.lat,lon:p.lon}))}))))
const extraTracks=computed(()=>extraModels.flatMap(m=>{const tracks=extras.value?.tracks.filter(t=>t.model===m.id)??[],id=currentReference(props.selection,tracks.map(t=>({id:t.systemId,points:t.points})));return tracks.filter(t=>t.systemId===id)}))
const calculated=computed(()=>{
 const series:GuidanceSeries[]=[]
 for(const model of intensityModels){const result=results.value[model.id],id=model.id==='wm6'?wm6Id.value:sourceIds.value[model.id];if(!result||!id||model.id==='wm6'&&!result.details[id])continue;try{series.push(memberIntensity(result,model.id,id,metric.value))}catch{/* No compatible data for this source identity. */}}
 series.push(...aiIntensity(aiResults.value[aiCode.value],aiCode.value,metric.value),...extraIntensity(extraTracks.value,extras.value?.checkedAt??'',metric.value))
 return series.map(windGuidanceInKnots)
})
const plotted=computed(()=>calculated.value.filter(s=>enabled.value.includes(s.model)&&s.points.length))
const filename=computed(()=>`Intensity-${props.selection?.storm?.id??'none'}-${metric.value}-${plotted.value.map(s=>s.key).join('_')}-data${dataRevision.value}`)
const loadingAny=computed(()=>loading.value||detailLoading.value||aiLoading.value)
let controller:AbortController|undefined,detailController:AbortController|undefined,aiController:AbortController|undefined,timer:ReturnType<typeof setInterval>|undefined,revision=0,detailRevision=0,aiRevision=0,lastAttempt=0,lastDetailKey=''
const aiLoaded:Record<string,number>={}
async function loadSelectedWm6(){const token=++detailRevision;detailController?.abort();detailLoading.value=false;const id=wm6Id.value,list=wm6List.value;if(!props.active||!id||!list)return;const key=id+'|'+list.initialization_time;if(lastDetailKey===key&&results.value.wm6?.details[id])return;detailController=new AbortController();const signal=detailController.signal;detailLoading.value=true;try{const result=await loadWm6Intensity(list,id,signal);if(token===detailRevision&&!signal.aborted){results.value={...results.value,wm6:result};lastDetailKey=key;dataRevision.value++}}catch(e){if(token===detailRevision&&!signal.aborted)errors.value.wm6=e instanceof Error?e.message:String(e)}finally{if(token===detailRevision)detailLoading.value=false}}
async function loadSelectedAi(force=false){const token=++aiRevision;aiController?.abort();aiLoading.value=false;const code=aiCode.value;if(!props.active||!code||!force&&aiResults.value[code]&&Date.now()-(aiLoaded[code]??0)<300000)return;aiController=new AbortController();const signal=aiController.signal;aiLoading.value=true;try{const result=await loadAi(code,signal);if(token===aiRevision&&!signal.aborted){aiResults.value={...aiResults.value,[code]:result};aiLoaded[code]=Date.now();dataRevision.value++}}catch(e){if(token===aiRevision&&!signal.aborted)errors.value.WMC=e instanceof Error?e.message:String(e)}finally{if(token===aiRevision)aiLoading.value=false}}
async function refresh(){if(loading.value||!props.active)return;const token=++revision;controller?.abort();controller=new AbortController();const signal=controller.signal;loading.value=true;lastAttempt=Date.now();errors.value={};try{await Promise.all([
 ...(['wn2','wn3','genc','gefs','aigefs'] as const).map(async model=>{try{const value=await loadPotential(model,'latest',signal);if(token===revision&&!signal.aborted){if(value.source==='snapshot'&&results.value[model]?.source==='remote')errors.value[model]='仅收到旧备份，保留上次资料';else results.value={...results.value,[model]:value}}}catch(e){if(token===revision&&!signal.aborted)errors.value[model]=e instanceof Error?e.message:String(e)}}),
 (async()=>{try{const value=await loadWm6({initialization_time:'latest',include_details:true,include_unofficial_ids:false,format:'json'},signal) as Wm6Response;if(token===revision&&!signal.aborted)wm6List.value=value}catch(e){if(token===revision&&!signal.aborted)errors.value.wm6=e instanceof Error?e.message:String(e)}})(),
 (async()=>{try{const value=await loadAi(undefined,signal);if(token===revision&&!signal.aborted)catalog.value=value}catch(e){if(token===revision&&!signal.aborted)errors.value.WMC=e instanceof Error?e.message:String(e)}})(),
 (async()=>{try{const value=await loadModelTracks(signal);if(token===revision&&!signal.aborted)extras.value=value}catch(e){if(token===revision&&!signal.aborted)errors.value.extras=e instanceof Error?e.message:String(e)}})()
 ]);if(token===revision&&!signal.aborted){dataRevision.value++;void loadSelectedWm6();void loadSelectedAi()}}finally{if(token===revision)loading.value=false}}
function reload(){for(const path of ['/api/wnc2','/api/wm6','/api/wmc','/api/model-tracks','https://raw.githubusercontent.com/BunnHack/bunn-ens/ensemble-track-data/'])clearRequestCache(fetch,path);lastDetailKey='';if(aiCode.value)aiLoaded[aiCode.value]=0;void refresh()}
watch([wm6Id,wm6List],()=>void loadSelectedWm6());watch(aiCode,()=>void loadSelectedAi());watch([metric,enabled,()=>props.selection,results,aiResults,extras],()=>dataRevision.value++,{deep:true})
function stop(){if(loadingAny.value)lastAttempt=0;++revision;++detailRevision;++aiRevision;controller?.abort();detailController?.abort();aiController?.abort();loading.value=false;detailLoading.value=false;aiLoading.value=false}
watch(()=>props.active,a=>{if(a){if(!lastAttempt||Date.now()-lastAttempt>=300000)void refresh();else{void loadSelectedWm6();void loadSelectedAi()}}else stop()})
onMounted(()=>{if(props.active)void refresh();timer=setInterval(()=>{if(props.active&&document.visibilityState==='visible'&&!loadingAny.value)void refresh()},300000)})
onBeforeUnmount(()=>{stop();clearInterval(timer)})
</script>
<template>
<section class="intensity-guidance" aria-label="Current Storm intensity guidance">
<div class="ig-controls"><strong>{{ selectedName }}</strong><label>强度字段<select v-model="metric" aria-label="Intensity metric"><option value="wind">风速 · kt</option><option value="pressure">气压 · hPa</option></select></label><button :disabled="loadingAny" @click="reload">{{ loadingAny?'读取中…':'更新资料' }}</button></div>
<p class="ig-note">跟随上方Current Storm；无唯一来源对照就不画该模型。AI／SD3原生m/s按3600/1852精确换算为kt，不作风速校准或气压推风，风级阈值与颜色不变。</p>
<div class="ig-model-toggles"><label v-for="m in [...intensityModels,...aiModels,...extraModels]" :key="m.id" :style="{color:m.color}"><input v-model="enabled" type="checkbox" :value="m.id" :aria-label="`Show ${m.label} intensity`"/>{{ m.label }}<small>{{ calculated.some(s=>s.model===m.id&&s.points.length)?' · 可用':' · 无已核对值' }}</small></label></div>
<ChartFrame v-if="plotted.length&&active" :filename="filename" :title="`${selectedName} ${metric}`"><IntensityPlot :series="plotted" :cyclone="selectedName" :metric="metric" :unit="metric==='wind'?'kt':'hPa'"/></ChartFrame>
<p v-else-if="active&&!loadingAny" role="status">所选Current Storm暂无可绘制的已核对强度，不显示其他系统代替。</p>
<p v-if="loadingAny" role="status">读取来源…</p>
<p v-for="(message,source) in errors" :key="source" class="ig-warning">{{ source }}：{{ message }}；已有资料保留其原始日期，不代表本次更新。</p>
<p v-if="plotted.some(s=>s.model==='SD3')" class="ig-license">天机 SD3 · TianJi Weather Science and Technology Company · CC BY-NC 4.0，仅限非商业且须署名。</p>
</section>
</template>
<style scoped>.intensity-guidance{padding:14px;min-width:0}.ig-controls,.ig-model-toggles{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px}.ig-controls label{display:flex;gap:8px;align-items:center;font-size:12px}.ig-controls select,.ig-controls button{padding:8px;border:1px solid #cbdce6;border-radius:6px;color:#3d7c9d;background:white}.ig-model-toggles{margin:15px 0}.ig-model-toggles label{font-size:12px;display:flex;align-items:center;gap:5px}.ig-model-toggles small{font-size:10px}.ig-note,.ig-warning,.ig-license{font-size:11px;line-height:1.8}.ig-warning{color:#a75b3e}.ig-note,.ig-license{color:#70869a}</style>
