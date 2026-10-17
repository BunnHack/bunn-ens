<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { REFRESH_MS } from '../data/wnc2'
import { basinCsv, basinRegions, pointInRegion, type MapTheme } from '../data/basin'
import { cycloneCatalog, cycloneChoices, cycloneMean, cycloneRegion, isUnmatchedWm6Id, loadPotential, potentialModels, type PotentialModel, type PotentialResult } from '../data/potential'
import BasinPlot from './BasinPlot.vue'
import Wm6DataAudit from './Wm6DataAudit.vue'
import ChartFrame from './ChartFrame.vue'
import { focusedProbabilityRegion, passageField, type ProbabilityField } from '../data/probability'

const props = withDefaults(defineProps<{ mode?: 'basin' | 'typhoon' }>(), { mode: 'basin' })
const sections = ['主要模式預報', '主要模式誤差', '防御參考', '海洋預報', '1000-Member 產品']
const model = ref(props.mode === 'typhoon' ? 'wn2' : 'wn3')
const theme = ref<MapTheme>('light')
const regionId = ref('china')
const runChoice = ref('latest')
const includeUnofficial = ref(true)
const selectedStorm = ref('')
const forecastType = ref('ensemble')
const probabilityLead = ref(312)
const probabilityFullExtent = ref(false)
const products = [{ id: 'ensemble', label: '系集預報' }, { id: 'probability', label: '機率預報' }, { id: 'sst', label: '系集海溫' }, { id: 'heat', label: '系集熱焓' }]
const result = ref<PotentialResult | null>(null)
const loading = ref(false)
const error = ref('')
const showInfo = ref(false)
const supported = computed(() => ['wn3', 'wn2', 'wm6'].includes(model.value))
const title = computed(() => props.mode === 'basin' ? '洋區系集預報' : '台風潛勢預報')
const region = computed(() => basinRegions.find(item => item.id === regionId.value)!)
const selectedModel = computed(() => potentialModels.find(item => item.id === model.value)!)
const options = computed(() => result.value ? cycloneChoices(result.value) : [])
const plotted = computed(() => result.value ? props.mode === 'typhoon' ? cycloneCatalog(result.value, selectedStorm.value) : result.value.catalog : null)
const chartCatalog = computed(() => plotted.value && forecastType.value === 'probability' ? { ...plotted.value, points: plotted.value.points.filter(point => point.leadHours <= probabilityLead.value) } : plotted.value)
const mapRegion = computed(() => props.mode === 'typhoon' && plotted.value ? cycloneRegion(plotted.value) : region.value)
const visiblePoints = computed(() => chartCatalog.value?.points.filter(point => props.mode === 'typhoon' ? forecastType.value === 'probability' ? pointInRegion(point, probability.value.field?.region ?? mapRegion.value) : true : pointInRegion(point, region.value)) ?? [])
const mean = computed(() => result.value && props.mode === 'typhoon' ? cycloneMean(result.value, selectedStorm.value) : [])
const selectedKind = computed(() => options.value.find(option => option.key === selectedStorm.value)?.kind)
const meanLabel = computed(() => model.value === 'wm6' ? selectedKind.value === 'unmatched' ? 'Single member · no mean' : 'Provider mean' : 'Local mean ≥25% members')
const plottedMean = computed(() => forecastType.value === 'probability' ? mean.value.filter(point => point.leadHours <= probabilityLead.value) : mean.value)
const probability = computed<{ field: ProbabilityField | null; error: string }>(() => {
  if (forecastType.value !== 'probability' || props.mode !== 'typhoon' || !result.value || !plotted.value) return { field: null, error: '' }
  if (selectedKind.value !== 'matched') return { field: null, error: '單成員生成路徑沒有跨成員的氣旋識別，不能顯示為 100% 系集機率。請選擇已匹配氣旋。' }
  const denominator = model.value === 'wm6' ? result.value.details[selectedStorm.value]?.ens_size : result.value.catalog.totalSamples
  if (denominator == null) return { field: null, error: '供應商未提供 ens_size，不能把有路徑的成員數當成完整系集分母。' }
  try {
    const field = passageField(plotted.value, mapRegion.value, denominator, 120, probabilityLead.value)
    return { field: probabilityFullExtent.value ? field : passageField(plotted.value, focusedProbabilityRegion(field), denominator, 120, probabilityLead.value), error: '' }
  }
  catch (cause) { return { field: null, error: cause instanceof Error ? cause.message : '機率計算失敗' } }
})
const wm6Counts = computed(() => {
  const ids = [...new Set(visiblePoints.value.map(point => point.trackId))]
  return { matched: ids.filter(id => !isUnmatchedWm6Id(id)).length, unmatched: ids.filter(isUnmatchedWm6Id).length }
})
const runLabel = (date: string, cycle: string) => date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1年$2月$3日') + cycle.slice(0, 2) + '時 (UTC)'
const currentTime = computed(() => result.value ? runLabel(result.value.catalog.initTime.slice(0, 10), result.value.catalog.initTime.slice(11, 13)) : '尚無資料')
const chartFilename = computed(() => `${model.value}-${props.mode === 'typhoon' ? selectedStorm.value : regionId.value}-${result.value?.catalog.initTime ?? ''}-${forecastType.value}-0-${forecastType.value === 'probability' ? probabilityLead.value : 312}h${forecastType.value === 'probability' ? '-120km-' + (probabilityFullExtent.value ? 'full' : 'focus') : ''}`.replace(/[^A-Za-z0-9_-]/g, '-'))
const availableRuns = computed(() => {
  const times = new Map<string, string>()
  if (result.value) {
    const date = result.value.catalog.initTime.slice(0, 10), cycle = result.value.catalog.initTime.slice(11, 13) + 'z'
    times.set(date + '|' + cycle, runLabel(date, cycle) + ' · 已載入')
  }
  const now = Math.floor(Date.now() / 21_600_000) * 21_600_000
  for (let i = 0; i < 12; i++) {
    const date = new Date(now - i * 21_600_000).toISOString(), cycle = date.slice(11, 13) + 'z'
    times.set(date.slice(0, 10) + '|' + cycle, runLabel(date.slice(0, 10), cycle) + ' · 查詢時次')
  }
  times.set('2026-10-16|18z', '2026年10月16日18時 (UTC) · 指定時次')
  return [...times].map(([value, label]) => ({ value, label }))
})
let controller: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
function chooseModel(id: string) { model.value = id; runChoice.value = 'latest'; forecastType.value = 'ensemble' }
function navigateMode(event: Event, mode: 'basin' | 'typhoon') { if (props.mode !== mode) { event.preventDefault(); window.location.hash = '#weather-tools/' + mode } }
async function refresh() {
  controller?.abort(); result.value = null; error.value = ''; loading.value = false
  if (!supported.value) return
  const active = new AbortController(); controller = active; loading.value = true
  try {
    const data = await loadPotential(model.value as PotentialModel, runChoice.value, active.signal, fetch, { includeUnofficial: includeUnofficial.value })
    if (active.signal.aborted) return
    result.value = data
    const choices = cycloneChoices(data)
    if (!choices.some(item => item.key === selectedStorm.value)) selectedStorm.value = choices.find(item => item.key === 'WP292026')?.key ?? choices.find(item => item.kind === 'matched')?.key ?? choices[0]?.key ?? ''
  } catch (cause) { if (!active.signal.aborted) error.value = cause instanceof Error ? cause.message : '無法載入所選時次' }
  finally { if (!active.signal.aborted) loading.value = false }
}
function downloadCsv() {
  if (!result.value || !visiblePoints.value.length) return
  const url = URL.createObjectURL(new Blob([basinCsv(visiblePoints.value)], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a'); anchor.href = url
  const init = result.value.catalog.initTime
  anchor.download = (model.value === 'wn2' ? 'WNC2' : model.value === 'wn3' ? 'WNC3' : 'WM-6') + '-' + (props.mode === 'typhoon' ? selectedStorm.value.replace(/:/g, '-') : regionId.value) + '-' + init.slice(0, 10) + '-' + init.slice(11, 13) + 'z-0-312h.csv'
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function onVisibility() { if (document.visibilityState === 'visible' && runChoice.value === 'latest' && !loading.value) refresh() }
watch([model, runChoice], refresh)
watch(() => props.mode, () => { forecastType.value = 'ensemble' })
onMounted(() => {
  refresh()
  timer = setInterval(() => { if (runChoice.value === 'latest' && document.visibilityState !== 'hidden' && !loading.value) refresh() }, REFRESH_MS)
  document.addEventListener('visibilitychange', onVisibility)
})
onBeforeUnmount(() => { controller?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility) })
</script>

<template>
  <section class="basin-viewer" :data-theme="theme" :aria-label="title">
    <div class="basin-top"><a href="#weather-tools">← Weather Tools</a><h1 tabindex="-1">{{ title }}</h1><span>實際系集路徑 · 0–312h</span></div>
    <div class="basin-layout">
      <aside class="basin-sidebar basin-panel" aria-label="台風預報模式選單">
        <h2>台風預報</h2>
        <details v-for="section in sections" :key="section" class="basin-section"><summary>{{ section }}</summary><p>此分類產品尚未接入。</p></details>
        <details v-for="group in (['basin', 'typhoon'] as const)" :key="group" :open="mode === group" class="basin-section" :class="{ 'basin-model-list': mode === group }">
          <summary @click="navigateMode($event, group)">{{ group === 'basin' ? '洋區潛勢預報' : '台風潛勢預報' }}</summary>
          <template v-if="mode === group"><button v-for="item in potentialModels" :key="item.id" :class="{ active: model === item.id }" :aria-pressed="model === item.id" @click="chooseModel(item.id)">{{ item.label }} {{ group === 'basin' ? '全球洋區' : '台風襲擊潛勢' }}<small>{{ item.status }}</small></button></template>
          <a v-else :href="'#weather-tools/' + group">進入{{ group === 'basin' ? '洋區' : '台風' }}潛勢預報 →</a>
        </details>
      </aside>

      <div class="basin-chart-panel basin-panel">
        <p v-if="loading" class="basin-status" role="status">正在載入 {{ selectedModel.label }} 所選時次與成員路徑…</p>
        <div v-else-if="error" class="basin-error" role="alert"><h2>無法載入此時次</h2><p>{{ error }}</p><button @click="refresh">重試</button></div>
        <div v-else-if="!supported" class="basin-empty"><h2>{{ selectedModel.label }} 尚未接入</h2><p>不會以其他模式或舊圖片代替。</p><button @click="chooseModel('wn3')">查看 WNC3 預報</button></div>
        <div v-else-if="mode === 'typhoon' && ['sst', 'heat'].includes(forecastType)" class="basin-empty"><h2>{{ products.find(item => item.id === forecastType)?.label }} 尚未接入</h2><p>目前資料源不含海溫或海洋熱焓場，不以風速或氣壓替代。</p><button @click="forecastType = 'ensemble'">返回系集預報</button></div>
        <div v-else-if="forecastType === 'probability' && probability.error" class="basin-empty probability-unavailable" role="status"><h2>此路徑不能計算系集機率</h2><p>{{ probability.error }}</p><button @click="forecastType = 'ensemble'">返回系集預報</button></div>
        <template v-else-if="result && plotted">
          <ChartFrame :filename="chartFilename" :title="`${selectedModel.label} ${selectedStorm || region.label} 預報圖`"><BasinPlot v-if="chartCatalog" :catalog="chartCatalog" :region="probability.field?.region ?? mapRegion" :theme="theme" :model-label="selectedModel.label" :wind-mode="mode === 'typhoon' && forecastType === 'ensemble'" :storm="mode === 'typhoon' ? selectedStorm : ''" :mean="plottedMean" :mean-label="meanLabel" :time-anchor="result.wm6?.forecastZero ?? ''" :probability="probability.field ?? undefined" /></ChartFrame>
          <p v-if="probability.field" class="basin-data-note probability-method">本站計算的 120 km 通過比例，非官方襲擊／登陸／損害機率。時窗 0–{{ probabilityLead }}h；分母為完整系集 {{ probability.field.denominator }} 個成員，當前時窗有 {{ probability.field.trackedMembers }} 個成員追蹤到此氣旋，每個成員每個位置最多計一次。{{ model === 'wm6' ? '分母使用供應商 ens_size。' : '分母取整份全球 CSV 出現的成員數，不按氣旋／時窗縮減；若來源缺漏整個成員，比例可能偏高。' }}以球面短弧內插連續路徑，超過 12 小時缺口不連接；未追蹤／缺失成員不計命中，並不代表無風險。等值線網格約 {{ probability.field.step.toFixed(2) }}°，不是供應商 cone；城市標籤指市中心點 120 km 內，不是全縣市覆蓋率。預設圖域聚焦 ≥5% 通過區，可切換完整成員圖域。</p>
          <p class="basin-status" :class="{ 'basin-snapshot': result.source === 'snapshot' }">{{ result.source === 'snapshot' ? '離線快照 · 未確認為最新資料' : model === 'wm6' ? '已連接 WM-6 真實成員路徑' : '已連接 WeatherNext CSV' }} · {{ currentTime }} · {{ visiblePoints.length }} 個預報點 · 0–{{ forecastType === 'probability' ? probabilityLead : 312 }}h</p>
          <p v-if="result.wm6" class="basin-data-note wm6-track-counts">本次上游：{{ result.wm6.matchedCount }} 個匹配氣旋、{{ result.wm6.unmatchedCount }} 條未匹配成員路徑。當前圖中：{{ wm6Counts.matched }} 個匹配氣旋、{{ wm6Counts.unmatched }} 條未匹配路徑。{{ includeUnofficial ? '未匹配路徑是單一成員的生成候選，不代表同樣數目的獨立風暴，也不保證成颱；未自動併入命名氣旋。' : '未匹配路徑已隱藏。' }} 時效基準：{{ result.wm6.forecastZero }}。</p>
          <Wm6DataAudit v-if="result.wm6" :points="visiblePoints" :forecast-zero="result.wm6.forecastZero" />
          <p v-if="result.warning" class="basin-data-note" role="status">{{ result.warning }}</p>
          <p v-if="mode === 'typhoon' && forecastType === 'ensemble'" class="basin-data-note">顏色使用原始風速與本站風級，未放大強度。{{ model === 'wm6' ? selectedKind === 'unmatched' ? '此為未匹配單成員路徑，沒有系集平均線。' : '深色線為供應商平均路徑。' : '深色線為本站計算的平均路徑，僅保留至少 25% 成員存在的時效；數字 genesis ID 僅屬單一成員，不跨成員合併。' }}</p>
          <a v-if="result.url" class="basin-source" :href="result.url" target="_blank" rel="noopener noreferrer">原始{{ model === 'wm6' ? 'JSON' : 'CSV' }} 資料來源 ↗</a>
        </template>
      </div>

      <aside class="basin-controls basin-panel" aria-label="預報控制台">
        <h2>控制台</h2>
        <button v-if="mode === 'basin'" class="basin-csv" :disabled="!supported || loading || !visiblePoints.length" @click="downloadCsv">下載目前洋區CSV文件</button>
        <label class="basin-run">起報時間<select v-model="runChoice" :disabled="!supported" aria-label="洋區起報時間"><option value="latest">最新已發布時次 (UTC)</option><option v-for="run in availableRuns" :key="run.value" :value="run.value">{{ run.label }}</option></select></label>
        <label v-if="model === 'wm6'" class="wm6-unofficial-toggle"><input v-model="includeUnofficial" type="checkbox" @change="refresh" /> 顯示未匹配成員路徑（生成候選）</label>
        <template v-if="mode === 'typhoon'">
          <fieldset class="potential-products"><legend>預報類型</legend><div class="basin-buttons"><button v-for="product in products" :key="product.id" :class="{ selected: forecastType === product.id }" :aria-pressed="forecastType === product.id" @click="forecastType = product.id">{{ product.label }}</button></div></fieldset>
          <label v-if="forecastType === 'probability'" class="probability-window">120 km 通過比例 · 時窗 0–{{ probabilityLead }}h<input v-model.number="probabilityLead" type="range" min="0" max="312" step="6" aria-label="Probability maximum forecast hour" /></label>
          <label v-if="forecastType === 'probability'" class="wm6-unofficial-toggle"><input v-model="probabilityFullExtent" type="checkbox" aria-label="Show full probability map extent" /> 顯示完整成員圖域（預設聚焦 ≥5% 通過區）</label>
          <fieldset class="potential-storms"><legend>台風編號 / 單成員生成路徑</legend><div class="basin-buttons"><button v-for="option in options.filter(item => item.kind === 'matched')" :key="option.key" :class="{ selected: selectedStorm === option.key }" :aria-pressed="selectedStorm === option.key" @click="selectedStorm = option.key">{{ option.key }}</button></div><label v-if="options.some(item => item.kind !== 'matched')" class="basin-run">其他生成候選（獨立單成員）<select v-model="selectedStorm" aria-label="氣旋與單成員生成路徑"><optgroup label="已匹配氣旋"><option v-for="option in options.filter(item => item.kind === 'matched')" :key="option.key" :value="option.key">{{ option.label }}</option></optgroup><optgroup label="未匹配 / 單成員生成路徑"><option v-for="option in options.filter(item => item.kind !== 'matched')" :key="option.key" :value="option.key">{{ option.label }}</option></optgroup></select></label><p v-if="!options.length" class="basin-help">目前沒有可選氣旋。</p></fieldset>
        </template>
        <template v-else>
          <fieldset><legend>主題選擇</legend><div class="basin-buttons"><button v-for="item in ([['light', '淺色'], ['color', '彩色'], ['dark', '深色']] as const)" :key="item[0]" :class="{ selected: theme === item[0] }" :aria-pressed="theme === item[0]" @click="theme = item[0]">{{ item[1] }}</button></div></fieldset>
          <fieldset><legend>洋區選擇</legend><div class="basin-buttons"><button v-for="item in basinRegions" :key="item.id" :class="{ selected: regionId === item.id }" :aria-pressed="regionId === item.id" @click="regionId = item.id">{{ item.label }}</button></div></fieldset>
        </template>
        <div class="basin-current"><h3>當前選擇</h3><p>類型: {{ selectedModel.label }}{{ mode === 'basin' ? ' 全球洋區' : '台風襲擊潛勢' }}</p><p>起報: {{ currentTime }}</p><template v-if="mode === 'typhoon'"><p>預報: {{ products.find(item => item.id === forecastType)?.label }}</p><p>台風: {{ selectedStorm || '尚無資料' }}</p></template><p v-else>洋區: {{ region.label }}</p><p v-if="result">來源: {{ result.source === 'remote' ? '線上資料' : '離線快照' }}</p></div>
        <button v-if="mode === 'typhoon'" class="basin-csv potential-export" :disabled="forecastType !== 'ensemble' || loading || !visiblePoints.length" @click="downloadCsv">下載氣旋 CSV</button>
        <button class="basin-info" :aria-expanded="showInfo" aria-controls="basin-explanation" @click="showInfo = !showInfo">ⓘ <span>資料說明</span></button>
        <p v-if="showInfo" id="basin-explanation" class="basin-help">WN3C 使用 Google WNV3，WN2C 使用 FNV3P1。WM-6 預設 include_unofficial_ids=true：匹配氣旋讀取 members_path；未匹配系統依 API 定義使用其單成員 path，成員編號來自供應商 generated ID 的 _M 尾碼，不識別的 ID 則另查 detail。各路徑保留原始 ID、固定同一起報時間，不合併到命名氣旋，未畫錐形或登陸點。跨時次 index 不是當次預報；本圖只使用所選 initialization。最新模式每 5 分鐘檢查；手動時次不自動切換。只顯示 0–312h，以 forecast_zero 為時效基準，不生成缺失位置或增強風速。洋區圓圈依 hPa 著色；氣旋圖依原始 kt 分級。查詢時次不保證上游已發布。WeatherNext 資料遵循原始來源條款，≥1小時資料適用 CC BY 4.0。生成候選不代表官方成颱機率。</p>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.basin-viewer { --basin-bg: #f5f7fa; --basin-panel: #fff; --basin-text: #484d52; background: var(--basin-bg); color: var(--basin-text); }
.basin-viewer[data-theme="dark"] { --basin-bg: #17212b; --basin-panel: #253342; --basin-text: #e1e9f0; }
.basin-viewer[data-theme="color"] { --basin-bg: #edf7f7; }
.basin-top { display: flex; align-items: center; gap: 24px; margin-bottom: 16px; font-size: 12px; }
.basin-top a { color: #26bba8; }.basin-top h1 { font-size: 19px; font-weight: 500; color: var(--basin-text); }.basin-top span { margin-left: auto; color: #909aa4; }
.basin-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr) 260px; align-items: start; gap: 16px; }
.basin-panel { border-radius: 13px; padding: 22px 20px; background: var(--basin-panel); box-shadow: 0 2px 9px #2b3f5714; min-width: 0; }
.basin-panel h2 { text-align: center; color: var(--basin-text); font-size: 18px; font-weight: 400; margin: 0 0 24px; }
.basin-section { border: 1px solid #e5e9ee; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }.basin-section summary { padding: 18px 15px; background: #f7f8fa; color: #4c5055; font-size: 15px; cursor: pointer; list-style: none; }.basin-section summary::after { content: '⌄'; float: right; font-size: 12px; }.basin-section[open] summary::after { content: '⌃'; }.basin-section[open] summary { background: #e9edf0; }.basin-section p, .basin-section a { display: block; font-size: 12px; line-height: 1.7; padding: 4px 12px; }
.basin-model-list button { display: flex; align-items: center; justify-content: space-between; text-align: left; width: 100%; background: var(--basin-panel); color: #7e8389; padding: 14px 18px; font-size: 13px; border-bottom: 1px solid #edf0f3; }.basin-model-list button:last-child { border: 0; }.basin-model-list button.active { color: white; background: #4a91e3; }.basin-model-list small { font-size: 9px; opacity: .75; margin-left: 5px; }
.basin-chart-panel { padding: 16px 12px; display: flex; flex-direction: column; align-items: center; min-height: 600px; }.basin-chart-panel > .chart-frame { width: 100%; max-width: none; }
.basin-data-note { font-size: 11px; line-height: 1.7; color: #8a95a1; margin: 12px 0 0; }.basin-status { font-size: 12px; color: #26a994; line-height: 1.7; }.basin-snapshot { color: #c5872c; }.basin-source { font-size: 11px; color: #26bba8; }
.basin-empty, .basin-error { text-align: center; margin: auto; padding: 35px 20px; }.basin-empty p, .basin-error p { font-size: 14px; line-height: 1.8; }.basin-empty button, .basin-error button { padding: 12px 20px; color: white; background: #32baa8; border-radius: 24px; }
.basin-controls h2 { margin-bottom: 24px; }.basin-csv { width: 100%; border: 2px solid #42c9b6; border-radius: 25px; padding: 12px 8px; background: transparent; color: #2fbba9; font-size: 13px; }.basin-csv:disabled { opacity: .5; cursor: not-allowed; }
.basin-run { display: block; font-size: 13px; margin-top: 8px; }.basin-run select { display: block; width: 100%; border: 2px solid #e5e9ee; border-radius: 25px; padding: 12px 14px; margin-top: 12px; color: var(--basin-text); background: var(--basin-panel); font-size: 12px; }
.basin-controls fieldset { padding: 0; margin: 28px 0 0; border: 0; min-width: 0; }.basin-controls legend { padding: 0; font-size: 13px; margin-bottom: 14px; }.basin-buttons { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }.basin-buttons button { border: 2px solid #42c9b6; border-radius: 25px; padding: 10px 4px; color: #3ec4b1; background: transparent; font-size: 12px; }.basin-buttons button.selected { background: #ff6b35; color: white; border-color: #ff6b35; }
.basin-current { border-radius: 9px; background: var(--basin-bg); padding: 16px; margin-top: 25px; }.basin-current h3 { margin: 0 0 14px; font-size: 15px; }.basin-current p { font-size: 12px; line-height: 1.6; color: #8d959e; margin: 6px 0; }.basin-info { display: flex; align-items: center; gap: 8px; margin: 16px 0 0 auto; color: #438ed9; background: transparent; font-size: 25px; }.basin-info span { font-size: 11px; }.basin-help { font-size: 11px; color: #8a95a1; line-height: 1.8; }
@media (min-width: 1750px) { .basin-layout { grid-template-columns: 230px minmax(0, 1fr) 280px; } }
@media (max-width: 1200px) { .basin-layout { grid-template-columns: 210px minmax(0, 1fr); }.basin-controls { grid-column: 2; }.basin-sidebar { grid-row: 1 / span 2; }.basin-chart-panel { min-height: 350px; }.basin-controls fieldset { margin-top: 18px; }.basin-buttons { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 700px) { .basin-layout { grid-template-columns: minmax(0, 1fr); gap: 14px; }.basin-sidebar, .basin-controls { grid-column: 1; grid-row: auto; }.basin-sidebar { order: 0; }.basin-chart-panel { order: 1; padding: 10px; min-height: 260px; }.basin-controls { order: 2; }.basin-panel { padding: 16px; }.basin-top { flex-wrap: wrap; gap: 10px; }.basin-top span { display: none; }.basin-sidebar > .basin-section:not(.basin-model-list):nth-child(-n+6) { display: none; }.basin-model-list { margin-bottom: 0; }.basin-model-list button { padding: 10px 14px; }.basin-buttons { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.potential-storms .basin-buttons { display: flex; flex-wrap: wrap; }.potential-storms button { border-color: #4a91e3; color: #4a91e3; border-radius: 15px; padding: 10px; }.potential-export { margin-top: 18px; }.basin-run select { min-width: 0; text-overflow: ellipsis; }.basin-current p { overflow-wrap: anywhere; }
.wm6-unofficial-toggle { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.7; margin-top: 18px; }.wm6-unofficial-toggle input { flex: 0 0 auto; margin-top: 4px; }
.probability-window { display: block; font-size: 12px; margin-top: 18px; line-height: 1.8; }.probability-window input { display: block; width: 100%; }
</style>