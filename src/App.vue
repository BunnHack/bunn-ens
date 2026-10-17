<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import WeatherTools from './components/WeatherTools.vue'
import Wnc2Ensemble from './components/Wnc2Ensemble.vue'
import Wm6Ensemble from './components/Wm6Ensemble.vue'

type Cycle = '00z' | '06z' | '12z' | '18z'
type Forecast = {
  id: string
  title: string
  image?: string
  description: string
  cycle: Cycle
}
type ImagePreview = { title: string; image: string; description: string }

const navigation = [
  { label: 'Current Storms', href: 'https://www.tropicaltidbits.com/storminfo/' },
  { label: 'Weather Tools', href: '#weather-tools' },
  { label: 'Satellite Imagery', href: 'https://www.tropicaltidbits.com/sat/' },
  { label: 'Forecast Models', href: 'https://www.tropicaltidbits.com/analysis/models/' },
  { label: 'Analysis Tools', href: 'https://www.tropicaltidbits.com/analysis/' },
  { label: 'About', href: 'https://www.tropicaltidbits.com/about.html' },
]
const cycles: Cycle[] = ['00z', '06z', '12z', '18z']
const forecasts = ref<Forecast[]>([
  { id: 'global', title: 'Global + Hurricane Models', image: '/images/global-models.png', description: 'Deterministic model track guidance', cycle: '06z' },
  { id: 'wnc2', title: 'WNC2 Ensembles', description: 'WeatherNext 2 Cyclones · FNV3.2', cycle: '06z' },
  { id: 'wm6', title: 'WM-6 Ensemble', image: '/images/eps-ensembles.png', description: 'WindBorne tropical cyclone ensemble tracker', cycle: '06z' },
  { id: 'intensity', title: 'Intensity Guidance', image: '/images/21E-intensity-reference.png', description: '21E TRUDY · 00Z Oct 17, 2026 · supplied reference', cycle: '00z' },
])
const stormDetails = [
  { label: 'Location', value: '9.7°N 162.6°E' },
  { label: 'Maximum Winds', value: '20 kt', detail: 'Gusts: N/A' },
  { label: 'Minimum Central Pressure', value: '1008 mb' },
  { label: 'Environmental Pressure', value: 'N/A' },
  { label: 'Radius of Circulation', value: 'N/A' },
  { label: 'Radius of Maximum Wind', value: 'N/A' },
]
const selectedStorm = ref('96W INVEST')
const observation = ref('06:00–07:30 UTC · Oct 11, 2026')
const informationOpen = ref(false)
const settingsOpen = ref(false)
const acronymsOpen = ref(false)
const compact = ref(false)
const preview = ref<ImagePreview | null>(null)
const snackbar = ref('')
let snackbarTimer: ReturnType<typeof setTimeout> | undefined
const dialogOpen = computed(() => settingsOpen.value || acronymsOpen.value || preview.value !== null)

function notify(message: string) {
  clearTimeout(snackbarTimer)
  snackbar.value = message
  snackbarTimer = setTimeout(() => { snackbar.value = '' }, 6000)
}
function selectCycle(forecast: Forecast, cycle: Cycle) {
  forecast.cycle = cycle
  if (forecast.id !== 'wnc2') notify(`${forecast.title}: ${cycle} selected. Only the screenshot's 06z image is available; the reference image has not changed.`)
}
function openImage(title: string, image: string, description: string) {
  preview.value = { title, image, description }
}
function closeDialogs() {
  preview.value = null
  settingsOpen.value = false
  acronymsOpen.value = false
}
const currentHash = ref(window.location.hash)
const weatherToolsOpen = computed(() => /^#weather-tools(?:\/|$)/.test(currentHash.value))
const weatherToolId = computed(() => currentHash.value.startsWith('#weather-tools/') ? currentHash.value.slice('#weather-tools/'.length) : undefined)
async function onHashChange() {
  currentHash.value = window.location.hash
  closeDialogs()
  await nextTick()
  if (weatherToolsOpen.value) {
    const heading = document.querySelector<HTMLElement>('#weather-tools h1')
    heading?.focus({ preventScroll: true })
    document.querySelector('#weather-tools')?.scrollIntoView?.({ block: 'start' })
  } else if (currentHash.value === '#models-title') document.querySelector('#models-title')?.scrollIntoView?.({ block: 'start' })
}
onMounted(() => window.addEventListener('hashchange', onHashChange))
onBeforeUnmount(() => { clearTimeout(snackbarTimer); window.removeEventListener('hashchange', onHashChange) })
</script>

<template>
  <div class="site-shell" :class="{ compact }" @keydown.esc="closeDialogs">
    <header class="site-header">
      <a class="brand" href="#main-content" aria-label="Tropical Tidbits home">
        <span class="brand-icon material-icons-round" aria-hidden="true">cyclone</span>
        <span>Tropical <strong>Tidbits</strong></span>
      </a>
      <nav class="main-navigation" aria-label="Main navigation">
        <template v-for="(item, index) in navigation" :key="item.label">
          <a v-if="index === 0" class="nav-link" :class="{ current: !weatherToolsOpen }" href="#main-content" :aria-current="!weatherToolsOpen ? 'page' : undefined">{{ item.label }}</a>
          <a v-else-if="index === 1" class="nav-link" :class="{ current: weatherToolsOpen }" :href="item.href" :aria-current="weatherToolsOpen ? 'page' : undefined">{{ item.label }}</a>
          <a v-else class="nav-link" :href="item.href" target="_blank" rel="noopener noreferrer" :aria-label="`${item.label} — open original website in new tab`">{{ item.label }}</a>
        </template>
      </nav>
    </header>

    <WeatherTools v-if="weatherToolsOpen" :tool-id="weatherToolId" />
    <main v-show="!weatherToolsOpen" id="main-content">
      <section class="page-title-row">
        <div>
          <p class="eyebrow">TROPICAL CYCLONE MONITORING</p>
          <h1>Global Tropical Cyclone and Disturbance Information</h1>
        </div>
        <div class="page-actions">
          <a class="support-button" href="https://www.tropicaltidbits.com/" target="_blank" rel="noopener noreferrer"><span class="material-icons-round" aria-hidden="true">favorite_border</span><span>Support Tropical Tidbits</span></a>
          <button class="icon-button" aria-label="Display settings" @click="settingsOpen = true"><span class="material-icons-round" aria-hidden="true">settings</span></button>
        </div>
      </section>

      <div class="information-panel">
        <button class="information-toggle" :aria-expanded="informationOpen" aria-controls="data-information" @click="informationOpen = !informationOpen">
          <span class="material-icons-round" aria-hidden="true">info_outline</span>
          <span>Information about this data</span>
          <span class="material-icons-round disclosure-icon" :class="{ expanded: informationOpen }" aria-hidden="true">expand_more</span>
        </button>
        <div v-if="informationOpen" id="data-information" class="information-content">
          Invest 96W's details, satellite imagery and other guidance panels are screenshot references, not live feeds. WindBorne WM-6 shows individual member tracks classified locally using WNC2 wind thresholds and the provider mean on a Natural Earth coastline map. Cones and landfall markers have been removed. PNG and SVG chart downloads are available. WM-6 data are forecast guidance, not official warnings. WNC2 checks Google's latest 00/06/12/18Z CSV every five minutes while visible and displays 0–312h. Offline snapshots are explicitly labeled and not confirmed latest. Always consult official meteorological agencies for current warnings.
        </div>
      </div>

      <div class="storm-toolbar">
        <div class="outlined-field">
          <label for="storm-select">Select a system</label>
          <select id="storm-select" v-model="selectedStorm"><option>96W INVEST</option></select>
        </div>
        <span class="reference-badge"><span class="material-icons-round" aria-hidden="true">photo</span>Screenshot reference · not live</span>
      </div>

      <div class="weather-layout">
        <section class="storm-card card" aria-labelledby="storm-title">
          <div class="card-heading storm-heading"><div><p class="section-kicker">WESTERN PACIFIC</p><h2 id="storm-title">Invest 96W</h2></div><span class="invest-badge">INVEST</span></div>
          <p class="timestamp"><span class="material-icons-round" aria-hidden="true">schedule</span>As of 06:00 UTC Oct 11, 2026</p>
          <dl class="storm-details"><div v-for="detail in stormDetails" :key="detail.label"><dt>{{ detail.label }}</dt><dd>{{ detail.value }}<span v-if="detail.detail">{{ detail.detail }}</span></dd></div></dl>
          <div class="storm-note"><span class="material-icons-round" aria-hidden="true">info_outline</span><span>N/A indicates data unavailable in the reference.</span></div>
        </section>

        <section class="satellite-card card" aria-labelledby="satellite-title">
          <div class="card-heading"><div><h2 id="satellite-title">Infrared Satellite Image</h2><p>Invest 96W · Western Pacific</p></div><span class="material-icons-round heading-icon" aria-hidden="true">satellite_alt</span></div>
          <button class="image-button satellite-image" aria-label="Enlarge infrared satellite reference image" @click="openImage('Infrared Satellite Image', '/images/infrared.png', 'Static image from the screenshot. A satellite animation loop is not available.')"><img src="/images/infrared.png" alt="Infrared satellite imagery of Invest 96W with enhanced cloud-top temperatures" /><span class="image-overlay"><span class="material-icons-round" aria-hidden="true">zoom_in</span>Enlarge image</span></button>
          <div class="card-caption"><span>06:00 UTC · Oct 11, 2026</span><span>Static reference</span></div>
        </section>

        <aside class="advertisement" aria-label="Advertisement from reference screenshot"><p>Advertisement</p><img src="/images/advertisement.png" alt="Philips Lighting advertisement shown in the original screenshot" /><span>Original screenshot placement</span></aside>

        <section class="surface-card card" aria-labelledby="surface-title">
          <div class="card-heading"><div><h2 id="surface-title">Surface Plot</h2><p>Marine observations near 96W INVEST</p></div><span class="material-icons-round heading-icon" aria-hidden="true">public</span></div>
          <p class="surface-note">The most recent hour may not be fully populated with stations yet.</p>
          <button class="image-button surface-image" aria-label="Enlarge surface observation plot" @click="openImage('Surface Plot', '/images/surface-plot.png', 'Marine surface observations near 96W INVEST, 06:00–07:30 UTC on October 11, 2026.')"><img src="/images/surface-plot.png" alt="Marine surface plot showing the low pressure center and observations near Invest 96W" /><span class="image-overlay"><span class="material-icons-round" aria-hidden="true">zoom_in</span>Click to enlarge</span></button>
          <div class="surface-controls"><div class="outlined-field"><label for="observation-select">Observation time</label><select id="observation-select" v-model="observation"><option>06:00–07:30 UTC · Oct 11, 2026</option></select></div></div>
        </section>

        <section class="models-section" aria-labelledby="models-title">
          <div class="models-heading"><h2 id="models-title">Model Forecasts</h2><button class="text-button" @click="acronymsOpen = true">List of model acronyms<span class="material-icons-round" aria-hidden="true">help_outline</span></button></div>
          <div class="forecast-grid">
            <article v-for="forecast in forecasts" :key="forecast.id" class="forecast-card card">
              <div class="forecast-heading"><h3>{{ forecast.title }}</h3><p>{{ forecast.description }}</p></div>
              <Wnc2Ensemble v-if="forecast.id === 'wnc2'" />
              <Wm6Ensemble v-else-if="forecast.id === 'wm6'" />
              <button v-else-if="forecast.image" class="image-button forecast-image" :aria-label="`Enlarge ${forecast.title} reference image`" @click="openImage(forecast.title, forecast.image, forecast.id === 'intensity' ? 'Supplied reference: Hurricane TRUDY (21E), initialized 00Z Oct 17, 2026. Not live and not an intensity forecast for Invest 96W.' : 'Static 06z reference image from the supplied screenshot.')"><img :src="forecast.image" :alt="forecast.id === 'intensity' ? 'Hurricane TRUDY (21E) Model Intensity Guidance initialized 00Z Oct 17 2026, supplied reference' : `${forecast.title} track forecast for Invest 96W`" /><span class="image-overlay"><span class="material-icons-round" aria-hidden="true">zoom_in</span>Enlarge</span></button>
              <div v-else class="missing-image"><span class="material-icons-round" aria-hidden="true">image_not_supported</span><strong>Image unavailable</strong></div>
              <div v-if="forecast.id === 'intensity'" class="intensity-reference-note"><p>提供的 TRUDY（21E）強度指引圖 · 2026-10-17 00Z · 靜態參考，非即時更新，也不是 96W 的預報。</p><a href="/images/21E-intensity-reference.png" download="21E-TRUDY-intensity-2026101700-reference.png">Download PNG · 手機可開啟大圖後長按儲存</a></div>
              <div v-if="forecast.id === 'global'" class="cycle-selector" :aria-label="`${forecast.title} model cycle`"><button v-for="cycle in cycles" :key="cycle" :class="{ selected: forecast.cycle === cycle }" :aria-pressed="forecast.cycle === cycle" @click="selectCycle(forecast, cycle)">{{ cycle }}</button></div>
              <p v-if="forecast.id === 'global'" class="cycle-note">{{ forecast.cycle === '06z' ? '06z screenshot reference' : `${forecast.cycle} unavailable · showing 06z reference` }}</p>
            </article>
          </div>
        </section>
      </div>
      <footer><span>Tropical Tidbits · Material Design recreation</span><span>96W details: screenshot · WNC2 + WM-6 auto-update forecast guidance</span></footer>
    </main>

    <div v-if="dialogOpen" class="dialog-backdrop" @click.self="closeDialogs">
      <dialog open class="dialog" :class="{ 'image-dialog': preview }" aria-modal="true" aria-labelledby="dialog-title" @keydown.esc="closeDialogs">
        <div class="dialog-heading"><h2 id="dialog-title">{{ preview?.title ?? (settingsOpen ? 'Display settings' : 'Model acronyms') }}</h2><button class="icon-button" aria-label="Close dialog" autofocus @click="closeDialogs"><span class="material-icons-round" aria-hidden="true">close</span></button></div>
        <template v-if="preview"><img class="preview-image" :src="preview.image" :alt="preview.title" /><p class="dialog-copy">{{ preview.description }}</p></template>
        <template v-else-if="settingsOpen"><label class="setting-row"><span><strong>Compact spacing</strong><small>Reduce padding between information panels.</small></span><input v-model="compact" type="checkbox" /></label><p class="dialog-copy">This preview uses static reference images. Display settings do not change the underlying data.</p></template>
        <template v-else><dl class="acronyms"><div><dt>WNC2 / WN2-C</dt><dd>WeatherNext 2 Cyclones · Google's AI cyclone forecasting model (FNV3.2)</dd></div><div><dt>WM-6</dt><dd>WindBorne's tropical cyclone ensemble tracker with locally classified intensity-colored member paths and provider mean; save charts as PNG or SVG</dd></div><div><dt>GeoJSON</dt><dd>Map-ready FeatureCollection containing paths, forecast points and landfalls; cone features are excluded. Landfalls are not displayed on the chart.</dd></div><div><dt>00z / 06z / 12z / 18z</dt><dd>Model initialization times in UTC</dd></div></dl></template>
        <div class="dialog-actions"><button class="filled-button" @click="closeDialogs">Done</button></div>
      </dialog>
    </div>
    <Transition name="snackbar"><div v-if="snackbar" class="snackbar" role="status"><span>{{ snackbar }}</span><button @click="snackbar = ''" aria-label="Dismiss notification">Dismiss</button></div></Transition>
  </div>
</template>
