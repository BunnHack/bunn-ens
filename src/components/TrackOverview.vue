<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import ChartFrame from './ChartFrame.vue'
import TrackOverviewPlot from './TrackOverviewPlot.vue'
import { loadPotential, type PotentialModel, type PotentialResult } from '../data/potential'
import { basinRegions } from '../data/basin'
import { addAiTracks, focusTrackRegion, overviewModels } from '../data/overview'
import { overviewTracks } from '../data/overview'
import { aiModels, associateAi, loadAi, type AiModel, type AiResult } from '../data/wmc'
import { clearRequestCache } from '../data/request-cache'
const props=withDefaults(defineProps<{active?:boolean}>(),{active:true})
const results=shallowRef<Partial<Record<PotentialModel,PotentialResult>>>({}),errors=ref<Partial<Record<PotentialModel,string>>>({})
const loading=ref(false),storm=ref('WP292026'),regionId=ref('wp'),focus=ref(true),dataRevision=ref(0)
const aiCatalog=shallowRef<AiResult>(),aiResults=shallowRef<Record<string,AiResult>>({}),aiError=ref(''),catalogError=ref(''),aiLoading=ref(false)
const enabledAi=ref<AiModel[]>(aiModels.map(m=>m.id))
let controller:AbortController|undefined,aiController:AbortController|undefined,revision=0,aiRevision=0,lastLoaded=0
const aiLoaded:Record<string,number>={}
const choices=computed(()=>[...new Set(Object.values(results.value).flatMap(r=>r.catalog.points.map(p=>p.trackId)).filter(id=>/^[A-Z]{2}\d{6}$/.test(id)))].sort())
const aiChoices=computed(()=>[...new Set(aiCatalog.value?.tracks.map(t=>t.code)??[])].map(code=>{const t=aiCatalog.value!.tracks.find(t=>t.code===code)!;return{code,label:`${t.chineseName} ${t.name} · WMC ${code}`}}))
const independent=computed(()=>storm.value.startsWith('wmc:'))
const association=computed(()=>independent.value?null:associateAi(aiCatalog.value,results.value.wm6,storm.value))
const aiCode=computed(()=>independent.value?storm.value.slice(4):association.value?.code??'')
const aiResult=computed(()=>aiResults.value[aiCode.value])
const title=computed(()=>independent.value?aiChoices.value.find(c=>c.code===aiCode.value)?.label??`WMC ${aiCode.value}`:association.value?`${storm.value} · WMC ${association.value.code} ${association.value.name}（本站對照）`:storm.value)
const data=computed(()=>addAiTracks(independent.value?{base:'',tracks:[]}:overviewTracks(results.value,storm.value),(aiResult.value?.tracks??[]).filter(t=>t.code===aiCode.value&&enabledAi.value.includes(t.model)),association.value?.rule??'獨立 WMC 來源系統；未與其他編號合併'))
const region=computed(()=>{const base=basinRegions.find(r=>r.id===regionId.value)??basinRegions[1]!;return focus.value?focusTrackRegion(data.value.tracks.flatMap(t=>t.points),base):base})
const filename=computed(()=>`track-overview-${storm.value.replace(':','-')}-${regionId.value}-${focus.value?'focus':'full'}-${region.value.west}_${region.value.east}_${region.value.south}_${region.value.north}-${data.value.base.replace(/[^0-9]/g,'')}-ai${aiCode.value}-${enabledAi.value.join('_')}-data${dataRevision.value}`)
function stopAi(){++aiRevision;aiController?.abort();aiLoading.value=false}
async function loadAiTracks(force=false){
  const code=aiCode.value
  if(!props.active||!code)return
  if(!force&&aiResults.value[code]&&Date.now()-(aiLoaded[code]??0)<300000)return
  stopAi();const token=aiRevision;aiController=new AbortController();const signal=aiController.signal;aiLoading.value=true;aiError.value=''
  try{const result=await loadAi(code,signal);if(token===aiRevision&&!signal.aborted){aiResults.value={...aiResults.value,[code]:result};aiLoaded[code]=Date.now();dataRevision.value++}}
  catch(error){if(token===aiRevision&&!signal.aborted)aiError.value=error instanceof Error?error.message:String(error)}
  finally{if(token===aiRevision)aiLoading.value=false}
}
async function load(force=false){
  if(loading.value||!props.active)return
  if(force)clearRequestCache(fetch,'/api/wmc')
  const token=++revision;controller?.abort();controller=new AbortController();const signal=controller.signal;loading.value=true;errors.value={};aiError.value='';catalogError.value=''
  await Promise.all([...overviewModels.map(async m=>{try{const result=await loadPotential(m.id,'latest',signal,undefined,{includeUnofficial:false});if(token===revision&&!signal.aborted){if(result.source==='snapshot'&&results.value[m.id]?.source==='remote')errors.value[m.id]=result.warning??'僅收到有日期的備份，保留先前成功的遠端資料；未確認最新。';else results.value={...results.value,[m.id]:result}}}catch(e){if(!signal.aborted&&token===revision)errors.value[m.id]=e instanceof Error?e.message:String(e)}}),
    (async()=>{try{const result=await loadAi(undefined,signal);if(token===revision&&!signal.aborted)aiCatalog.value=result}catch(e){if(!signal.aborted&&token===revision)catalogError.value=e instanceof Error?e.message:String(e)}})()])
  if(token===revision){loading.value=false;dataRevision.value++;lastLoaded=Date.now();if(!choices.value.includes(storm.value)&&!aiChoices.value.some(c=>`wmc:${c.code}`===storm.value))storm.value=choices.value[0]??(aiChoices.value[0]?`wmc:${aiChoices.value[0].code}`:'');if(force)void loadAiTracks(true)}
}
watch([aiCode,()=>props.active],([code,active],[previous])=>{stopAi();if(code!==previous)aiError.value='';if(active)void loadAiTracks()})
watch(()=>props.active,active=>{if(!active){++revision;controller?.abort();loading.value=false;stopAi()}else if(!lastLoaded||Date.now()-lastLoaded>300000)void load()},{immediate:true})
onBeforeUnmount(()=>{++revision;controller?.abort();stopAi()})
</script>
<template>
<section class="track-overview"><header><h1>預報洋區總覽</h1><div><label>氣旋系統 <select v-model="storm" aria-label="Overview cyclone"><optgroup label="ATCF 系統（可核對時疊加AI）"><option v-for="id in choices" :key="id">{{ id }}</option></optgroup><optgroup label="AI 來源獨立系統（WMC 編號）"><option v-for="c in aiChoices" :key="c.code" :value="`wmc:${c.code}`">{{ c.label }}</option></optgroup></select></label><label>地圖區域 <select v-model="regionId" aria-label="Overview region"><option v-for="r in basinRegions" :key="r.id" :value="r.id">{{ r.label }}</option></select></label><label><input v-model="focus" type="checkbox"/>聚焦系統</label><button :disabled="loading" @click="load(true)">重新查詢</button></div></header>
<fieldset class="overview-ai-controls"><legend>AI 模型（虛線單一路徑，不是系集均線／機率）</legend><label v-for="m in aiModels" :key="m.id" :style="{color:m.color}"><input v-model="enabledAi" type="checkbox" :value="m.id" :aria-label="`Show AI ${m.id}`"/>{{ m.label }}<small v-if="aiResult">{{ aiResult.tracks.some(t=>t.model===m.id)?' · 可用':' · 來源未提供' }}</small></label></fieldset>
<p v-if="loading||aiLoading" role="status">讀取各模式實際資料；不同版本個別標示，不補造未接入曲線。</p>
<p v-if="association" class="overview-ai-association">WMC {{ association.code }} {{ association.name }} ↔ {{ association.atcfId }}：{{ association.rule }}（{{ association.fixes }}點，最大{{ association.maxKm.toFixed(0) }}km）。</p>
<p v-else-if="aiCatalog&&!independent" class="overview-warning">此 ATCF 系統尚無唯一、足量的 AI 來源對照，不自動疊加。可另選「AI來源獨立系統」查看；WMC 編號不能直接當 ATCF 尾號。</p>
<p v-if="catalogError" class="overview-warning" role="status">AI目錄：{{ catalogError }}{{ aiCatalog?'；保留先前目錄，非本次確認更新':'' }}</p>
<p v-if="aiError" class="overview-warning" role="status">AI：{{ aiError }}{{ aiResult?'；保留上次成功資料，非本次確認更新':'' }}</p>
<template v-for="m in overviewModels" :key="m.id"><p v-if="errors[m.id]||results[m.id]?.source==='snapshot'" class="overview-warning" role="status">{{ m.label }}：{{ errors[m.id]||results[m.id]?.warning||'有日期的備份，未確認最新' }}{{ errors[m.id]&&results[m.id]?'；保留上次成功來源，非本次確認更新':'' }}</p></template>
<ChartFrame v-if="active&&data.tracks.length" :filename="filename" :title="`${title} 預報洋區總覽`"><TrackOverviewPlot :tracks="data.tracks" :base="data.base" :region="region" :cyclone="title"/></ChartFrame>
<p v-else-if="!loading&&!aiLoading">此系統尚無可繪製的真實路徑；不以其他系統或歷史圖替代。</p>
<details class="overview-sources"><summary>資料來源與缺漏（不把 G 群當跨模式身分）</summary><p v-for="m in overviewModels" :key="m.id"><strong :style="{color:m.color}">{{ m.label }}</strong>：{{ errors[m.id]||results[m.id]?.warning||results[m.id]?.catalog.initTime||'尚未載入' }}{{ errors[m.id]&&results[m.id]?'；保留上次成功來源，非本次已確認更新':'' }}<span v-if="results[m.id]"> · {{ results[m.id]!.source==='snapshot'?'有日期的備份，未確認最新':'遠端資料' }} · N={{ results[m.id]!.catalog.totalSamples }}</span></p>
<p>WN／GENC 均線逐時至少2位及完整 CSV 可見成員25%，WM-6 使用供應商 mean_path。只以實際 ATCF ID 比較這些均線；AI 另保留 WMC 原始 ID，僅通過名稱、洋區、同UTC早期位置核對才疊加，此對照不是供應商官方身分映射。無唯一對照時可獨立查看，不跨來源合成均線。不同基準以絕對 UTC 對齊，超過12h缺口不連線。</p>
<p>AI 來源：WMC Beijing EW4ALL；上游僅能使用傳統 HTTP，資料傳輸沒有 TLS 完整性保障。瀏覽器只連本站代理；動態驗證在伺服器產生，不隨圖片或資料下載。每點 datetime／validtime 依所提供來源文件按 UTC 驗證；time epoch 及 handletime 不代替起報。風速保留原始 m/s、氣壓 hPa，未轉換或改動原有強度圖／Cat。</p>
<p v-if="aiResult">AI來源檢查：{{ aiResult.checkedAt }} · WMC {{ aiCode }} · <a :href="`/api/wmc?code=${aiCode}`" target="_blank" rel="noopener">公開來源 JSON</a></p>
<p v-for="m in aiModels" :key="m.id"><strong :style="{color:m.color}">{{ m.label }}</strong>：<template v-if="aiResult?.tracks.some(t=>t.model===m.id)"><span v-for="t in aiResult.tracks.filter(t=>t.model===m.id)" :key="t.model">起報 {{ t.forecastZero }} · {{ t.points.length }}個實際點 · 單一路徑，無系集N · {{ t.warnings.join(' ') }}</span></template><template v-else>目前選擇來源未提供／尚未載入；不畫替代曲線。</template></p>
<p>ECMWF／GFS 等未接入產品不畫假曲線。所有曲線為非官方參考，非警報或風險保證。</p></details>
</section>
</template>
<style scoped>
.overview-warning{padding:9px;background:#fff8e7;color:#92713b}.track-overview{background:white;border-radius:8px;padding:18px;min-width:0}.track-overview header{display:flex;flex-wrap:wrap;gap:15px;justify-content:space-between}.track-overview h1{font-size:24px}.track-overview header>div{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.track-overview label,.track-overview p,.track-overview details{font-size:12px;line-height:1.8}.track-overview select{max-width:100%;padding:7px;border:1px solid #d3dfe7;border-radius:6px}.track-overview header label{min-width:0;max-width:100%}.track-overview button{padding:8px 14px;background:#eaf5fd;color:#2886b5;border-radius:16px}.track-overview details{margin-top:14px;color:#667e91}.overview-ai-controls{display:flex;flex-wrap:wrap;gap:7px 16px;border:1px solid #dae6ed;border-radius:8px;margin:12px 0;padding:9px 12px;min-width:0}.overview-ai-controls legend{font-size:12px;color:#577187}.overview-ai-controls label{display:flex;align-items:center;gap:4px}.overview-ai-controls small{font-size:10px}.overview-ai-association{color:#507985;background:#eff8fc;padding:8px;overflow-wrap:anywhere}.overview-sources p{overflow-wrap:anywhere}@media(max-width:600px){.track-overview{padding:10px}.track-overview h1{font-size:21px}.track-overview header>div{width:100%}.track-overview header select{display:block;max-width:calc(100vw - 100px)}}
</style>
