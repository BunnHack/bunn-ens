<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { extraModels, extraAssociation, loadModelTracks, type ExtraModel, type ExtraTrack, type ModelTracks } from '../data/model-tracks'
import type { AiResult } from '../data/wmc'
import { clearRequestCache } from '../data/request-cache'
const props=defineProps<{active:boolean;code:string;primary:string;catalog?:AiResult;refresh:number}>()
const emit=defineEmits<{update:[value:{tracks:ExtraTrack[];independent:boolean;title:string;association:string;exportKey:string}]}>()
const result=shallowRef<ModelTracks>(),error=ref(''),loading=ref(false),choice=ref('follow'),enabled=ref<ExtraModel[]>(extraModels.map(m=>m.id)),version=ref(0)
let controller:AbortController|undefined,revision=0,lastAttempt=0
const systems=computed(()=>[...new Set(result.value?.tracks.map(t=>t.systemId)??[])].map(id=>({id,name:result.value!.tracks.find(t=>t.systemId===id)!.name})))
const independent=computed(()=>choice.value!=='follow')
const available=computed(()=>result.value?.tracks.filter(t=>independent.value?t.systemId===choice.value:!!props.code&&extraAssociation(t,props.catalog)?.code===props.code)??[])
const association=computed(()=>independent.value?'独立来源系统；未与其他编号合并':available.value.map(t=>extraAssociation(t,props.catalog)?.rule??'').filter((r,i,a)=>r&&a.indexOf(r)===i).join('；'))
const selection=computed(()=>({tracks:available.value.filter(t=>enabled.value.includes(t.model)),independent:independent.value,title:independent.value?`${choice.value} ${systems.value.find(s=>s.id===choice.value)?.name??''} · 独立来源`:'',association:association.value,exportKey:`extra-${version.value}-${choice.value}-${enabled.value.join('_')}`}))
watch(selection,value=>emit('update',value),{immediate:true})
function stop(){if(loading.value)lastAttempt=0;++revision;controller?.abort();loading.value=false}
async function load(force=false){
  if(!props.active||(!force&&Date.now()-lastAttempt<300000))return
  stop();lastAttempt=Date.now();const token=revision;controller=new AbortController();const signal=controller.signal;loading.value=true;error.value=''
  if(force)clearRequestCache(fetch,'/api/model-tracks')
  try{const next=await loadModelTracks(signal);if(token===revision&&!signal.aborted){result.value=next;version.value++;lastAttempt=Date.now()}}
  catch(e){if(token===revision&&!signal.aborted)error.value=e instanceof Error?e.message:String(e)}
  finally{if(token===revision)loading.value=false}
}
watch(()=>props.active,active=>{if(active)void load();else stop()},{immediate:true})
watch(()=>props.refresh,()=>{if(props.active)void load(true)})
watch(()=>props.primary,()=>{choice.value='follow'})
onBeforeUnmount(stop)
</script>
<template>
<section class="extra-track-guidance">
<fieldset class="overview-extra-controls"><legend>其他模型（单一路径，不是系集均线／概率）</legend><label v-for="m in extraModels" :key="m.id" :style="{color:m.color}"><input v-model="enabled" type="checkbox" :value="m.id" :aria-label="`Show extra ${m.id}`"/>{{ m.label }}<small>{{ available.some(t=>t.model===m.id)?' · 此系统可用':' · 此系统无已核对路径' }}</small></label>
<label class="extra-system">来源系统 <select v-model="choice" aria-label="Extra model source system"><option value="follow">跟随主系统（仅有来源对照时叠加）</option><option v-for="s in systems" :key="s.id" :value="s.id">{{ s.name }} · {{ s.id }}（独立查看）</option></select></label></fieldset>
<p v-if="loading" role="status">读取 AIGFS／SD3 已验证路径…</p>
<p v-if="error" class="extra-warning" role="status">AIGFS／SD3：{{ error }}{{ result?'；保留上次成功结果，非本次确认更新':'' }}</p>
<p v-if="result&&Date.now()-Date.parse(result.checkedAt)>43200000" class="extra-warning" role="status">路径发布检查时间已超过12小时，保留有日期的旧结果；未确认最新，请留意各模型版本。</p>
<p v-if="independent" class="extra-note">目前独立查看其他来源；不叠加主系统的系集均线或 WMC 路径。</p>
<p v-else-if="association" class="extra-association">{{ association }}</p>
<p v-if="result&&!available.length&&!loading" class="extra-note">此主系统暂无唯一来源对照；可从「来源系统」独立查看，不借用其他气旋轨迹。</p>
<details class="extra-sources"><summary>AIGFS／SD3 来源、L追踪方法与截止位置</summary>
<p>AIGFS 为本站根据 NOAA 表面场 PRMSL 追踪的低压 L，不是供应商发布的气旋路径；可读0–384h，但低压消失、候选歧义或格点缺失时提前截止。只追踪位置，不推算风速或 Cat，也不确认热带结构。SD3 使用天机原生路径。</p>
<p v-if="result">来源检查 {{ result.checkedAt }} · <a href="/api/model-tracks" target="_blank" rel="noopener">公开 JSON（含原始场 URL／SHA-256）</a></p>
<p v-for="state in result?.models??[]" :key="state.model"><strong>{{ state.model }}</strong> · {{ state.status }} · {{ state.message }} · 检查 {{ state.checkedAt }}</p>
<article v-for="t in available" :key="t.model+t.systemId" :data-extra-source="t.model"><strong>{{ extraModels.find(m=>m.id===t.model)?.label }} · {{ t.systemId }}</strong>
<p>{{ t.model==='SD3'?'目录版本（不冒充起报）':'原始格点起报' }} {{ t.directoryRun }} · {{ t.model==='SD3'?'首个时间轴UTC（非已知起报）':'预报基准' }} {{ t.timeOrigin }} · {{ t.points.length }}点 · 原生范围 {{ t.points[0]?.leadHours }}–{{ t.points[t.points.length-1]?.leadHours }}h</p>
<p>{{ t.method }} {{ t.notes.join(' ') }} {{ t.endReason }} {{ t.retained?'保留有日期的旧结果，未确认本次更新。':'' }}</p>
<p v-if="t.seed">初始参考 WMC {{ t.seed.code }} {{ t.seed.model }} · 参考模式起报 {{ t.seed.forecastZero }} +{{ t.seed.leadHours }}h = {{ t.seed.validTime }}（不是实测定位）。</p>
<p v-if="t.sourceTimeUnits">NetCDF 时间定义：{{ t.sourceTimeUnits }}；依文件时间轴对齐UTC。原生风速 m/s、气压 hPa，缺测不补零。</p>
<p>{{ t.attribution }} · {{ t.license }} <a v-if="t.model==='SD3'" href="https://creativecommons.org/licenses/by-nc/4.0/" target="_blank" rel="noopener">仅限非商业、须署名</a> · <a :href="t.source" target="_blank" rel="noopener">原始来源</a></p></article>
</details></section>
</template>
<style scoped>
.extra-track-guidance{font-size:12px;line-height:1.8;min-width:0}.overview-extra-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;border:1px solid #dae6ed;border-radius:8px;margin:10px 0;padding:9px 12px;min-width:0}.overview-extra-controls legend{color:#577187}.overview-extra-controls label{display:flex;flex-wrap:wrap;align-items:center;gap:5px;min-width:0;max-width:100%}.overview-extra-controls small{font-size:10px}.extra-system select{max-width:100%;min-width:0;padding:5px;border:1px solid #d3dfe7;border-radius:6px}.extra-warning{background:#fff8e7;color:#92713b;padding:8px}.extra-note,.extra-association{color:#507985;background:#eff8fc;padding:8px}.extra-sources{color:#667e91;margin:10px 0}.extra-sources p{overflow-wrap:anywhere}.extra-sources article{border-top:1px solid #dae6ed;padding-top:6px;margin-top:8px}
</style>
