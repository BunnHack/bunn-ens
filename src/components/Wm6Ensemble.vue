<script setup lang="ts">
import { ref, computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { loadWm6, loadWm6Cyclone, type Basin, type Wm6Cyclone, type Wm6CycloneDetail, type Wm6Response } from '../data/wm6'
import { chartPng, serializeChart } from '../data/chart-image'
import { windCategory } from '../data/wnc2'
import Wm6Plot from './Wm6Plot.vue'
import { clearRequestCache } from '../data/request-cache'
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })

const BASINS: Basin[] = ['AL', 'EP', 'CP', 'WP', 'NI', 'SI', 'AU', 'SP']
const loading = ref(false)
const detailLoading = ref(false)
const error = ref('')
const detailError = ref('')
const response = ref<Wm6Response | null>(null)
const detail = ref<Wm6CycloneDetail | null>(null)
const basin = ref<Basin | ''>('')
const includeUnofficial = ref(false)
const selectedId = ref('')
const root = ref<HTMLElement | null>(null)
const enlarged = ref(false)
const pngPreview = ref('')
const exporting = ref(false)
const exportError = ref('')
let controller: AbortController | undefined
let detailController: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined, lastCheck = 0
const storms = computed(() => response.value ? Object.values(response.value.tropical_cyclones) : [])
const selectedSummary = computed(() => storms.value.find(storm => storm.tropical_cyclone_id === selectedId.value))
const selected = computed<Wm6Cyclone | null>(() => detail.value ? { ...detail.value, path: detail.value.mean_path } : selectedSummary.value ?? null)
const memberCount = computed(() => detail.value?.members_path?.length ?? 0)
const peakWind = computed(() => {
  const winds = detail.value?.members_path?.flatMap(member => member.path.map(point => point.max_wind_kt)) ?? [selected.value?.max_wind_kt]
  const valid = winds.filter((wind): wind is number => wind != null && Number.isFinite(wind) && wind >= 0)
  return valid.length ? Math.max(...valid) : null
})
const maxWind = computed(() => peakWind.value == null ? '—' : `${peakWind.value.toFixed(1)} kt · ${windCategory(peakWind.value)?.label ?? 'Wind unavailable'}`)
const geojsonUrl = computed(() => {
  const query = new URLSearchParams({ initialization_time: response.value?.initialization_time ?? 'latest', include_details: 'true', include_unofficial_ids: String(includeUnofficial.value), format: 'geojson' })
  if (basin.value) query.set('basin', basin.value)
  return `/api/wm6?${query}`
})
function cancelDetail() {
  detailController?.abort()
  detail.value = null
  pngPreview.value = ''
  exportError.value = ''
  detailLoading.value = false
  detailError.value = ''
}
async function selectCyclone() {
  cancelDetail()
  const id = selectedId.value
  const run = response.value?.initialization_time
  if (!id || !run) return
  const active = new AbortController()
  detailController = active
  detailLoading.value = true
  try {
    const result = await loadWm6Cyclone(id, { initialization_time: run, include_members: true, include_cones: false }, active.signal)
    if (!active.signal.aborted && selectedId.value === id && response.value?.initialization_time === run) detail.value = result
  } catch (cause) {
    if (!active.signal.aborted) detailError.value = cause instanceof Error ? cause.message : 'Unable to load cyclone members'
  } finally { if (!active.signal.aborted) detailLoading.value = false }
}
async function refresh(clear = false) {
  if (!props.active) return
  lastCheck = Date.now()
  controller?.abort()
  cancelDetail()
  const active = new AbortController()
  controller = active
  loading.value = true
  error.value = ''
  if (clear) response.value = null
  try {
    const next = await loadWm6({ initialization_time: 'latest', basin: basin.value || undefined, include_details: true, include_unofficial_ids: includeUnofficial.value, format: 'json' }, active.signal) as Wm6Response
    if (active.signal.aborted) return
    response.value = next
    const available = Object.values(next.tropical_cyclones)
    if (!available.some(storm => storm.tropical_cyclone_id === selectedId.value)) {
      selectedId.value = available.find(storm => storm.basins.includes('WP') && storm.path?.length)?.tropical_cyclone_id
        ?? available.find(storm => storm.path?.length)?.tropical_cyclone_id ?? available[0]?.tropical_cyclone_id ?? ''
    }
    await selectCyclone()
  } catch (cause) { if (!active.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Unable to load WM-6 data' }
  finally { if (!active.signal.aborted) loading.value = false }
}
async function downloadGeoJson() {
  try {
    const result = await fetch(geojsonUrl.value)
    if (!result.ok) throw new Error(`WM-6 GeoJSON returned HTTP ${result.status}`)
    const blob = new Blob([await result.text()], { type: 'application/geo+json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = `wm-6-${response.value?.initialization_time ?? 'latest'}.geojson`; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Unable to download GeoJSON' }
}
function saveFile(content: string, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function chartSvg() {
  const svg = root.value?.querySelector('svg')
  if (!(svg instanceof SVGSVGElement)) throw new Error('WM-6 chart is not ready')
  return serializeChart(svg)
}
function downloadChartSvg() {
  try { saveFile(chartSvg(), 'image/svg+xml;charset=utf-8', `wm-6-${selectedId.value || 'chart'}.svg`) } catch (cause) { exportError.value = cause instanceof Error ? cause.message : 'Unable to save WM-6 SVG' }
}
async function downloadChartPng() {
  if (exporting.value) return
  exporting.value = true; exportError.value = ''
  try {
    const id = selectedId.value, run = detail.value?.initialization_time
    const png = await chartPng(chartSvg())
    if (selectedId.value === id && detail.value?.initialization_time === run) { enlarged.value = false; pngPreview.value = png }
    const anchor = document.createElement('a'); anchor.href = png; anchor.download = `wm-6-${id || 'chart'}.png`; anchor.click()
  } catch (cause) { exportError.value = cause instanceof Error ? cause.message : 'Unable to save WM-6 PNG' }
  finally { exporting.value = false }
}
function reload() { clearRequestCache(fetch, '/api/wm6'); refresh() }
function onVisibility() { if (props.active && document.visibilityState === 'visible' && !loading.value && !detailLoading.value) refresh() }
onMounted(() => {
  refresh()
  timer = setInterval(() => { if (props.active && document.visibilityState !== 'hidden' && !loading.value && !detailLoading.value) refresh() }, 5 * 60_000)
  document.addEventListener('visibilitychange', onVisibility)
})
watch(() => props.active, active => {
  if (active) { if (!response.value || (!!selectedId.value && !detail.value) || Date.now() - lastCheck >= 300000) refresh() }
  else { if (loading.value || detailLoading.value) lastCheck = 0; controller?.abort(); detailController?.abort(); loading.value = false; detailLoading.value = false; enlarged.value = false }
})
onBeforeUnmount(() => { controller?.abort(); detailController?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility) })
</script>

<template>
  <div ref="root" class="wm6-ensemble">
    <div class="wm6-controls">
      <label>Basin<select v-model="basin" aria-label="WM-6 basin" @change="refresh(true)"><option value="">All basins</option><option v-for="item in BASINS" :key="item" :value="item">{{ item }}</option></select></label>
      <button class="text-button" :disabled="loading" @click="reload">Refresh latest</button>
      <label class="wm6-check"><input v-model="includeUnofficial" type="checkbox" @change="refresh(true)" /> Unofficial tracks</label>
    </div>
    <p v-if="loading" class="wm6-loading" role="status">Loading WM-6 latest run and member paths…</p>
    <div v-if="error" class="wm6-error" role="alert">{{ error }}{{ response ? ' Previous list retained; not a fresh update.' : '' }} <button @click="reload">Retry</button></div>
    <template v-if="response">
      <p class="wm6-meta">Forecast base {{ response.forecast_zero || 'unavailable' }} · provider run {{ response.initialization_time }} · {{ response.total }} cyclones · checks every 5 minutes while this panel is active</p>
      <p v-if="!storms.length" class="wm6-meta">No cyclones in this run / basin.</p>
      <label v-else class="wm6-storm-field">Cyclone<select v-model="selectedId" aria-label="WM-6 cyclone" @change="selectCyclone"><option v-for="storm in storms" :key="storm.tropical_cyclone_id" :value="storm.tropical_cyclone_id">{{ storm.tropical_cyclone_id }}{{ storm.storm_name ? ` · ${storm.storm_name}` : '' }}</option></select></label>
      <p v-if="detailLoading" class="wm6-loading" role="status">Loading individual ensemble member tracks…</p>
      <div v-if="detailError" class="wm6-error" role="alert">{{ detailError }} · Member tracks unavailable; summary only. <button @click="selectCyclone">Retry members</button></div>
      <div v-if="selected" class="wm6-summary">
        <div><strong>{{ selected.tropical_cyclone_id }}</strong><span>{{ selected.storm_name ?? 'Unnamed system' }}</span></div>
        <dl><div><dt>Peak wind</dt><dd>{{ maxWind }}</dd></div><div><dt>Basins</dt><dd>{{ selected.basins.join(', ') }}</dd></div></dl>
        <div v-if="detail" class="wm6-details"><span>Member tracks: {{ memberCount }} / {{ detail.ens_size ?? '—' }} ensemble size</span><span>Mean: {{ detail.mean_path.length }} points</span></div>
        <Wm6Plot v-if="detail" :cyclone="selected" :initialization-time="detail.initialization_time" :forecast-zero="detail.forecast_zero" />
        <button v-if="detail" class="text-button" @click="enlarged = true">Enlarge member chart</button>
      </div>
      <div class="wm6-actions"><button class="text-button" :disabled="exporting" @click="downloadChartPng">{{ exporting ? 'Rendering PNG…' : 'Save chart PNG' }}</button><button class="text-button" @click="downloadChartSvg">Save chart SVG</button><button class="text-button" @click="downloadGeoJson">Download GeoJSON</button><a class="text-button" :href="geojsonUrl" target="_blank" rel="noopener noreferrer">Open map data ↗</a></div>
    </template>
    <p v-if="exportError" class="wm6-error" role="alert">{{ exportError }}</p>
    <div v-if="enlarged && detail && selected" class="dialog-backdrop" @click.self="enlarged = false" @keydown.esc="enlarged = false">
      <dialog open class="dialog wm6-dialog" aria-modal="true" aria-labelledby="wm6-dialog-title">
        <div class="dialog-heading"><h2 id="wm6-dialog-title">WM-6 · {{ selected.tropical_cyclone_id }} · {{ memberCount }} members</h2><button class="icon-button" aria-label="Close WM-6 chart" @click="enlarged = false">×</button></div>
        <Wm6Plot :cyclone="selected" :initialization-time="detail.initialization_time" :forecast-zero="detail.forecast_zero" />
        <div class="wm6-image-actions"><button class="text-button" :disabled="exporting" @click="downloadChartPng">{{ exporting ? 'Rendering PNG…' : 'Save chart PNG' }}</button><button class="text-button" @click="downloadChartSvg">Save chart SVG</button></div>
        <p class="dialog-copy">WNC2 wind categories, individual member paths and provider mean. Landfall points and cones are hidden. AI forecast guidance, not an official warning.</p>
      </dialog>
    </div>
    <div v-if="pngPreview" class="dialog-backdrop" @click.self="pngPreview = ''" @keydown.esc="pngPreview = ''">
      <dialog open class="dialog wm6-dialog" aria-modal="true" aria-label="WM-6 PNG image">
        <div class="dialog-heading"><h2>WM-6 PNG image</h2><button class="icon-button" aria-label="Close PNG image" @click="pngPreview = ''">×</button></div>
        <p class="dialog-copy">PNG download started. On mobile, long-press the image below to save it if the download did not start.</p>
        <a class="text-button" :href="pngPreview" :download="`wm-6-${selectedId}.png`">Download PNG again</a>
        <img class="wm6-png-preview" :src="pngPreview" alt="WM-6 intensity-colored ensemble forecast PNG" />
      </dialog>
    </div>
  </div>
</template>

<style scoped>
.wm6-ensemble { padding: 0 9px 8px; color: #637999; font-size: 9px; }
.wm6-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; align-items: end; }
.wm6-controls label, .wm6-storm-field { display: block; font-size: 9px; }
.wm6-controls select, .wm6-storm-field select { display: block; width: 100%; box-sizing: border-box; margin-top: 3px; font-size: 10px; border: 1px solid #ced7e6; border-radius: 5px; background: white; color: #4e6387; padding: 5px 4px; }
.wm6-check { display: flex !important; align-items: center; gap: 4px; }
.wm6-check input { accent-color: #3658a3; }
.wm6-loading { margin: 8px 0; padding: 7px; background: #f3f6fc; }
.wm6-error { padding: 8px; color: #9c625d; background: #fff4ee; }
.wm6-error button { margin-left: 4px; color: #3658a3; }
.wm6-meta, .wm6-source { font-size: 8px; line-height: 1.5; color: #8b99ad; }
.wm6-storm-field { margin-top: 7px; }
.wm6-summary { margin-top: 7px; padding: 8px; border: 1px solid #e0e7f1; border-radius: 5px; background: #f8fafd; }
.wm6-summary > div:first-child { display: flex; justify-content: space-between; gap: 8px; color: #3658a3; }
.wm6-summary dl { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin: 7px 0; }
.wm6-summary dt { color: #8b99ad; font-size: 8px; }.wm6-summary dd { margin: 1px 0 0; color: #526889; font-size: 9px; }
.wm6-details { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 6px; border-top: 1px solid #e0e7f1; color: #267c65; }
.wm6-actions, .wm6-image-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; margin-top: 6px; }.wm6-actions .text-button { font-size: 9px; color: #3658a3; }
.wm6-png-preview { display: block; width: 100%; height: auto; margin-top: 10px; }
.wm6-dialog { width: 1400px; }
</style>
