<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { availableForecastFrames, forecastAssetUrl, forecastDownloadBlob, forecastProducts, forecastRegions, forecastUtc, FORECAST_WORKFLOW, loadForecastManifest, type ForecastManifest, type ForecastProduct, type ForecastRegion } from '../data/forecast-models'
import { loadWm6Availability, type Wm6Availability } from '../data/wm6-availability'
import { publicationStatus } from '../data/forecast-status'
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const availability = ref<Wm6Availability | null>(null), availabilityError = ref('')
const manifest = ref<ForecastManifest | null>(null), runId = ref(''), product = ref<ForecastProduct>('precip'), region = ref<ForecastRegion>('east-asia'), hour = ref(12)
const loading = ref(false), error = ref(''), notice = ref(''), imageLoading = ref(true), imageError = ref(''), playing = ref(false), zoom = ref(1), enlarged = ref(false), saving = ref(false)
const panel = ref<HTMLElement | null>(null), viewport = ref<HTMLElement | null>(null)
let controller: AbortController | undefined, refreshTimer: ReturnType<typeof setInterval>, playTimer: ReturnType<typeof setInterval>, previousOverflow = '', previousFocus: HTMLElement | null = null
let drag: { x: number; y: number; left: number; top: number } | null = null
const run = computed(() => manifest.value?.runs.find(item => item.id === runId.value))
const frames = computed(() => availableForecastFrames(run.value, region.value, product.value))
const frame = computed(() => frames.value.find(item => item.hour === hour.value))
const files = computed(() => frame.value?.files[region.value]?.[product.value])
function publishedAsset(path: string) { return `${forecastAssetUrl(path)}?publication=${encodeURIComponent(run.value?.generatedAt ?? '')}` }
const imageUrl = computed(() => files.value ? publishedAsset(files.value.png) : '')
const selectedProduct = computed(() => forecastProducts.find(item => item.id === product.value)!)
const selectedRegion = computed(() => forecastRegions.find(item => item.id === region.value)!)
const hours = Array.from({ length: 53 }, (_, i) => i * 6)
const frameIndex = computed(() => frames.value.findIndex(item => item.hour === hour.value))
const runIndex = computed(() => manifest.value?.runs.findIndex(item => item.id === runId.value) ?? -1)
const stale = computed(() => run.value && Date.now() - Date.parse(run.value.generatedAt) > 12 * 3600000)
const forecastGif = computed(() => run.value?.animations[region.value]?.[product.value])
const trendGif = computed(() => run.value?.trends[region.value]?.[product.value]?.[String(hour.value)])
const localValidTime = computed(() => frame.value ? new Date(frame.value.validTime).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }) : '—')
async function refresh() {
  if (loading.value) return
  loading.value = true; error.value = ''; availabilityError.value = ''; controller?.abort(); controller = new AbortController()
  const available = loadWm6Availability(controller.signal).then(value => { availability.value = value }).catch(() => { if (!controller?.signal.aborted) availabilityError.value = '無法確認上游最新可用版本；已產圖版本不等於最新模式。' })
  try {
    const result = await loadForecastManifest(controller.signal)
    const previous = runId.value
    manifest.value = result
    if (!result.runs.some(item => item.id === previous)) {
      runId.value = result.runs[0]!.id
      if (previous) notice.value = '先前初始化已不在發布清單，已切換至最新發布圖資。'
    }
  } catch (cause) { if (!controller?.signal.aborted) error.value = cause instanceof Error ? cause.message : '無法讀取圖資。' }
  finally { await available; loading.value = false }
}
watch([run, region, product], () => {
  playing.value = false
  if (frames.value.length && !frames.value.some(item => item.hour === hour.value)) hour.value = frames.value.reduce((best, item) => Math.abs(item.hour - hour.value) < Math.abs(best - hour.value) ? item.hour : best, frames.value[0]!.hour)
})
watch(imageUrl, () => { imageLoading.value = !!imageUrl.value; imageError.value = ''; zoom.value = 1; if (viewport.value) { viewport.value.scrollLeft = 0; viewport.value.scrollTop = 0 } })
watch(() => props.active, active => { if (!active) { playing.value = false; if (enlarged.value) toggleEnlarged() } })
function step(direction: number, loop = false) {
  const length = frames.value.length
  if (!length) return
  const next = frameIndex.value + direction
  hour.value = frames.value[loop ? (next + length) % length : Math.max(0, Math.min(length - 1, next))]!.hour
}
function imageState(event: Event, failed = false) {
  if ((event.target as HTMLImageElement).getAttribute('src') !== imageUrl.value) return
  imageLoading.value = false
  if (failed) { imageError.value = '此張已發布圖片暫時無法載入，未以其他初始化或產品替代。'; playing.value = false }
}
async function toggleEnlarged() {
  if (!enlarged.value) { previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; enlarged.value = true; await nextTick(); panel.value?.focus() }
  else { enlarged.value = false; document.body.style.overflow = previousOverflow; previousFocus?.focus() }
}
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape' && enlarged.value) { event.stopPropagation(); toggleEnlarged(); return }
  if (enlarged.value && event.key === 'Tab') {
    const nodes = [...panel.value!.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]')]
    const first = nodes[0], last = nodes[nodes.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.value)) { event.preventDefault(); first?.focus() }
  }
  if ((event.target as HTMLElement).closest('input,select,button,a,textarea')) return
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); step(event.key === 'ArrowLeft' ? -1 : 1) }
  if (event.key === ' ' && frames.value.length > 1) { event.preventDefault(); playing.value = !playing.value }
}
function startDrag(event: PointerEvent) {
  if (zoom.value <= 1 || event.pointerType === 'touch' || !viewport.value) return
  drag = { x: event.clientX, y: event.clientY, left: viewport.value.scrollLeft, top: viewport.value.scrollTop }
  viewport.value.setPointerCapture?.(event.pointerId); event.preventDefault()
}
function moveDrag(event: PointerEvent) { if (drag && viewport.value) { viewport.value.scrollLeft = drag.left + drag.x - event.clientX; viewport.value.scrollTop = drag.top + drag.y - event.clientY } }
async function download(path: string | undefined) {
  if (!path || saving.value) return
  saving.value = true; notice.value = ''
  const filename = `WM6-${runId.value}-${region.value}-${product.value}-${path.split('/').pop()}`.replace(/\.svgz$/, '.svg')
  try {
    const response = await fetch(publishedAsset(path), { credentials: 'omit', cache: 'no-cache' })
    if (!response.ok) throw new Error(`下載失敗（HTTP ${response.status}），可開啟原圖後儲存。`)
    const blob = await forecastDownloadBlob(response, path), url = URL.createObjectURL(blob), a = document.createElement('a')
    a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (cause) { notice.value = cause instanceof Error ? cause.message : '下載失敗，可開啟原圖儲存。' }
  finally { saving.value = false }
}
onMounted(() => {
  refresh()
  refreshTimer = setInterval(() => { if (props.active && document.visibilityState === 'visible') refresh() }, 300000)
  playTimer = setInterval(() => { if (props.active && playing.value && document.visibilityState === 'visible' && !imageLoading.value && !imageError.value) step(1, true) }, 900)
})
onBeforeUnmount(() => { controller?.abort(); clearInterval(refreshTimer); clearInterval(playTimer); if (enlarged.value) document.body.style.overflow = previousOverflow })
</script>

<template>
  <main id="forecast-models" class="fm-page" @keydown="keyboard">
    <header class="fm-heading"><div><h1 tabindex="-1">WM-6</h1><p>WindBorne WeatherMesh-6 · 0.25° · 128-member ensemble mean</p></div><div class="fm-tabs" aria-label="Model categories"><button class="active" aria-pressed="true">Global</button><button v-for="tab in ['Ensemble', 'Hurricane', 'Mesoscale', 'Climate']" :key="tab" disabled title="目前僅接入 WM-6 全球系集平均格點圖">{{ tab }}</button></div></header>
    <p class="fm-source-note">目前僅支援 WM-6。<a :href="FORECAST_WORKFLOW" target="_blank" rel="noopener noreferrer">GitHub Actions</a> 每小時排程預先產圖（排程可能延遲），預報圖片只讀公開清單／靜態 PNG，不會每次進頁都向 WindBorne 下載格點或重新產圖。同頁導覽保留圖集狀態；顯示此頁時每 5 分鐘檢查清單與上游可用版本，圖片由瀏覽器／CDN 快取。產圖發布、供應商版本與預報基準是三個不同時間。</p>
    <div class="fm-layout">
      <aside class="fm-products" aria-label="Weather products"><button v-for="item in forecastProducts" :key="item.id" :class="{ selected: product === item.id }" :aria-pressed="product === item.id" @click="product = item.id"><strong>{{ item.group }}</strong><span>{{ item.label }}</span></button><label>REGIONS<select v-model="region" aria-label="Forecast region"><option v-for="item in forecastRegions" :key="item.id" :value="item.id">{{ item.label }}</option></select></label><a href="#main-content">← Current Storms</a></aside>
      <section class="fm-workspace" aria-label="WM-6 gridded forecast">
        <div class="fm-player"><input :value="Math.max(0, frameIndex)" type="range" min="0" :max="Math.max(0, frames.length - 1)" step="1" :disabled="frames.length < 2" aria-label="Forecast frame" @input="hour = frames[Number(($event.target as HTMLInputElement).value)]!.hour" /><button aria-label="Previous forecast frame" :disabled="frameIndex <= 0" @click="step(-1)">←</button><button class="fm-play" :aria-label="playing ? 'Pause forecast animation' : 'Play forecast animation'" :aria-pressed="playing" :disabled="frames.length < 2 || !!imageError" @click="playing = !playing">{{ playing ? '❚❚' : '▶' }}</button><button aria-label="Next forecast frame" :disabled="frameIndex < 0 || frameIndex >= frames.length - 1" @click="step(1)">→</button></div>
        <p v-if="loading" class="fm-message" role="status">更新圖資索引…</p><p v-if="error" class="fm-message fm-error" role="alert">{{ error }}{{ manifest ? ' 保留先前已發布圖資；未宣稱為最新預報。' : ' 請稍後重新整理，或查看 Actions 狀態。' }}</p><p v-if="notice" class="fm-message" role="status">{{ notice }}</p>
        <template v-if="run"><p class="fm-chart-caption">WM-6 {{ selectedProduct.label }} · {{ selectedRegion.label }} · +{{ hour }}h</p><p class="fm-time-anchor"><strong>預報基準 · Forecast zero: {{ forecastUtc(run.forecastZero) }}</strong><br />已產圖供應商版本 · Provider run: {{ forecastUtc(run.initializationTime) }}<br />Valid: {{ frame ? forecastUtc(frame.validTime) : '無已發布圖片' }}</p><p class="fm-availability fm-message" role="status"><template v-if="availability && !availabilityError">上游最新可用版本：{{ forecastUtc(availability.initializationTime) }} · 基準 {{ forecastUtc(availability.forecastZero) }}{{ availability.inProgress ? '（仍生成中）' : '' }}。{{ publicationStatus(run, availability) }} 核對：{{ forecastUtc(availability.checkedAt) }}。</template><template v-else>{{ availabilityError || '核對上游最新版本中；已產圖不等於最新可用。' }}</template></p><details class="fm-message fm-time-explanation"><summary>為何有 03Z／08Z？圖內 Init 是什麼？</summary><p>舊圖的 Init 是 API initialization_time，這裡稱「供應商版本」，不是目前時間，不代表 00/06/12/18Z 的預報基準，也不能據此宣稱最新。供應商可在同一 forecast_zero 下提供多個小時版本；initialization_times 列出可用版本，不代表本站都已產圖。預報有效時間 = forecast_zero + forecast_hour，不從版本時間或手機時間加算；未證實其內部分析／訓練時間。</p><p>已產圖供應商版本：{{ forecastUtc(run.initializationTime) }}<br />預報時效基準：{{ forecastUtc(run.forecastZero) }}<br />圖資發布（不是起報）：{{ forecastUtc(run.generatedAt) }}</p></details><p class="fm-message fm-centers-note">{{ run.mslpCenters ? '紅色 L／藍色 H 是平均海平面氣壓場的局部低／高壓中心，數字為四捨五入的 hPa；不等於個別颱風中心或強度。只標在含 MSLP 的降水／風速圖。' : '此版本仍是未標 H/L 的舊版圖片；新版產圖完成後會加入實際氣壓中心。' }} 地名點使用英文簡寫（如 TPE、TXG），不是氣象站代碼。</p></template>
        <div ref="panel" class="fm-display" :class="{ 'fm-display-enlarged': enlarged }" :role="enlarged ? 'dialog' : 'region'" :aria-modal="enlarged ? true : undefined" aria-label="WM-6 forecast chart" tabindex="-1">
          <div class="fm-image-controls"><button :disabled="!files" @click="toggleEnlarged">{{ enlarged ? '關閉大圖' : '放大地圖' }}</button><button aria-label="Zoom out forecast map" :disabled="zoom <= 1" @click="zoom = Math.max(1, zoom - .25)">−</button><span>{{ Math.round(zoom * 100) }}%</span><button aria-label="Zoom in forecast map" :disabled="zoom >= 4 || !files" @click="zoom = Math.min(4, zoom + .25)">＋</button><button :disabled="!files || saving" @click="download(files?.svg)">下載 SVG</button><button :disabled="!files || saving" @click="download(files?.png)">下載 PNG</button><a v-if="files" :href="imageUrl" target="_blank" rel="noopener noreferrer">開啟原圖 ↗</a></div>
          <div v-if="imageUrl" ref="viewport" class="fm-image-viewport" :class="{ 'fm-draggable': zoom > 1 }" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="drag = null" @pointercancel="drag = null" @lostpointercapture="drag = null"><img :key="imageUrl" class="fm-chart-image" :src="imageUrl" :style="{ width: `${zoom * 100}%` }" :alt="`WM-6 ${selectedProduct.label} ${selectedRegion.label} ${run?.initializationTime} +${hour}h valid ${frame?.validTime}, ensemble mean`" width="1820" height="1300" draggable="false" @load="imageState($event)" @error="imageState($event, true)" /></div>
          <div v-else class="fm-empty"><h2>{{ loading ? '載入圖資…' : '此產品／時效尚無已發布圖資' }}</h2><p>只列出 Actions 實際產生的圖片，不以其他模型、起報或時效替代。+0h 沒有完整 6 小時降水區間，因此不提供該降水圖。</p><a :href="FORECAST_WORKFLOW" target="_blank" rel="noopener noreferrer">查看產圖工作流程 ↗</a></div>
          <p v-if="imageLoading && imageUrl" class="fm-message" role="status">載入 +{{ hour }}h 圖片…</p><p v-if="imageError" class="fm-message fm-error" role="alert">{{ imageError }}</p><p class="fm-image-help">放大後可拖曳／觸控捲動；左右鍵切換時效，空白鍵播放。手機可開啟原圖長按儲存。</p>
        </div>
        <div class="fm-bottom-controls"><label>REGIONS<select v-model="region" aria-label="Bottom forecast region"><option v-for="item in forecastRegions" :key="item.id" :value="item.id">{{ item.label }}</option></select></label><button :disabled="!manifest || runIndex >= manifest.runs.length - 1" @click="runId = manifest!.runs[runIndex + 1]!.id">Prev. Run ←</button><button :disabled="runIndex <= 0" @click="runId = manifest!.runs[runIndex - 1]!.id">Next Run →</button><button :disabled="!forecastGif || saving" @click="download(forecastGif)">FORECAST GIF</button><button :disabled="!trendGif || saving" title="相同有效時間、不同初始化；需要前次已發布圖片" @click="download(trendGif)">TREND GIF</button></div>
      </section>
      <aside class="fm-times" aria-label="Forecast hours"><label>已產圖供應商版本<select v-model="runId" aria-label="Forecast initialization" :disabled="!manifest"><option v-for="item in manifest?.runs ?? []" :key="item.id" :value="item.id">{{ forecastUtc(item.initializationTime) }}</option></select></label><div class="fm-local-time"><small>FORECAST TIME (LOCAL)</small><strong>(+{{ hour }} hr) {{ localValidTime }}</strong><span v-if="frame">{{ forecastUtc(frame.validTime) }}</span></div><p class="fm-progress">此產品已產圖 {{ frames.length }}/53 時效 · 僅顯示 0–312h</p><div class="fm-hour-legend"><span>Selected</span><span>Published</span><span>Unavailable</span></div><div class="fm-hour-grid"><button v-for="lead in hours" :key="lead" :class="{ selected: hour === lead && !!frame, published: frames.some(item => item.hour === lead) }" :disabled="!frames.some(item => item.hour === lead)" :aria-pressed="hour === lead && !!frame" :aria-label="`Forecast hour ${lead}`" @click="hour = lead; playing = false">{{ String(lead).padStart(3, '0') }}</button></div><button class="fm-refresh" :disabled="loading" @click="refresh">重新整理發布清單</button></aside>
    </div>
    <footer v-if="run" class="fm-disclosure"><p :class="{ 'fm-error': stale }">發布時間：{{ forecastUtc(run.generatedAt) }}{{ stale ? ' · 圖資超過 12 小時，可能已過期。' : '' }} · 當次產圖查得上游 {{ run.upstreamHours.length }} 個 0–312h 格點時效{{ run.upstreamInProgress ? '（此供應商版本在當次查詢時仍生成中）' : '' }}；產圖異常 {{ run.failures.length }} 項。灰色時效不代表上游一定沒有預報，僅代表此產品尚未發布圖片。</p><p>降水圖以兩段相鄰、同一起報的 3 小時累積降水相加 ÷6 得到 mm/h；合併所有降水類型，不假造雨／凍雨／霰／雪分色。氣壓 Pa÷100 得 hPa；位勢除以標準重力及 10 得 dam；溫度 K→°C，原生格點風速 m/s→kt。此轉換不套用到颱風追蹤器原始 max_wind_kt。</p><p>非即時觀測或官方警報。尚未支援 GFS／ECMWF、成員選擇及其他產品。資料來源：<a href="https://api.windbornesystems.com/forecasts/version_1/gridded-forecast/gridded-forecast/" target="_blank" rel="noopener noreferrer">WindBorne WM-6 gridded API</a>；底圖 Natural Earth 1:50m。Trend GIF 僅在有前次初始化、相同有效時間圖資時提供。</p></footer>
  </main>
</template>

<style scoped>
.fm-page { max-width: none; padding: 22px 20px; background: #fff; color: #303d49; min-height: calc(100vh - 76px); }.fm-heading { display: grid; grid-template-columns: 240px minmax(0,1fr); gap: 22px; align-items: center; }.fm-heading h1 { font-size: 29px; color: #244b6c; margin: 0; }.fm-heading p { font-size: 11px; color: #7e8993; margin: 5px 0; }.fm-tabs { display: flex; background: #254a6b; }.fm-tabs button { flex: 1; min-width: 0; padding: 15px 5px; font-size: 20px; color: white; border: 1px solid #17374e; background: #254a6b; font-weight: 600; }.fm-tabs button:disabled { opacity: .45; cursor: not-allowed; }.fm-source-note { font-size: 12px; line-height: 1.7; color: #657d8d; margin: 14px 0; }.fm-source-note a, .fm-disclosure a { color: #2687b3; text-decoration: underline; }.fm-layout { display: grid; grid-template-columns: 220px minmax(0,1fr) 205px; gap: 20px; align-items: start; }.fm-layout > * { min-width: 0; }.fm-products { padding-top: 43px; }.fm-products > button { width: 100%; display: block; text-align: left; border: 1px solid #53718a; padding: 17px 15px; color: white; background: #254a6b; }.fm-products > button.selected { background: #142e43; }.fm-products strong { font-size: 17px; display: block; }.fm-products button span { display: block; font-size: 10px; opacity: .7; margin-top: 5px; }.fm-products label, .fm-times > label { display: block; font-size: 12px; margin: 18px 0 8px; }.fm-products > a { display: inline-block; margin-top: 20px; color: #328db8; font-size: 12px; }.fm-page select { width: 100%; padding: 9px 6px; color: #48525a; border: 1px solid #aaa; background: white; border-radius: 0; min-width: 0; font-size: 12px; }.fm-player { display: flex; gap: 5px; align-items: center; }.fm-player input { flex: 1; min-width: 50px; }.fm-player button { font-size: 23px; width: 44px; padding: 4px; background: #f0f0f0; border: 1px solid #d2d2d2; }.fm-page button:disabled { cursor: not-allowed; }.fm-player button:disabled, .fm-bottom-controls button:disabled, .fm-image-controls button:disabled { opacity: .4; }.fm-chart-caption { font-size: 13px; font-weight: 700; margin: 10px 0 3px; }.fm-time-anchor { font-size: 11px; color: #6e7b87; line-height: 1.6; margin: 0 0 6px; }.fm-display { background: white; min-width: 0; }.fm-image-controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 6px; font-size: 11px; }.fm-image-controls button, .fm-image-controls a { background: #eef4f8; color: #24658e; border: 1px solid #abc7d8; padding: 6px 9px; font-size: 11px; }.fm-image-viewport { overflow: auto; max-height: 82vh; overscroll-behavior: contain; }.fm-chart-image { display: block; min-width: 100%; max-width: none; height: auto; }.fm-draggable { cursor: grab; }.fm-draggable:active { cursor: grabbing; }.fm-image-help { font-size: 10px; color: #85929a; line-height: 1.6; margin: 7px 0; }.fm-display-enlarged { position: fixed; inset: 10px; z-index: 1500; padding: 15px; overflow: auto; box-shadow: 0 0 0 30px #1b2e42b0; }.fm-display-enlarged .fm-image-viewport { max-height: calc(100dvh - 110px); }.fm-bottom-controls { display: flex; gap: 7px; flex-wrap: wrap; justify-content: space-between; align-items: center; margin-top: 12px; }.fm-bottom-controls label { font-size: 10px; }.fm-bottom-controls select { padding: 6px; }.fm-bottom-controls button, .fm-refresh { padding: 9px 12px; border: 1px solid #c1ccd6; background: #2d9ee7; color: white; font-size: 12px; }.fm-bottom-controls button:nth-of-type(-n+2) { background: #f1f1f1; color: #4a5870; }.fm-times > label { margin-top: 0; }.fm-local-time { display: flex; flex-direction: column; gap: 5px; text-align: center; padding: 10px 0; }.fm-local-time small { font-size: 9px; color: #8e969d; }.fm-local-time strong { font-size: 13px; color: #b95247; }.fm-local-time span { font-size: 10px; color: #7a8794; }.fm-progress { font-size: 10px; padding: 6px; color: #9b6a34; background: #fff0c9; margin: 0 0 7px; }.fm-hour-legend { display: flex; justify-content: space-between; font-size: 8px; margin-bottom: 6px; gap: 3px; }.fm-hour-legend span { border: 1px solid #bbb; padding: 3px; }.fm-hour-legend span:first-child { color: #2682b6; background: #e6f6ff; }.fm-hour-legend span:last-child { opacity: .4; }.fm-hour-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 4px; }.fm-hour-grid button { padding: 7px 1px; border: 1px solid #d1d4d6; border-radius: 3px; color: #777; background: #f9f9f9; font-size: 13px; font-weight: 600; }.fm-hour-grid button.selected { background: #d6f0ff; border-color: #399dd7; color: #1777af; }.fm-hour-grid button:disabled { opacity: .28; }.fm-refresh { width: 100%; background: #edf4f8; color: #377599; margin-top: 12px; }.fm-message { font-size: 12px; line-height: 1.7; color: #597786; }.fm-error { color: #b14038; }.fm-empty { padding: 60px 24px; background: #f4f7fa; font-size: 13px; line-height: 1.8; text-align: center; }.fm-empty h2 { font-size: 18px; }.fm-empty a { color: #2388b8; }.fm-disclosure { display: block; margin: 25px 0 0; padding: 18px 0; font-size: 11px; color: #788c9b; line-height: 1.9; }.fm-disclosure p { margin: 0 0 8px; }
@media(min-width:1700px) { .fm-layout { grid-template-columns: 230px minmax(0,1fr) 230px; } }
@media(max-width:1000px) { .fm-layout { grid-template-columns: 160px minmax(0,1fr); gap: 14px; }.fm-times { grid-column: 2; }.fm-hour-grid { grid-template-columns: repeat(9,minmax(0,1fr)); }.fm-heading { grid-template-columns: 160px minmax(0,1fr); gap: 14px; }.fm-tabs button { font-size: 13px; }.fm-products strong { font-size: 13px; } }
@media(max-width:600px) { .fm-page { padding: 16px 12px; }.fm-heading { display: block; }.fm-tabs { margin-top: 14px; }.fm-tabs button { font-size: 10px; padding: 11px 2px; }.fm-layout { display: flex; flex-direction: column; }.fm-layout > * { width: 100%; }.fm-products { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); padding: 0; gap: 4px; }.fm-products > button { padding: 10px; }.fm-products label, .fm-products > a { margin: 4px 0; }.fm-hour-grid { grid-template-columns: repeat(8,minmax(0,1fr)); }.fm-times { order: 2; }.fm-time-anchor { overflow-wrap: anywhere; }.fm-display-enlarged { inset: 3px; padding: 8px; }.fm-disclosure { padding: 10px 0; }.fm-bottom-controls { gap: 5px; }.fm-bottom-controls button { padding: 8px 6px; font-size: 10px; } }
</style>
