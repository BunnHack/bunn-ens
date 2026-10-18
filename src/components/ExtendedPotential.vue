<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import BasinPlot from './BasinPlot.vue'
import ChartFrame from './ChartFrame.vue'
import { basinCsv, basinRegions, pointInRegion, type BasinRegion, type MapTheme } from '../data/basin'
import { cycloneCatalog, cycloneChoices, cycloneMean, loadPotential, potentialModels, type PotentialModel, type PotentialResult } from '../data/potential'
import { passageField } from '../data/probability'
import { potentialDenominator, rangePresets, windowCatalog, windowValidTimes } from '../data/extended-potential'
import type { Catalog } from '../data/wnc2'
import { associationRules, candidateGroups, candidateMean } from '../data/candidate-groups'
import { focusTrackRegion } from '../data/overview'
import { clearRequestCache } from '../data/request-cache'

const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const models = potentialModels.filter(item => ['wn2','wn3','wm6','genc'].includes(item.id)).map(item => ({ ...item, id: item.id as PotentialModel, source: item.id === 'wm6' ? 'WindBorne WM-6 API' : `Google Weather Lab · ${item.id === 'genc' ? 'OPER' : item.id === 'wn3' ? 'WNV3' : 'FNV3P1'}` }))
const model = ref<PotentialModel>('wn2'), run = ref('latest'), storm = ref('all')
const start = ref(120), end = ref(312), product = ref<'ensemble' | 'probability'>('ensemble')
const theme = ref<MapTheme>('light'), showInfo = ref(false), showHours = ref(true), groupCandidates = ref(true)
const focusStorm = ref(true)
let autoSelectPending = true
const regions: BasinRegion[] = [{ id: 'extended-wp', label: '西太平洋／跨日期線', west: 100, east: 190, south: 0, north: 50 }, ...basinRegions]
const regionId = ref('extended-wp')
const region = computed(() => regions.find(item => item.id === regionId.value) ?? regions[0]!)
const result = shallowRef<PotentialResult | null>(null), loading = ref(false), error = ref('')
let controller: AbortController | undefined, revision = 0
const modelInfo = computed(() => models.find(item => item.id === model.value)!)
const title = computed(() => rangePresets.find(item => item.start === start.value && item.end === end.value)?.label ?? '自訂時窗襲擊潛勢')
const windowLabel = computed(() => `${start.value}–${end.value}h`)
const clustering = computed<ReturnType<typeof candidateGroups>>(() => result.value && groupCandidates.value ? candidateGroups(result.value.catalog) : { groups: [], minimumMembers: 3 })
const selectedGroup = computed(() => clustering.value.groups.find(item => item.key === storm.value))
const association = computed(() => selectedGroup.value ? `${selectedGroup.value.label}: local geometric association, not provider storm identity. One independent trajectory per member; original sample/track IDs retained. Conditional group mean, not a full-ensemble storm consensus; association uncertainty is uncalibrated.` : '')
const allChoices = computed(() => result.value ? [...cycloneChoices(result.value), ...clustering.value.groups] : [])
const choices = computed(() => allChoices.value.filter(option => option.points.some(point => point.leadHours >= start.value && point.leadHours <= end.value && pointInRegion(point, region.value))))
const matchedChoices = computed(() => choices.value.filter(option => option.kind === 'matched'))
const generatedChoices = computed(() => choices.value.filter(option => option.kind !== 'matched' && option.kind !== 'cluster'))
const groupChoices = computed(() => choices.value.filter(option => option.kind === 'cluster'))
const selectedChoice = computed(() => allChoices.value.find(item => item.key === storm.value))
const fullCatalog = computed<Catalog | null>(() => !result.value ? null : storm.value === 'all' ? result.value.catalog : selectedGroup.value ? { ...result.value.catalog, points: selectedGroup.value.points } : cycloneCatalog(result.value, storm.value))
const catalog = computed(() => fullCatalog.value ? windowCatalog(fullCatalog.value, start.value, end.value) : null)
const visible = computed(() => catalog.value?.points.filter(point => pointInRegion(point, mapRegion.value)) ?? [])
const trackCount = computed(() => new Set(visible.value.map(point => `${point.sample}:${point.trackId}`)).size)
const memberCount = computed(() => new Set(visible.value.map(point => point.sample)).size)
const mean = computed(() => (!result.value || storm.value === 'all' ? [] : selectedGroup.value ? candidateMean(selectedGroup.value) : selectedChoice.value?.kind === 'matched' ? cycloneMean(result.value, storm.value) : []).filter(point => point.leadHours >= start.value && point.leadHours <= end.value))
const meanLabel = computed(() => selectedGroup.value ? 'Local group mean' : storm.value === 'all' ? 'No cross-storm mean' : selectedChoice.value?.kind !== 'matched' ? 'Single-member candidate' : model.value === 'wm6' ? 'Provider mean' : 'Ensemble mean (≥25%)')
const mapRegion = computed(() => focusStorm.value && storm.value !== 'all' && catalog.value ? focusTrackRegion(mean.value.length ? mean.value : catalog.value.points, region.value) : region.value)
const denominator = computed(() => { try { return result.value ? potentialDenominator(result.value, selectedGroup.value ? 'all' : storm.value) : null } catch { return null } })
const probability = computed(() => {
  if (product.value !== 'probability' || !result.value || !fullCatalog.value) return { field: undefined, error: '' }
  try {
    const size = potentialDenominator(result.value, selectedGroup.value ? 'all' : storm.value)
    if (!catalog.value?.points.length) throw new Error('此時窗沒有可用路徑，不能解讀為零風險。')
    return { field: passageField(fullCatalog.value, mapRegion.value, size, 120, end.value, { minLead: start.value, allSystems: storm.value === 'all' || !!selectedGroup.value }), error: '' }
  } catch (cause) { return { field: undefined, error: cause instanceof Error ? cause.message : String(cause) } }
})
const validTimes = computed(() => { try { return result.value ? windowValidTimes(result.value, start.value, end.value) : [] } catch { return [] } })
const filename = computed(() => `${model.value}-${result.value?.catalog.initTime.replace(/[^0-9]/g, '') ?? 'loading'}-${storm.value.replace(/[^\w-]/g, '_')}-${product.value}-${regionId.value}-${focusStorm.value ? 'focus-' : ''}${start.value}-${end.value}h`)
const queryRuns = computed(() => {
  const values = new Map<string,string>(), loaded = result.value?.catalog.initTime
  if (loaded) values.set(`${loaded.slice(0,10)}|${loaded.slice(11,13)}z`, loaded+' UTC · 已載入')
  const anchor = Math.floor(Date.now()/21600000)*21600000
  for (let i=0;i<13;i++) {
    const value = new Date(anchor-i*21600000).toISOString(), key = `${value.slice(0,10)}|${value.slice(11,13)}z`
    if (!values.has(key)) values.set(key, value.replace('T',' ').slice(0,16)+' UTC · 查詢時次')
  }
  return [...values].map(([key,label]) => ({key,label}))
})
function utc(value: string) { return value.replace('T',' ').replace(/(?:\.000)?Z$/, ' UTC') }
function choose(modelId: PotentialModel, preset: typeof rangePresets[number]) {
  start.value = preset.start; end.value = preset.end
  if (model.value !== modelId) { model.value = modelId; run.value = 'latest'; storm.value = 'all' }
}
function changeStart(event: Event) { start.value = Math.min(Number((event.target as HTMLInputElement).value), end.value-6) }
function changeEnd(event: Event) { end.value = Math.max(Number((event.target as HTMLInputElement).value), start.value+6) }
async function refresh() {
  const token = ++revision; controller?.abort(); controller = new AbortController()
  const signal = controller.signal
  autoSelectPending = true; result.value = null; loading.value = true; error.value = ''
  if (!props.active) { loading.value=false; return }
  try {
    const loaded = await loadPotential(model.value, run.value, signal, undefined, { includeUnofficial: true })
    if (!signal.aborted && token === revision) result.value = loaded
  } catch (cause) { if (!signal.aborted && token === revision) error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (token === revision) loading.value = false }
}
function reload() { clearRequestCache(fetch, model.value === 'wm6' ? '/api/wm6' : '/api/wnc2'); refresh() }
function downloadCsv() {
  if (!catalog.value) return
  const url = URL.createObjectURL(new Blob([basinCsv(visible.value)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = `${filename.value}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
watch([model, run], refresh, { immediate: true })
watch(choices, options => {
  if (!result.value) return
  if (autoSelectPending) {
    autoSelectPending=false
    const group=[...clustering.value.groups].filter(g=>options.some(o=>o.key===g.key)&&candidateMean(g).filter(p=>p.leadHours>=start.value&&p.leadHours<=end.value).length>=2).sort((a,b)=>b.members-a.members)[0]
    storm.value=group?.key??options.find(o=>o.kind==='matched')?.key??'all'
  } else if (storm.value!=='all'&&!options.some(option=>option.key===storm.value)) storm.value='all'
})
watch(() => props.active, active => { if (!active) { ++revision; controller?.abort(); loading.value=false } else if (!result.value) refresh() })
onBeforeUnmount(() => { ++revision; controller?.abort() })
</script>

<template>
  <section class="extended-potential">
    <header class="ep-heading"><h1>{{ title }}</h1><span>{{ modelInfo.label }} · {{ windowLabel }}</span></header>
    <div class="ep-layout">
      <section class="ep-workspace" aria-label="中遠期預報圖">
        <p v-if="loading" class="ep-status" role="status">正在載入 {{ modelInfo.label }} 真實路徑…</p>
        <p v-if="error" class="ep-status ep-error" role="alert">{{ error }} <button @click="reload">重試</button></p>
        <p v-if="result?.warning" class="ep-status ep-warning">{{ result.warning }}</p>
        <p v-if="result?.source==='snapshot'" class="ep-status ep-warning">有日期的本地備份，未確認最新。</p>
        <p v-if="probability.error" class="ep-status ep-warning">{{ probability.error }} 不以空白或100%代替。</p>
        <ChartFrame v-if="result&&catalog&&active&&!probability.error" :filename="filename" :title="`${modelInfo.label} ${title} ${windowLabel}`"><BasinPlot :catalog="catalog" :region="mapRegion" :theme="theme" :model-label="modelInfo.label" :wind-mode="product==='ensemble'" :storm="storm==='all'?'All independent tracks':selectedChoice?.label??storm" :mean="mean" :mean-label="meanLabel" :association="association" :probability="probability.field" :lead-start="start" :lead-end="end" :show-lead-labels="product==='ensemble'&&showHours" :time-anchor="result.wm6?.forecastZero??''"/></ChartFrame>
        <p v-if="result" class="ep-provenance">{{ result.wm6?'供應商版本':'模型起報' }} {{ result.catalog.initTime }} UTC<span v-if="result.wm6"> · 預報基準 {{ result.wm6.forecastZero }}</span><span v-if="focusStorm&&storm!=='all'"> · 已聚焦系統均線，外圍成員可能超出圖域。</span></p>
        <p v-if="selectedGroup" class="ep-cluster-note">本站 G 為非官方幾何分群；均線只代表入群成員的條件平均，不是全系集共識。</p>
        <details class="ep-method" :open="showInfo"><summary>來源、分群及機率計算說明</summary>
          <div class="ep-counts" v-if="result"><p>圖域／時窗：{{ trackCount }} 路徑 · {{ memberCount }} 成員 · {{ visible.length }} 點。完整分母 {{ denominator??'不可用' }}；不按群組或圖域縮小。全球資料 {{ result.catalog.points.length }} 點、{{ result.catalog.totalSamples }} 已辨識成員。</p></div>
          <p v-if="validTimes.length">有效時間窗：{{ utc(validTimes[0]!) }} → {{ utc(validTimes[1]!) }}</p>
          <p class="ep-cluster-note">{{ clustering.note }} 本站 G 僅屬該模型／版本；不同 G 也可能只是同一未來系統的不同情境，不把群數當風暴數。可在進階選項關閉分群並查看原始獨立路徑。</p>
          <p>分群首個保留點時差≤{{ associationRules.startLagHours }}h（非官方生成時間），早期{{ associationRules.comparisonHours }}h內共同≥{{ associationRules.overlapHours }}h；球面距離中位數≤{{ associationRules.medianKm }}km、80分位≤{{ associationRules.p80Km }}km，每條直接符合參考路徑，不無限串鏈。同成員模糊配對不硬併；至少3位及本批成員5%。群均線逐時≥3位及群組25%；全部路徑不做跨風暴平均。</p>
          <p>本站機率為120km內、每成員每位置最多一次的通過比例，非官方襲擊／登陸／損害率。選G只計該群但保留完整系集分母。球面短弧裁切兩端，不跨越12h缺口、不連不同ID。缺失路徑可能使比例偏低，CSV漏整個成員可能使分母偏小、比例偏高；無路徑不等於安全。中文城市指市中心點，不是縣市覆蓋率。</p>
          <p>原始kt／hPa及成員／ID不變，不由氣壓換算風速。WM-6已匹配均線來自供應商，WN／GENC為本站條件平均。Natural Earth 1:50m簡化海岸／國界。時窗限0–312h。查詢完成 {{ result?.checkedAt }}，非模型起報時間。<a v-if="result?.url" :href="result.url" target="_blank" rel="noopener">實際資料來源 ↗</a></p>
          <details v-if="selectedGroup" class="ep-group-members"><summary>{{ selectedGroup.label }} 原始成員與ID（支持度非生成機率）</summary><p>不代表全體系集已同意有共同風暴。</p><ul><li v-for="track in selectedGroup.tracks" :key="`${track.sample}:${track.trackId}`">sample/member={{ track.sample }} · {{ track.trackId }}</li></ul></details>
        </details>
      </section>
      <aside class="ep-controls" aria-label="中遠期預報控制台"><h2>主機</h2>
        <label>模型<select v-model="model" aria-label="Potential model" @change="run='latest';storm='all'"><option v-for="item in models" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
        <label>起報／供應商版本<select v-model="run" aria-label="Potential initialization"><option value="latest">最新已發布</option><option v-for="item in queryRuns" :key="item.key" :value="item.key">{{ item.label }}</option></select></label>
        <label>預報類型</label><div class="ep-product-tabs"><button :class="{selected:product==='ensemble'}" @click="product='ensemble'">系集預報</button><button :class="{selected:product==='probability'}" @click="product='probability'">機率預報</button></div>
        <label>系統（本站G非官方身分）</label><div class="ep-storm-tabs"><button :class="{selected:storm==='all'}" @click="storm='all'">全部</button><button v-for="option in matchedChoices" :key="option.key" :class="{selected:storm===option.key}" @click="storm=option.key">{{ option.key }}</button><button v-for="option in groupChoices" :key="option.key" class="ep-group-button" :class="{selected:storm===option.key}" @click="storm=option.key">{{ option.label }}</button></div>
        <label>起始時效：+{{ start }}h<input :value="start" type="range" min="0" max="306" step="6" aria-label="Potential start hour" @input="changeStart"/></label><label>結束時效：+{{ end }}h<input :value="end" type="range" min="6" max="312" step="6" aria-label="Potential end hour" @input="changeEnd"/></label>
        <label>地圖區域<select v-model="regionId" aria-label="Potential region" @change="focusStorm=false"><option v-for="item in regions" :key="item.id" :value="item.id">{{ item.label }}</option></select></label><label class="ep-check"><input v-model="focusStorm" type="checkbox" aria-label="Focus candidate mean"/>自動放大系統／均線</label>
        <div class="ep-current"><strong>目前選擇</strong><p>{{ modelInfo.label }} · {{ product==='ensemble'?'系集':'機率' }} · {{ windowLabel }}</p><p>{{ selectedChoice?.label??'全部獨立路徑（無共同均線）' }}</p></div>
        <details class="ep-advanced"><summary>進階／原始路徑</summary><label>氣旋／候選<select v-model="storm" aria-label="Potential cyclone"><option value="all">全部獨立路徑（無共同均線）</option><optgroup v-if="matchedChoices.length" label="已匹配氣旋"><option v-for="item in matchedChoices" :key="item.key" :value="item.key">{{ item.label }}</option></optgroup><optgroup v-if="groupChoices.length" label="本站幾何候選群組（非官方身分）"><option v-for="item in groupChoices" :key="item.key" :value="item.key">{{ item.label }}</option></optgroup><optgroup v-if="generatedChoices.length" label="保留原始獨立單成員路徑"><option v-for="item in generatedChoices" :key="item.key" :value="item.key">{{ item.label }}</option></optgroup></select></label><label class="ep-check"><input v-model="groupCandidates" type="checkbox" aria-label="Associate candidate systems"/>本站候選分群</label><label class="ep-check"><input v-model="showHours" type="checkbox"/>抽樣時效標籤</label><label>主題<select v-model="theme" aria-label="Potential map theme"><option value="light">白底</option><option value="color">彩色</option><option value="dark">黑底</option></select></label><button class="ep-download" :disabled="!visible.length" @click="downloadCsv">下載圖域時窗CSV</button><button class="ep-refresh" :disabled="loading" @click="reload">重新查詢資料</button></details>
      </aside>
    </div>
  </section>
</template>
<style scoped>
.extended-potential{min-width:0;color:#52677a}.ep-heading{display:flex;gap:12px;align-items:baseline;margin:0 0 12px}.ep-heading h1{font-size:22px;color:#41647c}.ep-heading span{font-size:12px;color:#8194a2}.ep-layout{display:grid;grid-template-columns:minmax(0,1fr) 254px;gap:18px;align-items:start}.ep-layout>*{min-width:0}.ep-workspace{background:white;border:1px solid #e3e9ed;border-radius:10px;padding:16px;box-shadow:0 2px 6px #20354309}.ep-controls{background:white;border-radius:10px;padding:22px 17px;box-shadow:0 2px 6px #20354312}.ep-controls h2{text-align:center;font-size:17px;color:#555;margin-bottom:23px}.ep-controls label{display:block;font-size:12px;color:#697e8c;margin:17px 0 8px}.ep-controls select{width:100%;max-width:100%;min-width:0;padding:10px 8px;border:1px solid #dce4ea;border-radius:20px;background:white;color:#4d6373;font-size:12px}.ep-controls input[type=range]{display:block;width:100%;accent-color:#ff713a;margin-top:10px}.ep-controls label.ep-check{display:flex;gap:7px;align-items:center;font-size:11px}.ep-product-tabs,.ep-storm-tabs{display:flex;flex-wrap:wrap;gap:7px}.ep-product-tabs button,.ep-storm-tabs button{border:1px solid #43c1b6;color:#43b4ae;background:white;border-radius:22px;padding:9px 11px;font-size:11px}.ep-product-tabs button.selected,.ep-storm-tabs button.selected{background:#ff713a;color:white;border-color:#ff713a}.ep-current{background:#f7f8fa;padding:15px;margin-top:18px;border-radius:5px;font-size:12px;overflow-wrap:anywhere}.ep-current p{font-size:11px;color:#8a99a6;line-height:1.8}.ep-status{font-size:12px;padding:10px;background:#eef6fb;line-height:1.8}.ep-warning{background:#fff7e8;color:#9d752d}.ep-error{background:#fff0ee;color:#a0443c}.ep-provenance,.ep-cluster-note{font-size:11px;line-height:1.8;color:#7d90a0;margin:10px 0}.ep-method{font-size:11px;line-height:1.9;color:#8294a4;border-top:1px solid #e8edf1;padding-top:10px}.ep-method summary,.ep-advanced summary{cursor:pointer;color:#4a93b7}.ep-method a{color:#358dba}.ep-group-members ul{max-height:180px;overflow:auto;padding-left:18px}.ep-advanced{font-size:12px;line-height:1.7;margin-top:15px}.ep-advanced button{display:block;width:100%;border-radius:20px;padding:9px;margin-top:10px;color:#329faf;background:#eaf8fa}.ep-advanced button:disabled{opacity:.5}
@media(max-width:800px){.ep-layout{grid-template-columns:minmax(0,1fr)}.ep-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 15px}.ep-controls h2,.ep-controls .ep-current,.ep-controls .ep-advanced{grid-column:1/-1}.ep-workspace{padding:10px}.ep-heading h1{font-size:20px}}
</style>
