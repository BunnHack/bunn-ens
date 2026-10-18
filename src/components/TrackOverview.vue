<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import ChartFrame from './ChartFrame.vue'
import TrackOverviewPlot from './TrackOverviewPlot.vue'
import { loadPotential, type PotentialModel, type PotentialResult } from '../data/potential'
import { basinRegions } from '../data/basin'
import { focusTrackRegion, overviewModels, overviewTracks } from '../data/overview'
const props=withDefaults(defineProps<{active?:boolean}>(),{active:true})
const results=shallowRef<Partial<Record<PotentialModel,PotentialResult>>>({}),errors=ref<Partial<Record<PotentialModel,string>>>({}),loading=ref(false),storm=ref('WP292026'),regionId=ref('wp'),focus=ref(true)
const dataRevision=ref(0)
let controller:AbortController|undefined,revision=0,lastLoaded=0
const choices=computed(()=>[...new Set(Object.values(results.value).flatMap(r=>r.catalog.points.map(p=>p.trackId)).filter(id=>/^[A-Z]{2}\d{6}$/.test(id)))].sort())
const data=computed(()=>overviewTracks(results.value,storm.value))
const region=computed(()=>{const base=basinRegions.find(r=>r.id===regionId.value)??basinRegions[1]!;return focus.value?focusTrackRegion(data.value.tracks.flatMap(t=>t.points),base):base})
const filename=computed(()=>`track-overview-${storm.value}-${regionId.value}-${focus.value?'focus':'full'}-${region.value.west}_${region.value.east}_${region.value.south}_${region.value.north}-${data.value.base.replace(/[^0-9]/g,'')}-data${dataRevision.value}`)
async function load(){if(loading.value||!props.active)return;const token=++revision;controller?.abort();controller=new AbortController();const signal=controller.signal;loading.value=true;errors.value={};await Promise.all(overviewModels.map(async m=>{try{const result=await loadPotential(m.id,'latest',signal,undefined,{includeUnofficial:false});if(token===revision&&!signal.aborted){if(result.source==='snapshot'&&results.value[m.id]?.source==='remote')errors.value[m.id]=result.warning??'僅收到有日期的備份，保留先前成功的遠端資料；未確認最新。';else results.value={...results.value,[m.id]:result}}}catch(e){if(!signal.aborted&&token===revision)errors.value[m.id]=e instanceof Error?e.message:String(e)}}));if(token===revision){loading.value=false;dataRevision.value++;lastLoaded=Date.now();if(!choices.value.includes(storm.value))storm.value=choices.value[0]??''}}
watch(()=>props.active,active=>{if(!active){++revision;controller?.abort();loading.value=false}else if(!lastLoaded||Date.now()-lastLoaded>300000)load()},{immediate:true})
onBeforeUnmount(()=>{++revision;controller?.abort()})
</script>
<template>
<section class="track-overview"><header><h1>預報洋區總覽</h1><div><label>已匹配氣旋 <select v-model="storm" aria-label="Overview cyclone"><option v-for="id in choices" :key="id">{{ id }}</option></select></label><label>地圖區域 <select v-model="regionId" aria-label="Overview region"><option v-for="r in basinRegions" :key="r.id" :value="r.id">{{ r.label }}</option></select></label><label><input v-model="focus" type="checkbox"/>聚焦系統</label><button :disabled="loading" @click="load">重新查詢</button></div></header>
<p v-if="loading" role="status">讀取各模式實際資料；不同版本個別標示，不補造未接入曲線。</p>
<template v-for="m in overviewModels" :key="m.id"><p v-if="errors[m.id]||results[m.id]?.source==='snapshot'" class="overview-warning" role="status">{{ m.label }}：{{ errors[m.id]||results[m.id]?.warning||'有日期的備份，未確認最新' }}{{ errors[m.id]&&results[m.id]?'；保留上次成功來源，非本次確認更新':'' }}</p></template>
<ChartFrame v-if="active&&data.tracks.length" :filename="filename" :title="`${storm} 預報洋區總覽`"><TrackOverviewPlot :tracks="data.tracks" :base="data.base" :region="region" :cyclone="storm"/></ChartFrame>
<p v-else-if="!loading">此 ID 尚無足量、同一氣旋的真實均線。</p>
<details><summary>資料來源與缺漏（不把 G 群當跨模式身分）</summary><p v-for="m in overviewModels" :key="m.id"><strong :style="{color:m.color}">{{ m.label }}</strong>：{{ errors[m.id]||results[m.id]?.warning||results[m.id]?.catalog.initTime||'尚未載入' }}{{ errors[m.id]&&results[m.id]?'；保留上次成功來源，非本次已確認更新':'' }}<span v-if="results[m.id]"> · {{ results[m.id]!.source==='snapshot'?'有日期的備份，未確認最新':'遠端資料' }} · N={{ results[m.id]!.catalog.totalSamples }}</span></p><p>只比較同一實際 ATCF ID；WN／GENC 均線逐時至少2位及完整 CSV 可見成員25%，WM-6 使用供應商 mean_path。不同基準以絕對 UTC 對齊，再標示相對共同基準的時效。非跨模式合成均線，亦非官方警報。ECMWF／AIFS／GFS 等未接入產品不畫假曲線。</p></details>
</section>
</template>
<style scoped>.overview-warning{padding:9px;background:#fff8e7;color:#92713b}.track-overview{background:white;border-radius:8px;padding:18px;min-width:0}.track-overview header{display:flex;flex-wrap:wrap;gap:15px;justify-content:space-between}.track-overview h1{font-size:24px}.track-overview header>div{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.track-overview label,.track-overview p,.track-overview details{font-size:12px;line-height:1.8}.track-overview select{max-width:100%;padding:7px;border:1px solid #d3dfe7;border-radius:6px}.track-overview button{padding:8px 14px;background:#eaf5fd;color:#2886b5;border-radius:16px}.track-overview details{margin-top:14px;color:#667e91}</style>
