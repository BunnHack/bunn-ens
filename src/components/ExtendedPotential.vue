<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import BasinPlot from './BasinPlot.vue'
import ChartFrame from './ChartFrame.vue'
import { basinCsv, basinRegions, pointInRegion, type BasinRegion, type MapTheme } from '../data/basin'
import { cycloneCatalog, cycloneChoices, cycloneMean, loadPotential, potentialModels, type PotentialModel, type PotentialResult } from '../data/potential'
import { passageField } from '../data/probability'
import { potentialDenominator, rangePresets, windowCatalog, windowValidTimes } from '../data/extended-potential'
import type { Catalog } from '../data/wnc2'

withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const models = potentialModels.filter(item => ['wn2','wn3','wm6'].includes(item.id)).map(item => ({ ...item, id: item.id as PotentialModel, source: item.id === 'wm6' ? 'WindBorne WM-6 API' : `Google Weather Lab · ${item.id === 'wn3' ? 'WNV3' : 'FNV3P1'}` }))
const model = ref<PotentialModel>('wn2'), run = ref('latest'), storm = ref('all')
const start = ref(120), end = ref(312), product = ref<'ensemble' | 'probability'>('ensemble')
const theme = ref<MapTheme>('light'), showInfo = ref(true), showHours = ref(true)
const regions: BasinRegion[] = [{ id: 'extended-wp', label: '西太平洋／跨日期線', west: 100, east: 190, south: 0, north: 50 }, ...basinRegions]
const regionId = ref('extended-wp')
const region = computed(() => regions.find(item => item.id === regionId.value) ?? regions[0]!)
const result = shallowRef<PotentialResult | null>(null), loading = ref(false), error = ref('')
let controller: AbortController | undefined, revision = 0
const modelInfo = computed(() => models.find(item => item.id === model.value)!)
const title = computed(() => rangePresets.find(item => item.start === start.value && item.end === end.value)?.label ?? '自訂時窗襲擊潛勢')
const windowLabel = computed(() => `${start.value}–${end.value}h`)
const allChoices = computed(() => result.value ? cycloneChoices(result.value) : [])
const choices = computed(() => allChoices.value.filter(option => option.points.some(point => point.leadHours >= start.value && point.leadHours <= end.value && pointInRegion(point, region.value))))
const matchedChoices = computed(() => choices.value.filter(option => option.kind === 'matched'))
const generatedChoices = computed(() => choices.value.filter(option => option.kind !== 'matched'))
const selectedChoice = computed(() => allChoices.value.find(item => item.key === storm.value))
const fullCatalog = computed<Catalog | null>(() => !result.value ? null : storm.value === 'all' ? result.value.catalog : cycloneCatalog(result.value, storm.value))
const catalog = computed(() => fullCatalog.value ? windowCatalog(fullCatalog.value, start.value, end.value) : null)
const visible = computed(() => catalog.value?.points.filter(point => pointInRegion(point, region.value)) ?? [])
const trackCount = computed(() => new Set(visible.value.map(point => `${point.sample}:${point.trackId}`)).size)
const memberCount = computed(() => new Set(visible.value.map(point => point.sample)).size)
const mean = computed(() => !result.value || storm.value === 'all' || selectedChoice.value?.kind !== 'matched' ? [] : cycloneMean(result.value, storm.value).filter(point => point.leadHours >= start.value && point.leadHours <= end.value))
const meanLabel = computed(() => storm.value === 'all' ? 'No cross-storm mean' : selectedChoice.value?.kind !== 'matched' ? 'Single-member candidate' : model.value === 'wm6' ? 'Provider mean' : 'Ensemble mean (≥25%)')
const denominator = computed(() => { try { return result.value ? potentialDenominator(result.value, storm.value) : null } catch { return null } })
const probability = computed(() => {
  if (product.value !== 'probability' || !result.value || !fullCatalog.value) return { field: undefined, error: '' }
  try {
    const size = potentialDenominator(result.value, storm.value)
    if (!catalog.value?.points.length) throw new Error('此時窗沒有可用路徑，不能解讀為零風險。')
    return { field: passageField(fullCatalog.value, region.value, size, 120, end.value, { minLead: start.value, allSystems: storm.value === 'all' }), error: '' }
  } catch (cause) { return { field: undefined, error: cause instanceof Error ? cause.message : String(cause) } }
})
const validTimes = computed(() => { try { return result.value ? windowValidTimes(result.value, start.value, end.value) : [] } catch { return [] } })
const filename = computed(() => `${model.value}-${result.value?.catalog.initTime.replace(/[^0-9]/g, '') ?? 'loading'}-${storm.value.replace(/[^\w-]/g, '_')}-${product.value}-${regionId.value}-${start.value}-${end.value}h`)
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
  result.value = null; loading.value = true; error.value = ''
  try {
    const loaded = await loadPotential(model.value, run.value, signal, undefined, { includeUnofficial: true })
    if (!signal.aborted && token === revision) result.value = loaded
  } catch (cause) { if (!signal.aborted && token === revision) error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { if (token === revision) loading.value = false }
}
function downloadCsv() {
  if (!catalog.value) return
  const url = URL.createObjectURL(new Blob([basinCsv(visible.value)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a'); link.href = url; link.download = `${filename.value}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
watch([model, run], refresh, { immediate: true })
watch(choices, options => { if (result.value && storm.value !== 'all' && !options.some(option => option.key === storm.value)) storm.value = 'all' })
onBeforeUnmount(() => { ++revision; controller?.abort() })
</script>

<template>
  <section class="extended-potential">
    <header class="ep-heading"><div><h1 tabindex="-1">{{ title }}</h1><p>真實系集路徑 · {{ windowLabel }} · 本站 120 km 通過比例，非官方襲擊／登陸機率</p></div><a href="#weather-tools">← Weather Tools</a></header>
    <div class="ep-layout">
      <aside class="ep-navigation" aria-label="潛勢導覽">
        <details><summary>主要模式預報</summary><a href="#forecast-models">WM-6 全球格點預報 ↗</a></details>
        <details open><summary>熱帶氣旋預報</summary><div class="ep-model-list"><section v-for="item in models" :key="item.id"><h2>{{ item.label }}</h2><button v-for="preset in rangePresets" :key="preset.id" :class="{ selected: model === item.id && start === preset.start && end === preset.end }" :aria-pressed="model === item.id && start === preset.start && end === preset.end" @click="choose(item.id, preset)">{{ preset.label }} <small>{{ preset.start }}–{{ preset.end }}h</small></button></section><p>ECMWF 官方襲擊率、風圈／海溫／熱含量未接入，不以參考圖片代替。</p></div></details>
        <details><summary>系集與資料說明</summary><p>獨立保留每個 sample／track ID。未匹配 WM-6 _M### 是真實單成員路徑，不虛構 C1 分組或均線。全系統模式沒有跨風暴平均。</p><a href="#weather-tools/basin">洋區系集預報</a><a href="#weather-tools/typhoon">單一氣旋詳細分析</a></details>
      </aside>
      <section class="ep-workspace" aria-label="中遠期預報圖">
        <div class="ep-chart-heading"><strong>{{ modelInfo.label }} · {{ windowLabel }}</strong><span>{{ product === 'ensemble' ? '系集預報' : '本站機率預報' }}</span></div>
        <div class="ep-storm-tabs" aria-label="氣旋選擇"><button :class="{ selected: storm === 'all' }" :aria-pressed="storm === 'all'" @click="storm = 'all'">全部獨立路徑</button><button v-for="option in matchedChoices" :key="option.key" :class="{ selected: storm === option.key }" :aria-pressed="storm === option.key" @click="storm = option.key">{{ option.label }}</button></div>
        <p v-if="loading" class="ep-status" role="status">正在載入並固定 {{ modelInfo.label }} 初始化；不沿用其他模型或時次圖…</p>
        <p v-if="error" class="ep-status ep-error" role="alert">{{ error }} <button @click="refresh">重試</button></p>
        <p v-if="result?.warning" class="ep-status ep-warning" role="status">部分資料未載入：{{ result.warning }}</p>
        <p v-if="result?.source === 'snapshot'" class="ep-status ep-warning">目前為有日期的本地備份，不是已確認的最新模式；請核對下方初始化與有效日期。</p>
        <p v-if="probability.error" class="ep-status ep-warning" role="status">{{ probability.error }} 不以空白或 100% 圖替代。</p>
        <template v-if="result && catalog && active && !probability.error"><ChartFrame :filename="filename" :title="`${modelInfo.label} ${title} ${windowLabel}`"><BasinPlot :catalog="catalog" :region="region" :theme="theme" :model-label="modelInfo.label" :wind-mode="product === 'ensemble'" :storm="storm === 'all' ? 'All independent tracks' : selectedChoice?.label ?? storm" :mean="mean" :mean-label="meanLabel" :probability="probability.field" :lead-start="start" :lead-end="end" :show-lead-labels="product === 'ensemble' && showHours" :time-anchor="result.wm6?.forecastZero ?? ''" /></ChartFrame></template>
        <div v-else-if="!loading && !error && !probability.error" class="ep-empty">尚無可用圖資。</div>
        <div v-if="result" class="ep-provenance"><p>Model init：<strong>{{ result.catalog.initTime }} UTC</strong><br v-if="result.wm6" /><span v-if="result.wm6">Forecast zero：{{ result.wm6.forecastZero }}（有效時間從此加算）</span></p><p v-if="validTimes.length">有效時間窗：{{ utc(validTimes[0]!) }} → {{ utc(validTimes[1]!) }}</p><p>{{ modelInfo.source }} · {{ result.source === 'remote' ? '供應商資料（以所示初始化為準）' : '明確標示的備份' }} · 查詢完成：{{ result.checkedAt }}（非模型起報時間）</p></div>
        <section v-if="showInfo" class="ep-method"><h2>圖表說明</h2><p>本頁近程定義 0–120h、中遠期 120–312h（第 5–13 天）。參考圖較長時效不代表本站有資料：本頁不補造 +312h 以後的點。數字時效標籤以 24h 間隔抽樣；右側為此時窗觸及圖域的每個成員原始風速峰值（kt）。</p><p>機率是選定時間窗內，路徑距某點 120 km 內的成員比例。全系統以「同一成員任一獨立氣旋通過」計一次；不連接不同 track ID，也不把生成候選拼成共同風暴。依球面最短弧裁切兩端時窗，不跨越大於 12h 缺口。</p><p>分母採 WM-6 供應商 ens_size，或 WeatherNext 完整 CSV 的成員數，不以畫面剩餘路徑數當分母。CSV 完全省略的成員無法恢復；沒有路徑不代表安全，資料不完整可能低估比例。低於 5% 不畫等值線；城市徽章是市中心點，非縣市面積或受災率。</p><p>原始 max_wind_kt／min_mslp_hpa 不由氣壓換算或放大。均線僅對單一已匹配風暴提供；地名為英文顯示簡寫。Natural Earth 1:50m 僅提供簡化海岸與國界。非官方警報、襲擊率或校準風險。</p></section>
      </section>
      <aside class="ep-controls" aria-label="中遠期預報控制台">
        <h2>控制台</h2><label>模型<select v-model="model" aria-label="Potential model" @change="run = 'latest'; storm = 'all'"><option v-for="item in models" :key="item.id" :value="item.id">{{ item.label }} · {{ item.id }}</option></select></label>
        <label>查詢初始化<select v-model="run" aria-label="Potential initialization"><option value="latest">最新已發布（由供應商解析）</option><option v-for="item in queryRuns" :key="item.key" :value="item.key">{{ item.label }}</option></select></label><p class="ep-small">歷史選單是查詢時次，不保證每個時次有資料。圖內 init 以實際回傳資料為準，不是目前時間。</p>
        <div class="ep-product-tabs"><button :class="{ selected: product === 'ensemble' }" :aria-pressed="product === 'ensemble'" @click="product = 'ensemble'">系集預報</button><button :class="{ selected: product === 'probability' }" :aria-pressed="product === 'probability'" @click="product = 'probability'">機率預報</button></div>
        <label>起始時效：+{{ start }}h<input :value="start" type="range" min="0" max="306" step="6" aria-label="Potential start hour" @input="changeStart" /></label><label>結束時效：+{{ end }}h<input :value="end" type="range" min="6" max="312" step="6" aria-label="Potential end hour" @input="changeEnd" /></label>
        <label>地圖區域<select v-model="regionId" aria-label="Potential region"><option v-for="item in regions" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
        <label>獨立生成候選<select v-model="storm" aria-label="Potential cyclone"><option value="all">全部獨立路徑（不做共同均線）</option><optgroup v-if="matchedChoices.length" label="已匹配氣旋"><option v-for="item in matchedChoices" :key="item.key" :value="item.key">{{ item.label }}</option></optgroup><optgroup v-if="generatedChoices.length" label="各自為單一成員，不虛構共同風暴"><option v-for="item in generatedChoices" :key="item.key" :value="item.key">{{ item.label }}</option></optgroup></select></label>
        <label>地圖主題<select v-model="theme" aria-label="Potential map theme"><option value="light">白底</option><option value="color">彩色</option><option value="dark">黑底</option></select></label><label class="ep-check"><input v-model="showHours" type="checkbox" />顯示抽樣時效標籤</label><label class="ep-check"><input v-model="showInfo" type="checkbox" />顯示詳細說明</label>
        <dl v-if="result" class="ep-counts"><div><dt>目前圖域／時窗</dt><dd>{{ trackCount }} 路徑 · {{ memberCount }} 成員 · {{ visible.length.toLocaleString() }} 點</dd></div><div><dt>全球原始資料</dt><dd>{{ result.catalog.points.length.toLocaleString() }} 點 · {{ result.catalog.totalSamples }} 已辨識成員</dd></div><div><dt>計算分母</dt><dd>{{ denominator ?? '不可用（未推測）' }}{{ denominator ? ' 成員；不按圖域縮小' : '' }}</dd></div><div v-if="result.wm6"><dt>WM-6 全部已載入</dt><dd>{{ result.wm6.matchedCount }} 已匹配／{{ result.wm6.unmatchedCount }} 未匹配單成員路徑</dd></div></dl>
        <button class="ep-download" :disabled="!visible.length" @click="downloadCsv">下載圖域時窗 CSV</button><button class="ep-refresh" :disabled="loading" @click="refresh">重新查詢資料</button><a class="ep-detailed" href="#weather-tools/typhoon">單一風暴資料核對 ↗</a>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.extended-potential { max-width: none; min-width: 0; padding: 0; color: #4e6275; }
.ep-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 0 0 18px; }
.ep-heading h1 { color: #365b78; font-size: 26px; }
.ep-heading p { margin: 7px 0 0; font-size: 12px; line-height: 1.7; color: #7a8da0; }
.ep-heading a { flex-shrink: 0; color: #3d9dd0; font-size: 12px; }
.ep-layout { display: grid; grid-template-columns: 190px minmax(0,1fr) 248px; gap: 18px; align-items: start; }
.ep-layout > * { min-width: 0; }
.ep-navigation { font-size: 13px; }
.ep-navigation details { border: 1px solid #dce5ed; border-radius: 5px; margin: 0 0 12px; background: white; overflow: hidden; }
.ep-navigation summary { padding: 16px 13px; font-weight: 600; cursor: pointer; color: #3976a6; }
.ep-navigation details[open] > summary { background: #e7f1fa; border-bottom: 1px solid #dce5ed; }
.ep-navigation details > p, .ep-model-list > p { font-size: 11px; color: #8a98a7; padding: 0 13px; line-height: 1.8; }
.ep-navigation a { display: block; padding: 12px; color: #349ed7; }
.ep-model-list section { padding: 12px 10px; border-bottom: 1px solid #edf1f5; }
.ep-model-list h2 { margin: 0 0 7px 6px; font-size: 15px; color: #8292a2; }
.ep-model-list button { display: block; width: 100%; text-align: left; padding: 11px 9px; background: transparent; color: #8593a4; border-radius: 4px; font-size: 12px; line-height: 1.5; }
.ep-model-list button small { display: block; opacity: .7; font-size: 10px; }
.ep-model-list button.selected { color: #318ac1; background: #e4f2fc; }
.ep-workspace { border-radius: 7px; background: white; border: 1px solid #dfe7ee; overflow: hidden; }
.ep-chart-heading { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 18px; border-bottom: 1px solid #e9eef3; font-size: 13px; color: #7d90a3; }
.ep-chart-heading strong { font-size: 16px; color: #49627d; }
.ep-storm-tabs { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 14px; }
.ep-storm-tabs button, .ep-product-tabs button { background: #edf1f6; color: #8391a4; border-radius: 4px; font-size: 12px; padding: 10px 11px; }
.ep-storm-tabs button.selected, .ep-product-tabs button.selected { color: white; background: #36a6dd; }
.ep-status { margin: 10px 16px; padding: 12px; color: #6d89a1; font-size: 12px; line-height: 1.8; background: #f1f6fb; border-radius: 5px; overflow-wrap: anywhere; }
.ep-status button { color: #2784b8; background: transparent; padding: 6px 12px; }
.ep-error { color: #a13a35; background: #fff0ed; }.ep-warning { color: #997b35; background: #fff9e8; }
.ep-empty { display: grid; place-items: center; min-height: 360px; color: #93a2b2; }
.ep-provenance { padding: 0 16px; color: #8295a7; font-size: 11px; line-height: 1.8; overflow-wrap: anywhere; }
.ep-provenance p { margin: 10px 0; }.ep-provenance strong { color: #55738b; }
.ep-method { padding: 16px; border-top: 1px solid #eaf0f5; color: #8697a8; font-size: 11px; line-height: 1.9; }.ep-method h2 { font-size: 13px; color: #65839b; }
.ep-controls { border: 1px solid #dfe7ee; border-radius: 7px; background: white; padding: 17px 15px; overflow-wrap: anywhere; }
.ep-controls h2 { margin: 0 0 16px; font-size: 16px; color: #687f92; }
.ep-controls label { display: grid; gap: 7px; font-size: 12px; color: #7f8fa2; margin: 15px 0; }
.ep-controls select { display: block; width: 100%; min-width: 0; max-width: 100%; min-height: 38px; border: 1px solid #cdd8e3; border-radius: 4px; color: #6d849b; background: white; padding: 7px; font-size: 12px; text-overflow: ellipsis; }
.ep-controls input[type=range] { width: 100%; min-width: 0; accent-color: #329fd6; }
.ep-small { font-size: 10px; color: #9aa8b6; line-height: 1.8; }
.ep-product-tabs { display: flex; gap: 5px; border-top: 1px solid #edf1f5; padding-top: 14px; }.ep-product-tabs button { flex: 1; }
.ep-controls .ep-check { display: flex; align-items: center; gap: 8px; margin: 12px 0; }.ep-check input { accent-color: #36a6dd; }
.ep-counts { font-size: 11px; line-height: 1.7; margin: 18px 0; padding-top: 7px; border-top: 1px solid #e8eef4; }.ep-counts > div { margin: 9px 0; }.ep-counts dt { color: #9aa8b7; }.ep-counts dd { margin: 4px 0 0; color: #5f7c96; }
.ep-download, .ep-refresh { width: 100%; margin: 5px 0; padding: 11px 7px; border-radius: 20px; font-size: 12px; color: #379acf; background: #eaf5fb; }.ep-refresh { border: 1px solid #d1e5f1; background: white; }.ep-controls button:disabled { opacity: .4; cursor: default; }.ep-detailed { display: block; margin-top: 14px; text-align: center; color: #4c9ac3; font-size: 11px; }
@media (min-width: 1800px) { .ep-layout { grid-template-columns: 225px minmax(0,1fr) 270px; gap: 24px; } }
@media (max-width: 1150px) { .ep-layout { grid-template-columns: 165px minmax(0,1fr) 220px; gap: 12px; }.ep-controls { padding: 14px 12px; } }
@media (max-width: 1000px) { .ep-layout { grid-template-columns: 175px minmax(0,1fr); }.ep-navigation { grid-column: 1; grid-row: 1 / span 2; }.ep-workspace { grid-column: 2; }.ep-controls { grid-column: 2; }.ep-controls label { max-width: 100%; } }
@media (max-width: 700px) { .ep-heading { align-items: flex-start; }.ep-heading h1 { font-size: 22px; }.ep-heading a { font-size: 10px; }.ep-layout { grid-template-columns: minmax(0,1fr); }.ep-navigation, .ep-workspace, .ep-controls { grid-column: 1; grid-row: auto; }.ep-navigation { order: 0; }.ep-workspace { order: 2; }.ep-controls { order: 1; }.ep-model-list { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); }.ep-model-list section { padding: 9px 5px; }.ep-model-list button { font-size: 10px; padding: 9px 4px; }.ep-model-list h2 { font-size: 13px; }.ep-model-list > p { grid-column: 1 / -1; }.ep-controls { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 0 12px; }.ep-controls h2, .ep-controls > .ep-small, .ep-controls > .ep-product-tabs, .ep-controls > .ep-counts, .ep-detailed { grid-column: 1 / -1; }.ep-controls label { margin: 10px 0; }.ep-chart-heading { padding: 14px; }.ep-empty { min-height: 240px; }.ep-provenance { font-size: 10px; } }
</style>
