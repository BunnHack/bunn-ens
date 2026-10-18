<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import ChartFrame from './ChartFrame.vue'
import CurrentStormPlot from './CurrentStormPlot.vue'
import { displayUtc, latestAnalysis, loadCurrentStorms, retainStormEntries, type CurrentStorms } from '../data/current-storms'
import { clearRequestCache } from '../data/request-cache'
const props=withDefaults(defineProps<{active?:boolean}>(),{active:true})
const result=shallowRef<CurrentStorms>(),selected=ref(''),loading=ref(false),error=ref(''),historyHours=ref(48),showForecast=ref(true)
let controller:AbortController|undefined,timer:ReturnType<typeof setInterval>|undefined,revision=0,lastAttempt=0
const entry=computed(()=>result.value?.entries.find(e=>e.id===selected.value)),storm=computed(()=>entry.value?.data)
const current=computed(()=>storm.value&&result.value?latestAnalysis(storm.value,result.value.providerTime):null)
const stale=computed(()=>current.value&&result.value&&(Date.parse(result.value.providerTime)-Date.parse(current.value.date)>12*3600000))
const clockWarning=computed(()=>result.value&&Math.abs(Date.now()-Date.parse(result.value.providerTime))>30*60000)
const filename=computed(()=>`current-${selected.value}-${current.value?.date.replace(/[^0-9]/g,'')??'unavailable'}-history${historyHours.value}-forecast${showForecast.value}-${entry.value?.checkedAt.replace(/[^0-9]/g,'')}-${error.value||entry.value?.retained?'retained':'source'}`)
const ordered=computed(()=>[...result.value?.entries??[]].sort((a,b)=>{const av=a.data&&result.value?latestAnalysis(a.data,result.value.providerTime)?.wind??-1:-1,bv=b.data&&result.value?latestAnalysis(b.data,result.value.providerTime)?.wind??-1:-1;return bv-av}))
function position(lat:number,lon:number){return `${Math.abs(lat)}°${lat<0?'S':'N'} ${Math.abs(lon)}°${lon<0?'W':'E'}`}
async function refresh(force=false){
  if(!props.active||loading.value)return
  if(force)clearRequestCache(fetch,'/api/current-storms')
  const token=++revision;controller?.abort();const active=new AbortController();controller=active;loading.value=true;error.value='';lastAttempt=Date.now()
  try{const next=await loadCurrentStorms(active.signal);if(token!==revision||active.signal.aborted)return;result.value=retainStormEntries(next,result.value);if(!next.entries.some(e=>e.id===selected.value))selected.value=ordered.value.find(e=>e.data&&!e.data.invest&&!e.data.disturbance)?.id??ordered.value[0]?.id??''}
  catch(cause){if(token===revision&&!active.signal.aborted)error.value=cause instanceof Error?cause.message:String(cause)}
  finally{if(token===revision)loading.value=false}
}
watch(()=>props.active,active=>{if(active){if(!lastAttempt||Date.now()-lastAttempt>=300000)void refresh()}else{if(loading.value)lastAttempt=0;++revision;controller?.abort();loading.value=false}})
onMounted(()=>{if(props.active)void refresh();timer=setInterval(()=>{if(props.active&&document.visibilityState==='visible')void refresh()},300000)})
onBeforeUnmount(()=>{++revision;controller?.abort();clearInterval(timer)})
</script>
<template>
<section class="current-storms" aria-label="Live current storms from Zoom Earth">
<div class="cs-toolbar"><label>Current Storm / 当前系统<select id="storm-select" v-model="selected" aria-label="Current storm" :disabled="!ordered.length"><option v-if="!ordered.length" value="">暂无可验证的系统</option><option v-for="e in ordered" :key="e.id" :value="e.id">{{ e.data?.title??e.id }}{{ e.retained?'（保留旧资料）':!e.data?'（无法读取）':'' }}</option></select></label><button :disabled="loading" @click="refresh(true)">{{ loading?'读取来源中…':'更新资料' }}</button><a href="/api/current-storms" target="_blank" rel="noopener">来源 JSON ↗</a></div>
<p v-if="error" class="cs-warning" role="alert">{{ error }}{{ result?'；保留先前成功资料，不代表本次已更新。':'；不以历史截图或模式预报冒充现况。' }}</p>
<p v-if="loading&&!result" class="cs-status" role="status">读取 Zoom Earth 来源时间、系统清单及逐点分析／预报…</p>
<p v-if="clockWarning" class="cs-warning">来源时钟与本机时间相差超过30分钟。以下依来源时间筛选，不能确认是当前现况。</p>
<p v-if="result&&!result.entries.length" class="cs-status" role="status">来源清单没有系统；不代表所有地区没有风险。</p>
<div v-if="storm&&result" class="cs-layout">
<article class="card cs-details"><div class="card-heading storm-heading"><div><p class="section-kicker">{{ storm.agencies }} VIA ZOOM EARTH</p><h2>{{ storm.name }}</h2><p>{{ current?.description||storm.description }}</p></div><span class="invest-badge">{{ storm.active?'来源标记活跃':'来源标记非活跃' }}</span></div>
<p class="cs-analysis">最新分析 / Latest analysis<br/><strong>{{ current?displayUtc(current.date):'无来源时间之前的分析点' }}</strong></p>
<dl class="storm-details"><div><dt>{{ storm.centroid?'扰动质心（非气旋中心）':'分析位置' }}</dt><dd>{{ current?position(current.lat,current.lon):'未提供' }}</dd></div><div><dt>原始最大风速</dt><dd>{{ current?.wind===null||current?.wind===undefined||storm.centroid?'未提供':`${current.wind} kt` }}</dd></div><div><dt>原始中心气压</dt><dd>{{ current?.pressure===null||current?.pressure===undefined?'未提供':`${current.pressure} hPa` }}</dd></div><div><dt>来源机构</dt><dd>{{ storm.agencies||'未提供' }}</dd></div><div><dt>来源洋区 / season</dt><dd>{{ current?.basin||'—' }} / {{ storm.season||'未提供' }}</dd></div><div><dt>来源预报点</dt><dd>{{ storm.track.filter(p=>p.forecast).length }} 个</dd></div><div v-if="storm.chance2day!==null"><dt>{{ storm.agencies }} 2日生成概率</dt><dd>{{ storm.chance2day }}%</dd></div><div v-if="storm.chance7day!==null"><dt>{{ storm.agencies }} 7日生成概率</dt><dd>{{ storm.chance7day }}%</dd></div><div v-if="storm.chance"><dt>来源生成潜势</dt><dd>{{ storm.chance }}</dd></div></dl>
<p v-if="stale" class="cs-warning">最新分析距来源时间已超过12小时，资料可能陈旧。</p><p v-if="entry?.error||entry?.retained" class="cs-warning">{{ entry?.error }}{{ entry?.retained?' 这是先前成功的有日期资料，非本次确认更新。':'' }}</p>
<p class="cs-method">保留来源 kt／hPa，不补风压值；沿用本站原始风级颜色与阈值，白边分析／深色边预报。仅使用来源原生cone／spline，不自行构造预报锥或平滑。扰动质心不是确定中心，生成概率不是袭击概率。{{ storm.centroid?'质心原始 wind=0 不作为已测得的无风显示。':'' }}</p>
<a class="cs-source-link" :href="`https://zoom.earth/storms/${storm.id}/`" target="_blank" rel="noopener">Zoom Earth 查看原系统／卫星 ↗</a>
</article>
<article class="card cs-map-card"><div class="cs-map-controls"><label>历史范围<select v-model.number="historyHours" aria-label="Current storm history"><option :value="24">最近24h</option><option :value="48">最近48h</option><option :value="0">全部来源历史</option></select></label><label><input v-model="showForecast" type="checkbox"/>显示来源预报</label></div><ChartFrame v-if="active" :key="storm.id" :filename="filename" :title="`${storm.title} source analysis and forecast`"><CurrentStormPlot :storm="storm" :provider-time="result.providerTime" :history-hours="historyHours" :show-forecast="showForecast" :checked-at="entry?.checkedAt" :retained="!!error||!!entry?.retained"/></ChartFrame></article>
</div>
<p v-else-if="entry?.error" class="cs-warning">{{ entry.error }}</p>
<details v-if="result" class="cs-provenance"><summary>来源、时间及原始编号</summary><p><a href="https://zoom.earth/" target="_blank" rel="noopener">Zoom Earth</a> / {{ storm?.agencies||'发布机构' }} · {{ storm?.id }} · 来源时钟 {{ displayUtc(result.providerTime) }} · 清单 {{ result.catalogDate }} · 本次查询 {{ displayUtc(result.checkedAt) }}<span v-if="entry?.retained"> · 所选保留资料查询 {{ displayUtc(entry.checkedAt) }}</span>。5分钟共享缓存，仅页面活跃时检查。来源ID不等于ATCF；下方模式独立选择。仅Current Storm显示来源实际提供的cone/spline，集合统计仍不含锥形或登陆点。以原发布机构警报为准。</p></details>
</section>
</template>
<style scoped>
.current-storms{min-width:0}.cs-toolbar{display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin-bottom:18px}.cs-toolbar label{display:grid;gap:7px;min-width:0;max-width:100%;font-size:12px;color:#667b93}.cs-toolbar select{max-width:100%;padding:10px;border:1px solid #bdcddc;border-radius:6px;background:white;color:#3e5f7c}.cs-toolbar button{padding:11px 17px;border-radius:20px;background:#e7f1fb;color:#346a9d;font-size:12px}.cs-toolbar button:disabled{opacity:.5}.cs-toolbar a,.cs-provenance a,.cs-source-link{font-size:12px;color:#397ca9}.cs-layout{display:grid;grid-template-columns:minmax(260px,.8fr) minmax(0,2fr);gap:20px;align-items:start}.cs-details{min-width:0}.cs-details .storm-heading{gap:8px;flex-wrap:wrap}.cs-analysis{margin:8px 20px 16px;color:#72859a;font-size:12px;line-height:1.9}.cs-analysis strong{color:#49647c;font-weight:500}.cs-map-card{padding:12px;min-width:0}.cs-map-controls{display:flex;flex-wrap:wrap;gap:15px;align-items:center;font-size:12px;color:#58728c;margin:3px 5px 12px}.cs-map-controls select{padding:6px;border:1px solid #cfdce5;border-radius:4px;background:white;color:#49657f}.cs-warning{padding:10px;background:#fff6e3;color:#946423;line-height:1.9;font-size:12px;overflow-wrap:anywhere}.cs-status{background:#edf5fb;color:#55768e;padding:15px;font-size:12px}.cs-method,.cs-provenance{font-size:11px;color:#7e91a4;line-height:1.9;overflow-wrap:anywhere}.cs-method{margin:14px 20px}.cs-source-link{display:block;margin:12px 20px 20px}.cs-provenance{margin:16px 0}.cs-details dd{white-space:normal;overflow-wrap:anywhere}.cs-details dt{min-width:75px}
@media(max-width:800px){.cs-layout{grid-template-columns:minmax(0,1fr)}.cs-toolbar{align-items:center}.cs-toolbar label{width:100%}.cs-toolbar select{width:100%}.cs-map-card{padding:8px}}
</style>
