<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadEnsemble, REFRESH_MS, sourceUrl, type Cycle, type DataResult } from '../data/wnc2'
import { basinCsv, basinRegions, pointInRegion, type MapTheme } from '../data/basin'
import BasinPlot from './BasinPlot.vue'

const models = [
  { id: 'wn3', label: 'WN3C 全球洋區', status: '參考圖' },
  { id: 'wn2', label: 'WN2C 全球洋區', status: '可用' },
  { id: 'ecmwf', label: 'ECMWF 全球洋區', status: '未接入' },
  { id: 'aifs', label: 'AIFS 全球洋區', status: '未接入' },
  { id: 'gefs', label: 'GEFS 全球洋區', status: '未接入' },
  { id: 'aigefs', label: 'AIGEFS 全球洋區', status: '未接入' },
  { id: 'genc', label: 'GENC 全球洋區', status: '未接入' },
]
const sections = ['主要模式預報', '主要模式誤差', '防御參考', '海洋預報', '1000-Member 產品']
const model = ref('wn3')
const theme = ref<MapTheme>('light')
const regionId = ref('china')
const runChoice = ref('reference')
const result = ref<DataResult | null>(null)
const loading = ref(false)
const error = ref('')
const showInfo = ref(false)
const region = computed(() => basinRegions.find(item => item.id === regionId.value)!)
const selectedModel = computed(() => models.find(item => item.id === model.value)!)
const visiblePoints = computed(() => result.value?.catalog.points.filter(point => pointInRegion(point, region.value)) ?? [])
const runLabel = (date: string, cycle: string) => `${date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1年$2月$3日')}${cycle.slice(0, 2)}時 (UTC)`
const currentTime = computed(() => model.value === 'wn3' ? '2026年10月16日06時 (UTC) · 參考圖' : result.value ? runLabel(result.value.run.date, result.value.run.cycle) : '尚無資料')
const availableRuns = computed(() => {
  const times = new Map<string, string>()
  if (result.value) times.set(`${result.value.run.date}|${result.value.run.cycle}`, runLabel(result.value.run.date, result.value.run.cycle))
  const now = Math.floor(Date.now() / 21_600_000) * 21_600_000
  for (let i = 0; i < 12; i++) {
    const date = new Date(now - i * 21_600_000).toISOString(), cycle = `${date.slice(11, 13)}z`
    times.set(`${date.slice(0, 10)}|${cycle}`, runLabel(date.slice(0, 10), cycle))
  }
  times.set('2026-10-13|00z', '2026年10月13日00時 (UTC) · 已存快照時次')
  return [...times].map(([value, label]) => ({ value, label }))
})
let controller: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
function chooseModel(id: string) {
  model.value = id
  runChoice.value = id === 'wn3' ? 'reference' : 'latest'
}
async function refresh() {
  controller?.abort(); result.value = null; error.value = ''; loading.value = false
  if (model.value !== 'wn2') return
  const active = new AbortController(); controller = active; loading.value = true
  try {
    const [date, cycle] = runChoice.value.split('|')
    const data = await loadEnsemble({ model: 'FNV3P1', cycle: runChoice.value === 'latest' ? 'latest' : cycle as Cycle, date: runChoice.value === 'latest' ? undefined : date }, active.signal)
    if (!active.signal.aborted) result.value = data
  } catch (cause) { if (!active.signal.aborted) error.value = cause instanceof Error ? cause.message : '無法載入所選時次' }
  finally { if (!active.signal.aborted) loading.value = false }
}
function downloadCsv() {
  if (!result.value || !visiblePoints.value.length) return
  const url = URL.createObjectURL(new Blob([basinCsv(visiblePoints.value)], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a'); anchor.href = url
  anchor.download = `WNC2-${regionId.value}-${result.value.run.date}-${result.value.run.cycle}-0-312h.csv`
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
watch([model, runChoice], refresh)
onMounted(() => { timer = setInterval(() => { if (model.value === 'wn2' && runChoice.value === 'latest' && document.visibilityState !== 'hidden' && !loading.value) refresh() }, REFRESH_MS) })
onBeforeUnmount(() => { controller?.abort(); clearInterval(timer) })
</script>

<template>
  <section class="basin-viewer" :data-theme="theme" aria-label="洋區系集預報">
    <div class="basin-top"><a href="#weather-tools">← Weather Tools</a><h1 tabindex="-1">洋區系集預報</h1><span>氣旋路徑 · 洋區潛勢</span></div>
    <div class="basin-layout">
      <aside class="basin-sidebar basin-panel" aria-label="台風預報模式選單">
        <h2>台風預報</h2>
        <details v-for="section in sections" :key="section" class="basin-section"><summary>{{ section }}</summary><p>此分類產品尚未接入。請使用下方的洋區潛勢預報。</p></details>
        <details open class="basin-section basin-model-list"><summary>洋區潛勢預報</summary><button v-for="item in models" :key="item.id" :class="{ active: model === item.id }" :aria-pressed="model === item.id" @click="chooseModel(item.id)">{{ item.label }}<small>{{ item.status }}</small></button></details>
        <details class="basin-section"><summary>台風潛勢預報</summary><p>系集路徑並非官方發展機率，請以官方警報為準。</p><a href="#models-title">本站 WNC2 / WM-6 系集 →</a></details>
      </aside>

      <div class="basin-chart-panel basin-panel">
        <template v-if="model === 'wn3'">
          <figure v-if="regionId === 'china'" class="basin-reference"><img src="/images/weather-tools/wn3-basin-reference.webp" alt="WN3C 2026年10月16日06Z中國近海系集預報參考截圖，非即時資料" width="871" height="703" /><figcaption>WN3C 參考截圖 · 2026-10-16 06Z · 非即時資料，圖片內容不隨主題重新著色。</figcaption></figure>
          <div v-else class="basin-empty"><h2>此洋區尚無 WN3C 參考圖</h2><p>不會把中國近海的圖片當作 {{ region.label }} 預報。</p><button @click="chooseModel('wn2')">使用 WNC2 洋區資料</button></div>
          <p class="basin-data-note">WN3C 尚未接入資料源；參考圖內的 0–360h、氣壓與成員數僅屬原圖，不是本站即時結果。切換 WN2C 可查看實際資料與下載 CSV。</p>
        </template>
        <template v-else-if="model === 'wn2'">
          <p v-if="loading" class="basin-status" role="status">正在載入 WNC2 所選時次…</p>
          <div v-else-if="error" class="basin-error" role="alert"><h2>無法載入此時次</h2><p>{{ error }}</p><button @click="refresh">重試</button></div>
          <template v-else-if="result">
            <BasinPlot :catalog="result.catalog" :region="region" :theme="theme" />
            <p class="basin-status" :class="{ 'basin-snapshot': result.source === 'snapshot' }">{{ result.source === 'remote' ? '已連接 WeatherNext CSV' : '離線快照 · 未確認為最新資料' }} · {{ currentTime }} · {{ visiblePoints.length }} 個洋區預報點 · 0–312h</p>
            <p v-if="result.warning" class="basin-data-note">{{ result.warning }}</p>
            <a class="basin-source" :href="sourceUrl(result.run)" target="_blank" rel="noopener noreferrer">原始 CSV 資料來源 ↗</a>
          </template>
        </template>
        <div v-else class="basin-empty"><h2>{{ selectedModel.label }} 尚未接入</h2><p>目前沒有此模式的洋區資料，不會以其他模式或舊圖片代替。</p><button @click="chooseModel('wn2')">查看 WNC2 洋區預報</button></div>
      </div>

      <aside class="basin-controls basin-panel" aria-label="洋區預報控制台">
        <h2>控制台</h2>
        <button class="basin-csv" :disabled="model !== 'wn2' || loading || !visiblePoints.length" @click="downloadCsv">下載目前洋區CSV文件</button>
        <p v-if="model !== 'wn2'" class="basin-help">CSV 僅適用於已載入的 WN2C 資料。</p>
        <label class="basin-run">起報時間<select v-model="runChoice" :disabled="model !== 'wn2'" aria-label="洋區起報時間"><template v-if="model === 'wn3'"><option value="reference">2026年10月16日06時 · 參考圖</option></template><template v-else><option value="latest">最新已發布時次 (UTC)</option><option v-for="run in availableRuns" :key="run.value" :value="run.value">{{ run.label }}</option></template></select></label>
        <fieldset><legend>主題選擇</legend><div class="basin-buttons"><button v-for="item in ([['light', '淺色'], ['color', '彩色'], ['dark', '深色']] as const)" :key="item[0]" :class="{ selected: theme === item[0] }" :aria-pressed="theme === item[0]" @click="theme = item[0]">{{ item[1] }}</button></div></fieldset>
        <fieldset><legend>洋區選擇</legend><div class="basin-buttons"><button v-for="item in basinRegions" :key="item.id" :class="{ selected: regionId === item.id }" :aria-pressed="regionId === item.id" @click="regionId = item.id">{{ item.label }}</button></div></fieldset>
        <div class="basin-current"><h3>當前選擇</h3><p>類型: {{ selectedModel.label }}</p><p>起報: {{ currentTime }}</p><p>洋區: {{ region.label }}</p><p v-if="result">來源: {{ result.source === 'remote' ? '線上 CSV' : '離線快照' }}</p></div>
        <button class="basin-info" :aria-expanded="showInfo" aria-controls="basin-explanation" @click="showInfo = !showInfo">ⓘ <span>資料說明</span></button>
        <p v-if="showInfo" id="basin-explanation" class="basin-help">WNC2 每 5 分鐘檢查最新時次。預報限制為 0–312h；圓點依 MSLP 著色，並非風速強度分類。各氣旋、各成員路徑獨立，未合併數字 genesis ID。CSV 為目前洋區內的預報點。預報僅供參考，請留意官方警報。</p>
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
@media (max-width: 700px) { .basin-layout { grid-template-columns: minmax(0, 1fr); gap: 14px; }.basin-sidebar, .basin-controls { grid-column: 1; grid-row: auto; }.basin-sidebar { order: 0; }.basin-chart-panel { order: 1; padding: 10px; min-height: 260px; }.basin-controls { order: 2; }.basin-panel { padding: 16px; }.basin-top { flex-wrap: wrap; gap: 10px; }.basin-top span { display: none; }.basin-sidebar > .basin-section:not(.basin-model-list) { display: none; }.basin-model-list { margin-bottom: 0; }.basin-model-list button { padding: 10px 14px; }.basin-buttons { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
