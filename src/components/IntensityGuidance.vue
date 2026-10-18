<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import ChartFrame from './ChartFrame.vue'
import IntensityPlot from './IntensityPlot.vue'
import { loadPotential, type PotentialModel, type PotentialResult } from '../data/potential'
import { loadWm6, type Wm6Response } from '../data/wm6'
import { intensityCsv, intensityModels, loadWm6Intensity, matchedCyclone, memberIntensity, providerIntensity, type IntensityMetric, type IntensitySeries } from '../data/intensity'
import { clearRequestCache } from '../data/request-cache'
const props=withDefaults(defineProps<{active?:boolean}>(),{active:true})
const results=shallowRef<Partial<Record<PotentialModel,PotentialResult>>>({}),wm6List=shallowRef<Wm6Response|null>(null)
const storm=ref('WP292026'),metric=ref<IntensityMetric>('wind'),enabled=ref<PotentialModel[]>(['wn2','wn3','wm6']),showProvider=ref(false)
const errors=ref<Partial<Record<PotentialModel,string>>>({wn2:'',wn3:'',wm6:''}),loading=ref(false),detailLoading=ref(false),exportError=ref(''),wm6ListError=ref(''),dataRevision=ref(0)
watch(results,()=>{dataRevision.value++},{flush:'sync'})
let controller:AbortController|undefined,detailController:AbortController|undefined,timer:ReturnType<typeof setInterval>|undefined,revision=0,detailRevision=0,lastAttempt=0
const choices=computed(()=>{
  const values=new Map<string,Set<string>>()
  for(const model of intensityModels){
    const ids=model.id==='wm6'?Object.keys(wm6List.value?.tropical_cyclones??{}):[...new Set(results.value[model.id]?.catalog.points.map(point=>point.trackId)??[])]
    for(const id of ids.filter(matchedCyclone)){const sources=values.get(id)??new Set<string>();sources.add(model.label);values.set(id,sources)}
  }
  return [...values].sort(([a],[b])=>a.localeCompare(b)).map(([id,sources])=>({id,label:`${id} · ${[...sources].join(' / ')}`}))
})
const calculated=computed(()=>{
  const series:IntensitySeries[]=[],issues:Record<string,string>={}
  for(const model of intensityModels){
    const result=results.value[model.id]
    if(!result||!storm.value)continue
    try{const value=memberIntensity(result,model.id,storm.value,metric.value);series.push(value);if(!value.points.length)issues[model.id]='沒有同一 ID 的足量有效成員，未畫線。'}
    catch(cause){issues[model.id]=cause instanceof Error?cause.message:String(cause)}
  }
  if(showProvider.value&&enabled.value.includes('wm6')&&results.value.wm6){try{series.push(providerIntensity(results.value.wm6,storm.value,metric.value))}catch(cause){issues.provider=cause instanceof Error?cause.message:String(cause)}}
  return {series,issues}
})
const sourceRows=computed(()=>intensityModels.map(model=>({ ...model,result:results.value[model.id],series:calculated.value.series.find(item=>item.model===model.id&&item.definition==='member_mean'),error:[model.id==='wm6'?wm6ListError.value:'',errors.value[model.id],calculated.value.issues[model.id]].filter(Boolean).join(' '),failed:!!errors.value[model.id]||(model.id==='wm6'&&!!wm6ListError.value) })))
const plotted=computed(()=>calculated.value.series.filter(item=>enabled.value.includes(item.model)&&item.points.length))
const filename=computed(()=>`Intensity-${storm.value}-${metric.value}-${plotted.value.map(item=>`${item.key}-${item.initializationTime.replace(/[^0-9]/g,'')}`).join('_')}-data${dataRevision.value}`)
const loadingAny=computed(()=>loading.value||detailLoading.value)
function utc(raw:string){return raw.replace('T',' ').replace(/(?:\.000)?Z$/,' UTC')}
async function loadSelectedWm6(){
  if(!props.active)return
  const list=wm6List.value,id=storm.value,token=++detailRevision;detailController?.abort();detailLoading.value=false
  if(!list||!id)return
  if(!Object.prototype.hasOwnProperty.call(list.tropical_cyclones,id)){errors.value.wm6='WM-6 此次清單沒有所選 ID；若保留舊線，請核對其版本。';return}
  const active=new AbortController();detailController=active;detailLoading.value=true;errors.value.wm6=''
  try{const result=await loadWm6Intensity(list,id,active.signal);if(!active.signal.aborted&&token===detailRevision)results.value={...results.value,wm6:result}}
  catch(cause){if(!active.signal.aborted&&token===detailRevision)errors.value.wm6=cause instanceof Error?cause.message:String(cause)}
  finally{if(token===detailRevision)detailLoading.value=false}
}
async function refresh(){
  if(loading.value)return
  const token=++revision;controller?.abort();const active=new AbortController();controller=active;loading.value=true;lastAttempt=Date.now()
  try{
    await Promise.all([
      ...(['wn2','wn3'] as const).map(async model=>{
        errors.value[model]=''
        try{const result=await loadPotential(model,'latest',active.signal);if(!active.signal.aborted&&token===revision){if(result.source==='snapshot'&&results.value[model]?.source==='remote')errors.value[model]=result.warning??'僅收到舊備份，保留先前來源。';else results.value={...results.value,[model]:result}}}
        catch(cause){if(!active.signal.aborted&&token===revision)errors.value[model]=cause instanceof Error?cause.message:String(cause)}
      }),
      (async()=>{
        wm6ListError.value=''
        try{const list=await loadWm6({initialization_time:'latest',include_details:true,include_unofficial_ids:false,format:'json'},active.signal) as Wm6Response;if(!active.signal.aborted&&token===revision)wm6List.value=list}
        catch(cause){if(!active.signal.aborted&&token===revision)wm6ListError.value=cause instanceof Error?cause.message:String(cause)}
      })(),
    ])
    if(!active.signal.aborted&&token===revision&&!choices.value.some(item=>item.id===storm.value))storm.value=choices.value.find(item=>item.id==='WP292026')?.id??choices.value.find(item=>item.id.startsWith('WP'))?.id??choices.value[0]?.id??''
    await nextTick()
    const loaded=results.value.wm6?.details[storm.value]
    if(!active.signal.aborted&&token===revision&&!wm6ListError.value&&wm6List.value&&storm.value&&!detailLoading.value&&!errors.value.wm6&&(!loaded||Date.parse(loaded.initialization_time)!==Date.parse(wm6List.value.initialization_time)))await loadSelectedWm6()
  }finally{if(token===revision)loading.value=false}
}
function reload(){clearRequestCache(fetch,'/api/wnc2');clearRequestCache(fetch,'/api/wm6');refresh()}
function downloadCsv(){
  exportError.value=''
  try{const url=URL.createObjectURL(new Blob([intensityCsv(plotted.value)],{type:'text/csv;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=filename.value+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
  catch{exportError.value='無法下載 CSV，請稍後重試。'}
}
watch([storm,wm6List],loadSelectedWm6)
watch(()=>props.active,active=>{
  if(active){if(!lastAttempt||Date.now()-lastAttempt>=300000)refresh()}
  else{if(loadingAny.value)lastAttempt=0;++revision;++detailRevision;controller?.abort();detailController?.abort();loading.value=false;detailLoading.value=false}
})
onMounted(()=>{if(props.active)refresh();timer=setInterval(()=>{if(props.active&&document.visibilityState==='visible'&&!loadingAny.value)refresh()},300000)})
onBeforeUnmount(()=>{++revision;++detailRevision;controller?.abort();detailController?.abort();clearInterval(timer)})
</script>

<template>
  <section class="intensity-guidance" aria-label="Model ensemble-mean intensity guidance">
    <p class="ig-intro">同一實際 ATCF ID · WNC2／WNC3／WM-6 原始強度均值 · UTC 有效時間對齊</p>
    <div class="ig-controls"><label>已匹配氣旋<select v-model="storm" aria-label="Intensity cyclone" :disabled="!choices.length"><option v-if="!choices.length" value="">等待可用 ID</option><option v-for="item in choices" :key="item.id" :value="item.id">{{ item.label }}</option></select></label><label>強度欄位<select v-model="metric" aria-label="Intensity metric"><option value="wind">成員最大風速平均 · kt</option><option value="pressure">成員最低氣壓平均 · hPa</option></select></label></div>
    <p v-if="loadingAny" class="ig-status" role="status">讀取實際路徑；WM-6 詳情固定同一供應商版本，不以其他風暴代替。</p>
    <template v-if="plotted.length && active"><ChartFrame :filename="filename" :title="`${storm} ensemble-mean intensity`"><IntensityPlot :series="plotted" :cyclone="storm" :metric="metric" /></ChartFrame></template>
    <p v-else-if="!loadingAny && active" class="ig-empty" role="status">{{ enabled.length ? '目前沒有同一氣旋、足量有效成員的強度曲線。請核對下方來源／錯誤或更換實際 ID。' : '請至少勾選一個模型。' }} 不以歷史參考圖片或單一成員補線。</p>
    <template v-for="item in sourceRows" :key="item.id"><p v-if="item.error||item.result?.source==='snapshot'" class="ig-warning" role="status">{{ item.label }}：{{ item.error||item.result?.warning||'有日期備份，未確認最新' }}{{ item.failed&&item.result?' 保留先前成功資料，非本次已確認更新；不同ID不畫舊線。':'' }}</p></template>
    <details class="ig-options"><summary>模式、來源與CSV</summary>
    <div class="ig-model-toggles"><label v-for="model in intensityModels" :key="model.id" :style="{color:model.color}"><input v-model="enabled" type="checkbox" :value="model.id" :aria-label="`Show ${model.label} intensity`" />{{ model.label }} mean</label><label><input v-model="showProvider" type="checkbox" aria-label="Show WM-6 provider intensity mean" />另列 WM-6 供應商均值（不同定義）</label></div>
    <div class="ig-option-actions"><button class="ig-refresh" :disabled="loadingAny" @click="reload">{{ loadingAny?'讀取資料中…':'更新資料' }}</button><button :disabled="!plotted.length" @click="downloadCsv">下載均值 CSV</button></div>
    <div class="ig-sources"><div v-for="item in sourceRows" :key="item.id" class="ig-source"><strong :style="{color:item.color}">{{ item.label }} · {{ item.source }}</strong><template v-if="item.result"><span>{{ item.id === 'wm6' ? '供應商版本' : '模型起報' }} {{ item.result.catalog.initTime }} UTC</span><span>預報基準 {{ utc(item.id === 'wm6' ? item.result.wm6!.forecastZero : item.result.catalog.initTime + 'Z') }}</span><span v-if="item.series">N={{ item.series.denominator }}（{{ item.id === 'wm6' ? '供應商 ens_size' : '完整 CSV 可見成員' }}）；逐時門檻 ≥{{ item.series.minimumMembers }} 位</span><span>查詢完成 {{ utc(item.result.checkedAt) }}（非模式時間）</span><span v-if="item.result.source === 'snapshot'" class="ig-warning">有日期的備份，未確認最新。{{ item.result.warning }}</span></template><p v-if="item.error" class="ig-warning" role="status">{{ item.error }}{{ item.failed && item.result ? ' 保留先前成功資料，非本次已確認更新；不同 ID 不畫舊線。' : '' }}</p></div></div>
    </details>
    <p v-if="calculated.issues.provider" class="ig-warning">{{ calculated.issues.provider }}</p><p v-if="exportError" role="alert" class="ig-warning">{{ exportError }}</p>
    <details class="ig-method"><summary>均值、有效成員與時間軸定義</summary><p>三條主要曲線使用一致的「同 ID、同有效時刻、每成員一筆原始強度的算術平均」。只平均有追蹤且有該欄位的成員，並非把缺失／未成旋者補成零的全系集無條件平均。逐時至少 2 位且達完整可用系集 25%；不足或缺失時斷線，不跨越大於 12h 的洞。同成員同時效若有互相矛盾的強度則剔除；點的提示與下表列出 n/N。</p><p>每條模型曲線各自固定其最新查得版本，以 UTC 有效時間對齊，而不是把不同起報的 +h 強行重疊。WM-6 有效時間 = forecast_zero + forecast_hour，供應商小時版本不是此基準。三模型不是合成一條跨模型平均；本站 G 尚未跨模型配對，不能當成共同強度身分。</p><p>風速保留來源 kt，氣壓保留 hPa；不從氣壓推算、膨脹或「校正」風速。模型風速持續時間／取樣定義與偏差未證實一致，曲線差異不可直接當校準後強度差。WM-6 mean_path 可額外列為供應商均值，與本站成員算術平均分開；未提供逐時貢獻數時標未知，不猜 n。</p><p>WeatherNext 完整 CSV 仍可能省略成員或路徑，條件平均及可見分母有選擇偏差。切換風／壓或顯示模型只在本地重算；JSON 在同頁共享 5 分鐘快取，API 另有伺服器快取。顯示此區時每 5 分鐘更新；資料錯誤保留並標示舊來源，不冒稱最新。</p><p v-for="item in calculated.series" :key="item.key">{{ item.label }}：排除時間不符 {{ item.invalidTimes }} 筆、成員衝突 {{ item.conflicts }} 組、缺值 {{ item.missingValues }} 筆。</p></details>
    <details v-if="plotted.length" class="ig-values"><summary>逐時均值與有效成員數（{{ metric === 'wind' ? 'kt' : 'hPa' }}）</summary><div><table><thead><tr><th>模型</th><th>有效時間 UTC</th><th>+h</th><th>均值</th><th>n/N</th></tr></thead><tbody><template v-for="item in plotted" :key="item.key"><tr v-for="point in item.points" :key="point.time"><td>{{ item.label }}</td><td>{{ utc(point.validTime) }}</td><td>{{ point.leadHours }}</td><td>{{ point.value.toFixed(2) }}</td><td>{{ point.count ?? '未知' }}/{{ item.denominator }}</td></tr></template></tbody></table></div></details>
  </section>
</template>

<style scoped>
.intensity-guidance { padding: 16px 18px; min-width: 0; color: #597186; }
.ig-controls{margin-bottom:12px}.ig-options{margin-top:12px;font-size:11px;line-height:1.9;border-top:1px solid #e4ebf1;padding-top:10px}.ig-options summary{cursor:pointer;color:#3d84ac}.ig-option-actions{display:flex;gap:10px}.ig-option-actions button{font-size:11px;background:#edf5fa;color:#4685a6;border-radius:16px;padding:7px 13px}.ig-option-actions button:disabled{opacity:.4}
.ig-intro { font-size: 12px; line-height: 1.8; margin: 0 0 12px; }.ig-controls { display: flex; align-items: end; flex-wrap: wrap; gap: 10px; }.ig-controls label { display: grid; gap: 6px; font-size: 12px; min-width: 0; max-width: 100%; }.ig-controls select { max-width: 100%; min-width: 0; border: 1px solid #cedce7; border-radius: 4px; padding: 8px; background: white; color: #45657e; font-size: 12px; }.ig-controls button { padding: 9px 14px; border-radius: 18px; background: #e8f4fb; color: #318bc0; font-size: 12px; }.ig-controls button:disabled { opacity: .5; }.ig-model-toggles { display: flex; flex-wrap: wrap; gap: 12px; margin: 15px 0; font-size: 12px; }.ig-model-toggles label { display: flex; align-items: center; gap: 5px; }.ig-model-toggles input { accent-color: currentColor; }
.ig-sources { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; margin-top: 14px; }.ig-source { min-width: 0; background: #f4f8fb; padding: 10px; font-size: 11px; line-height: 1.8; overflow-wrap: anywhere; }.ig-source strong,.ig-source span { display: block; }.ig-warning { color: #9d6a26; background: #fff8e8; padding: 8px; font-size: 11px; line-height: 1.8; }.ig-status,.ig-empty { padding: 12px; color: #6c8ca5; background: #eff6fc; font-size: 12px; line-height: 1.8; }.ig-empty { min-height: 100px; }
.ig-method,.ig-values { margin-top: 14px; border-top: 1px solid #e4ebf1; padding-top: 12px; font-size: 11px; line-height: 1.9; }.ig-method summary,.ig-values summary { cursor: pointer; color: #3d84ac; }.ig-values > div { max-height: 350px; overflow: auto; }.ig-values table { border-collapse: collapse; white-space: nowrap; width: 100%; }.ig-values th,.ig-values td { padding: 6px 9px; border-bottom: 1px solid #e6ecf1; text-align: left; }
@media(max-width:700px){.intensity-guidance { padding: 12px; }.ig-controls { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); }.ig-controls select { width: 100%; }.ig-sources { grid-template-columns: minmax(0,1fr); }.ig-model-toggles { font-size: 11px; gap: 9px; }}
</style>
