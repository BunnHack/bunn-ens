<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { REFRESH_MS } from '../data/wnc2'
import { basinCsv, basinRegions, pointInRegion, type MapTheme } from '../data/basin'
import { cycloneCatalog, cycloneChoices, cycloneMean, cycloneRegion, loadPotential, potentialModels, type PotentialModel, type PotentialResult } from '../data/potential'
import BasinPlot from './BasinPlot.vue'

const props = withDefaults(defineProps<{ mode?: 'basin' | 'typhoon' }>(), { mode: 'basin' })
const sections = ['主要模式預報', '主要模式誤差', '防御參考', '海洋預報', '1000-Member 產品']
const model = ref(props.mode === 'typhoon' ? 'wn2' : 'wn3')
const theme = ref<MapTheme>('light')
const regionId = ref('china')
const runChoice = ref('latest')
const selectedStorm = ref('')
const forecastType = ref('ensemble')
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
const mapRegion = computed(() => props.mode === 'typhoon' && plotted.value ? cycloneRegion(plotted.value) : region.value)
const visiblePoints = computed(() => plotted.value?.points.filter(point => props.mode === 'typhoon' || pointInRegion(point, region.value)) ?? [])
const mean = computed(() => result.value && props.mode === 'typhoon' ? cycloneMean(result.value, selectedStorm.value) : [])
const runLabel = (date: string, cycle: string) => date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1年$2月$3日') + cycle.slice(0, 2) + '時 (UTC)'
const currentTime = computed(() => result.value ? runLabel(result.value.catalog.initTime.slice(0, 10), result.value.catalog.initTime.slice(11, 13)) : '尚無資料')
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
    const data = await loadPotential(model.value as PotentialModel, runChoice.value, active.signal)
    if (active.signal.aborted) return
    result.value = data
    const choices = cycloneChoices(data)
    if (!choices.some(item => item.key === selectedStorm.value)) selectedStorm.value = choices.find(item => item.key === 'WP292026')?.key ?? choices.find(item => !item.key.startsWith('genesis:'))?.key ?? choices[0]?.key ?? ''
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
        <div v-else-if="mode === 'typhoon' && forecastType !== 'ensemble'" class="basin-empty"><h2>{{ products.find(item => item.id === forecastType)?.label }} 尚未接入</h2><p>{{ forecastType === 'probability' ? '目前沒有定義門檻、時窗與分母的襲擊機率資料，系集線條不能當作官方機率。' : '目前資料源不含海溫或海洋熱焓場，不以風速或氣壓替代。' }}</p><button @click="forecastType = 'ensemble'">返回系集預報</button></div>
        <template v-else-if="result && plotted">
          <BasinPlot :catalog="plotted" :region="mapRegion" :theme="theme" :model-label="selectedModel.label" :wind-mode="mode === 'typhoon'" :storm="mode === 'typhoon' ? selectedStorm : ''" :mean="mean" :mean-label="model === 'wm6' ? 'Provider mean' : 'Local mean ≥25% members'" />
          <p class="basin-status" :class="{ 'basin-snapshot': result.source === 'snapshot' }">{{ result.source === 'snapshot' ? '離線快照 · 未確認為最新資料' : model === 'wm6' ? '已連接 WM-6 真實成員路徑' : '已連接 WeatherNext CSV' }} · {{ currentTime }} · {{ visiblePoints.length }} 個預報點 · 0–312h</p>
          <p v-if="result.warning" class="basin-data-note" role="status">{{ result.warning }}</p>
          <p v-if="mode === 'typhoon'" class="basin-data-note">顏色使用原始風速與本站風級，未放大強度。{{ model === 'wm6' ? '黑線為供應商平均路徑。' : '黑線為本站計算的平均路徑，僅保留至少 25% 成員存在的時效；數字 genesis ID 僅屬單一成員，不跨成員合併。' }}</p>
          <a v-if="result.url" class="basin-source" :href="result.url" target="_blank" rel="noopener noreferrer">原始{{ model === 'wm6' ? 'JSON' : 'CSV' }} 資料來源 ↗</a>
        </template>
      </div>

      <aside class="basin-controls basin-panel" aria-label="預報控制台">
        <h2>控制台</h2>
        <button v-if="mode === 'basin'" class="basin-csv" :disabled="!supported || loading || !visiblePoints.length" @click="downloadCsv">下載目前洋區CSV文件</button>
        <label class="basin-run">起報時間<select v-model="runChoice" :disabled="!supported" aria-label="洋區起報時間"><option value="latest">最新已發布時次 (UTC)</option><option v-for="run in availableRuns" :key="run.value" :value="run.value">{{ run.label }}</option></select></label>
        <template v-if="mode === 'typhoon'">
          <fieldset class="potential-products"><legend>預報類型</legend><div class="basin-buttons"><button v-for="product in products" :key="product.id" :class="{ selected: forecastType === product.id }" :aria-pressed="forecastType === product.id" @click="forecastType = product.id">{{ product.label }}</button></div></fieldset>
          <fieldset class="potential-storms"><legend>台風編號 / 單成員生成路徑</legend><div class="basin-buttons"><button v-for="option in options.filter(item => !item.key.startsWith('genesis:'))" :key="option.key" :class="{ selected: selectedStorm === option.key }" :aria-pressed="selectedStorm === option.key" @click="selectedStorm = option.key">{{ option.key }}</button></div><label v-if="options.some(item => item.key.startsWith('genesis:'))" class="basin-run">其他路徑<select v-model="selectedStorm" aria-label="氣旋與單成員生成路徑"><option v-for="option in options" :key="option.key" :value="option.key">{{ option.label }}</option></select></label><p v-if="!options.length" class="basin-help">目前沒有可選氣旋。</p></fieldset>
        </template>
        <template v-else>
          <fieldset><legend>主題選擇</legend><div class="basin-buttons"><button v-for="item in ([['light', '淺色'], ['color', '彩色'], ['dark', '深色']] as const)" :key="item[0]" :class="{ selected: theme === item[0] }" :aria-pressed="theme === item[0]" @click="theme = item[0]">{{ item[1] }}</button></div></fieldset>
          <fieldset><legend>洋區選擇</legend><div class="basin-buttons"><button v-for="item in basinRegions" :key="item.id" :class="{ selected: regionId === item.id }" :aria-pressed="regionId === item.id" @click="regionId = item.id">{{ item.label }}</button></div></fieldset>
        </template>
        <div class="basin-current"><h3>當前選擇</h3><p>類型: {{ selectedModel.label }}{{ mode === 'basin' ? ' 全球洋區' : '台風襲擊潛勢' }}</p><p>起報: {{ currentTime }}</p><template v-if="mode === 'typhoon'"><p>預報: {{ products.find(item => item.id === forecastType)?.label }}</p><p>台風: {{ selectedStorm || '尚無資料' }}</p></template><p v-else>洋區: {{ region.label }}</p><p v-if="result">來源: {{ result.source === 'remote' ? '線上資料' : '離線快照' }}</p></div>
        <button v-if="mode === 'typhoon'" class="basin-csv potential-export" :disabled="forecastType !== 'ensemble' || loading || !visiblePoints.length" @click="downloadCsv">下載氣旋 CSV</button>
        <button class="basin-info" :aria-expanded="showInfo" aria-controls="basin-explanation" @click="showInfo = !showInfo">ⓘ <span>資料說明</span></button>
        <p v-if="showInfo" id="basin-explanation" class="basin-help">WN3C 使用 Google WNV3，WN2C 使用 FNV3P1；WM-6 僅載入上游正式氣旋的 members_path，固定同一起報時間，未使用錐形或登陸點。最新模式每 5 分鐘檢查；手動時次不自動切換。只顯示 0–312h，不生成缺失位置或增強風速。洋區圓圈依 MSLP 著色；氣旋圖依風級著色。查詢時次不保證上游已發布。WeatherNext 資料遵循原始來源條款，≥1小時資料適用 CC BY 4.0。系集潛勢不等於官方機率，請以官方警報為準。</p>
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
.basin-layout { display: grid; grid-template-columns: 260px minmax(0, 1fr) 300px; align-items: start; gap: 20px; }
.basin-panel { border-radius: 13px; padding: 22px 20px; background: var(--basin-panel); box-shadow: 0 2px 9px #2b3f5714; min-width: 0; }
.basin-panel h2 { text-align: center; color: var(--basin-text); font-size: 18px; font-weight: 400; margin: 0 0 24px; }
.basin-section { border: 1px solid #e5e9ee; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }.basin-section summary { padding: 18px 15px; background: #f7f8fa; color: #4c5055; font-size: 15px; cursor: pointer; list-style: none; }.basin-section summary::after { content: '⌄'; float: right; font-size: 12px; }.basin-section[open] summary::after { content: '⌃'; }.basin-section[open] summary { background: #e9edf0; }.basin-section p, .basin-section a { display: block; font-size: 12px; line-height: 1.7; padding: 4px 12px; }
.basin-model-list button { display: flex; align-items: center; justify-content: space-between; text-align: left; width: 100%; background: var(--basin-panel); color: #7e8389; padding: 14px 18px; font-size: 13px; border-bottom: 1px solid #edf0f3; }.basin-model-list button:last-child { border: 0; }.basin-model-list button.active { color: white; background: #4a91e3; }.basin-model-list small { font-size: 9px; opacity: .75; margin-left: 5px; }
.basin-chart-panel { padding: 20px; display: flex; flex-direction: column; align-items: center; min-height: 600px; }.basin-chart-panel > svg, .basin-reference { width: 100%; max-width: 870px; }.basin-reference { margin: 0; }.basin-reference img { display: block; width: 100%; height: auto; border-radius: 6px; box-shadow: 0 3px 13px #0002; }.basin-reference figcaption { font-size: 11px; color: #8a95a1; line-height: 1.7; margin-top: 12px; }
.basin-data-note { font-size: 11px; line-height: 1.7; color: #8a95a1; margin: 12px 0 0; }.basin-status { font-size: 12px; color: #26a994; line-height: 1.7; }.basin-snapshot { color: #c5872c; }.basin-source { font-size: 11px; color: #26bba8; }
.basin-empty, .basin-error { text-align: center; margin: auto; padding: 35px 20px; }.basin-empty p, .basin-error p { font-size: 14px; line-height: 1.8; }.basin-empty button, .basin-error button { padding: 12px 20px; color: white; background: #32baa8; border-radius: 24px; }
.basin-controls h2 { margin-bottom: 24px; }.basin-csv { width: 100%; border: 2px solid #42c9b6; border-radius: 25px; padding: 12px 8px; background: transparent; color: #2fbba9; font-size: 13px; }.basin-csv:disabled { opacity: .5; cursor: not-allowed; }
.basin-run { display: block; font-size: 13px; margin-top: 8px; }.basin-run select { display: block; width: 100%; border: 2px solid #e5e9ee; border-radius: 25px; padding: 12px 14px; margin-top: 12px; color: var(--basin-text); background: var(--basin-panel); font-size: 12px; }
.basin-controls fieldset { padding: 0; margin: 28px 0 0; border: 0; min-width: 0; }.basin-controls legend { padding: 0; font-size: 13px; margin-bottom: 14px; }.basin-buttons { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }.basin-buttons button { border: 2px solid #42c9b6; border-radius: 25px; padding: 10px 4px; color: #3ec4b1; background: transparent; font-size: 12px; }.basin-buttons button.selected { background: #ff6b35; color: white; border-color: #ff6b35; }
.basin-current { border-radius: 9px; background: var(--basin-bg); padding: 16px; margin-top: 25px; }.basin-current h3 { margin: 0 0 14px; font-size: 15px; }.basin-current p { font-size: 12px; line-height: 1.6; color: #8d959e; margin: 6px 0; }.basin-info { display: flex; align-items: center; gap: 8px; margin: 16px 0 0 auto; color: #438ed9; background: transparent; font-size: 25px; }.basin-info span { font-size: 11px; }.basin-help { font-size: 11px; color: #8a95a1; line-height: 1.8; }
@media (min-width: 1750px) { .basin-layout { grid-template-columns: 280px minmax(0, 1fr) 320px; }.basin-chart-panel { padding: 20px 45px; } }
@media (max-width: 1200px) { .basin-layout { grid-template-columns: 210px minmax(0, 1fr); }.basin-controls { grid-column: 2; }.basin-sidebar { grid-row: 1 / span 2; }.basin-chart-panel { min-height: 350px; }.basin-controls fieldset { margin-top: 18px; }.basin-buttons { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 700px) { .basin-layout { grid-template-columns: minmax(0, 1fr); gap: 14px; }.basin-sidebar, .basin-controls { grid-column: 1; grid-row: auto; }.basin-sidebar { order: 0; }.basin-chart-panel { order: 1; padding: 10px; min-height: 260px; }.basin-controls { order: 2; }.basin-panel { padding: 16px; }.basin-top { flex-wrap: wrap; gap: 10px; }.basin-top span { display: none; }.basin-sidebar > .basin-section:not(.basin-model-list):nth-child(-n+6) { display: none; }.basin-model-list { margin-bottom: 0; }.basin-model-list button { padding: 10px 14px; }.basin-buttons { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.potential-storms .basin-buttons { display: flex; flex-wrap: wrap; }.potential-storms button { border-color: #4a91e3; color: #4a91e3; border-radius: 15px; padding: 10px; }.potential-export { margin-top: 18px; }.basin-run select { min-width: 0; text-overflow: ellipsis; }.basin-current p { overflow-wrap: anywhere; }
</style>