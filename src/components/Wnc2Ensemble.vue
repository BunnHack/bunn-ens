<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Wnc2Plot from './Wnc2Plot.vue'
import { analyze96W, ensembleFromPoints, loadEnsemble, sourceUrl, trackOptions, REFRESH_MS, SNAPSHOT_RUN, type Cycle, type DataResult, type Model } from '../data/wnc2'

const result = ref<DataResult | null>(null)
const loading = ref(false)
const error = ref('')
const enlarged = ref(false)
const autoLatest = ref(true)
const model = ref<Model>('FNV3P1')
const manualDate = ref(SNAPSHOT_RUN.date)
const manualCycle = ref<Cycle>('00z')
const selectedTrack = ref('')
const maxLead = ref(312)
let controller: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
const options = computed(() => result.value ? trackOptions(result.value.catalog) : [])
const diagnosis = computed(() => result.value ? analyze96W(result.value.catalog) : null)
const data = computed(() => {
  const option = options.value.find(item => item.key === selectedTrack.value)
  return option ? ensembleFromPoints(option.points, option.key.startsWith('genesis:') ? `Member ${option.points[0]!.sample + 1} / ID ${option.points[0]!.trackId}` : option.key) : null
})
const initialized = computed(() => result.value?.catalog.initTime)
const cycles: Cycle[] = ['00z', '06z', '12z', '18z']
const availableMax = computed(() => data.value ? Math.max(...data.value.members.flatMap(member => member.points.map(point => point.leadHours))) : 0)
async function refresh(clear = false) {
  controller?.abort()
  const active = new AbortController()
  controller = active
  loading.value = true
  if (clear) { result.value = null; enlarged.value = false }
  error.value = ''
  try {
    const next = await loadEnsemble({ model: model.value, cycle: autoLatest.value ? 'latest' : manualCycle.value, date: autoLatest.value ? undefined : manualDate.value }, active.signal)
    if (active.signal.aborted) return
    result.value = next
    manualDate.value = next.run.date
    const choices = trackOptions(next.catalog)
    if (!choices.some(option => option.key === selectedTrack.value)) selectedTrack.value = choices.find(option => /^WP96\d{4}/.test(option.key))?.key ?? choices.find(option => !option.key.startsWith('genesis:'))?.key ?? choices[0]!.key
  } catch (cause) { if (!active.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Unable to load forecast data' }
  finally { if (!active.signal.aborted) loading.value = false }
}
function setCycle(cycle: Cycle) {
  autoLatest.value = false
  manualCycle.value = cycle
  refresh(true)
}
function toggleAuto() { autoLatest.value = !autoLatest.value; refresh(true) }
function onVisibility() { if (document.visibilityState === 'visible' && autoLatest.value && !loading.value) refresh() }
onMounted(() => {
  refresh()
  timer = setInterval(() => { if (autoLatest.value && document.visibilityState !== 'hidden' && !loading.value) refresh() }, REFRESH_MS)
  document.addEventListener('visibilitychange', onVisibility)
})
watch(model, () => refresh(true))
onBeforeUnmount(() => { controller?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisibility) })
</script>

<template>
  <div class="wnc2-ensemble">
    <div class="run-controls">
      <label>Model<select v-model="model" aria-label="WeatherNext model"><option>FNV3P1</option><option>FNV3P2</option></select></label>
      <button class="auto-button" :aria-pressed="autoLatest" @click="toggleAuto">{{ autoLatest ? 'Auto latest · ON' : 'Auto latest · OFF' }}</button>
      <p>00 / 06 / 12 / 18Z · 0–312h (13 days)<br />{{ autoLatest ? 'Checks every 5 minutes while visible' : 'Manual run — no automatic switching' }}</p>
      <label v-if="!autoLatest">Run date<input v-model="manualDate" type="date" aria-label="WNC2 run date" @change="refresh(true)" /></label>
      <div class="cycle-selector" aria-label="WNC2 Ensembles model cycle"><button v-for="cycle in cycles" :key="cycle" :class="{ selected: (autoLatest ? result?.run.cycle : manualCycle) === cycle }" :aria-pressed="(autoLatest ? result?.run.cycle : manualCycle) === cycle" @click="setCycle(cycle)">{{ cycle }}</button></div>
    </div>
    <p v-if="loading" class="loading-note" role="status">{{ result ? 'Checking for a newer published run…' : 'Discovering published WeatherNext CSV…' }}</p>
    <div v-if="error" class="wnc2-state error" role="alert"><p>{{ error }}{{ result ? ' Retaining the previous successful run; it is not a fresh update.' : '' }}</p><button @click="refresh()">Retry</button></div>
    <template v-if="result">
      <p class="system-disclaimer">Initialized {{ initialized }} UTC · {{ result.run.model }}<br />Selected track is independent of the static 96W screenshot data.</p>
      <label class="track-field">System / sample-specific genesis track<select v-model="selectedTrack" aria-label="WNC2 system"><option v-for="option in options" :key="option.key" :value="option.key">{{ option.label }}</option></select></label>
      <label class="lead-field">Forecast window: 0–{{ maxLead }}h <input v-model.number="maxLead" type="range" min="0" max="312" step="6" aria-label="Maximum forecast lead hours" /></label>
      <p class="lead-caption">Selected track available through +{{ availableMax }}h. No positions are invented beyond its lifetime.</p>
      <Wnc2Plot v-if="data" :key="`${initialized}-${selectedTrack}`" :data="data" :max-lead="maxLead" />
      <div class="wnc2-controls"><button class="text-button" @click="enlarged = true" :disabled="!data"><span class="material-icons-round" aria-hidden="true">zoom_in</span>Enlarge chart</button><button class="text-button" @click="refresh()" :disabled="loading" aria-label="Reload WNC2 CSV"><span class="material-icons-round" aria-hidden="true">refresh</span></button></div>
      <p class="data-status" :class="result.source">{{ result.source === 'remote' ? 'WeatherNext CSV connected' : 'Offline CSV snapshot — not confirmed latest' }} · {{ result.catalog.totalSamples }} ensemble samples</p>
      <p class="checked-at">Checked {{ result.checkedAt.replace('T', ' ').slice(0,19) }} UTC</p>
      <p v-if="result.warning" class="data-warning">{{ result.warning }}</p>
      <a class="csv-source" :href="sourceUrl(result.run)" target="_blank" rel="noopener noreferrer">Google DeepMind · Actual run CSV ↗</a>
      <details v-if="diagnosis" class="diagnostic">
        <summary>96W track-ID / lead-time check</summary>
        <p>{{ diagnosis.officialId }}: {{ diagnosis.total }} initial members; {{ diagnosis.continuing }} continue beyond +24h. {{ diagnosis.reidentified.length }} early-ending members have a nearby, non-overlapping numeric track starting by +24h.</p>
        <p>Likely tracking re-identification, NOT proof of cyclone splitting. Candidates are heuristic: same sample, gap ≤24h, distance ≤500 km. IDs remain separate and are never silently merged into the mean.</p>
        <div class="diagnostic-table"><table><thead><tr><th>Member</th><th>96W end</th><th>New ID</th><th>Start</th><th>Distance</th></tr></thead><tbody><tr v-for="item in diagnosis.reidentified" :key="item.sample"><td>{{ item.sample + 1 }}</td><td>+{{ item.endLead }}h</td><td><button @click="selectedTrack = `genesis:${item.sample}:${item.id}`">{{ item.id }}</button></td><td>+{{ item.startLead }}h</td><td>{{ Math.round(item.distanceKm) }} km</td></tr></tbody></table></div>
        <p>{{ diagnosis.laterGenesis.length }} additional sample-specific genesis tracks first appear after +168h in 0–25°N / 130–185°E. They are not automatically assigned to 96W.</p>
      </details>
    </template>
    <p class="data-license"><a href="https://storage.googleapis.com/weathernext-public/terms-of-use.pdf" target="_blank" rel="noopener noreferrer">WeatherNext terms</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0 for data ≥1h old</a></p>
    <div v-if="enlarged && result && data" class="dialog-backdrop" @click.self="enlarged = false" @keydown.esc="enlarged = false">
      <dialog open class="dialog wnc2-dialog" aria-modal="true" aria-labelledby="wnc2-dialog-title">
        <div class="dialog-heading"><div><h2 id="wnc2-dialog-title">WNC2 Ensembles · {{ data.trackId }}</h2><p class="dialog-copy">{{ initialized }} UTC · {{ result.run.model }} · 0–{{ maxLead }}h</p></div><button class="icon-button" autofocus aria-label="Close WNC2 chart" @click="enlarged = false"><span class="material-icons-round" aria-hidden="true">close</span></button></div>
        <label class="lead-field">Forecast window: 0–{{ maxLead }}h<input v-model.number="maxLead" type="range" min="0" max="312" step="6" aria-label="Enlarged maximum forecast lead hours" /></label>
        <div class="wnc2-full-chart"><Wnc2Plot :key="`${initialized}-${selectedTrack}`" :data="data" :max-lead="maxLead" /></div>
        <p class="dialog-copy">Select a member label to highlight its track. Segment colors use wind at the starting point. Mean averages available members, with at least 25% coverage; separate genesis IDs are not merged. Coastlines: Natural Earth (public domain), regional coverage. AI forecast, not an official warning.</p>
        <p class="dialog-copy">Source: {{ result.source }}. {{ result.warning }}</p>
      </dialog>
    </div>
  </div>
</template>

<style scoped>
.run-controls { padding: 0 9px 6px; font-size: 10px; color: #71839e; }
.run-controls > label { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 7px; }
select, input[type=date] { min-width: 0; max-width: 100%; font-size: 10px; border: 1px solid #ced7e6; border-radius: 5px; background: white; color: #4e6387; padding: 6px 4px; }
.run-controls p { font-size: 8px; line-height: 1.6; margin: 6px 0 0; }
.auto-button { width: 100%; font-size: 9px; padding: 6px; color: #267c65; background: #e7f4ef; border-radius: 5px; }
.auto-button[aria-pressed=false] { color: #a1783c; background: #fff4df; }
.run-controls .cycle-selector { margin: 0; padding-top: 6px; }
.track-field, .lead-field { display: block; margin: 8px 9px; color: #71839e; font-size: 9px; }
.track-field select { display: block; width: 100%; margin-top: 5px; }
.lead-field input { display: block; width: 100%; accent-color: #3658a3; margin: 5px 0; }
.lead-caption, .checked-at { font-size: 8px; color: #8b99ad; margin: 5px 9px; line-height: 1.5; }
.system-disclaimer { color: #637999; font-size: 9px; line-height: 1.6; margin: 4px 9px 8px; }
.loading-note { font-size: 10px; padding: 10px; color: #637999; background: #f3f6fc; }
.wnc2-state { padding: 12px 9px; font-size: 10px; text-align: center; background: #fff4ee; }
.wnc2-state.error { color: #9c625d; }
.wnc2-state p { line-height: 1.5; margin: 0 0 5px; }
.wnc2-state button { background: #e9eef9; color: #3658a3; padding: 7px 12px; border-radius: 5px; font-size: 10px; }
.wnc2-controls { display: flex; justify-content: space-between; padding: 3px 9px; }
.wnc2-controls .text-button { font-size: 9px; }
.data-status { margin: 4px 9px; color: #267c65; font-size: 9px; line-height: 1.5; }
.data-status.snapshot, .data-warning { color: #a1783c; }
.data-warning { margin: 4px 9px; font-size: 8px; line-height: 1.5; }
.csv-source { display: block; margin: 5px 9px; color: #61799f; font-size: 8px; line-height: 1.5; }
.data-license { margin: 4px 9px 8px; color: #8f9aab; font-size: 7px; line-height: 1.5; }
.data-license a { text-decoration: underline; }
.diagnostic { color: #637999; font-size: 9px; line-height: 1.7; padding: 8px 9px; background: #f6f8fc; margin: 8px; border-radius: 5px; }
.diagnostic summary { cursor: pointer; font-weight: 500; }
.diagnostic-table { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 8px; white-space: nowrap; }
th, td { text-align: left; padding: 4px 3px; border-bottom: 1px solid #dce4f0; }
td button { font-size: 8px; background: #e7edf9; color: #3658a3; border-radius: 3px; }
.wnc2-dialog { width: 1500px; }
.wnc2-full-chart { max-height: 68dvh; overflow: auto; }
.wnc2-full-chart :deep(.wnc2-plot) { min-width: 760px; }
@media (max-width: 600px) { .wnc2-full-chart { max-height: 65dvh; } }
</style>
