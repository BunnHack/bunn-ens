<script setup lang="ts">
import { computed, useId } from 'vue'
import { categories, windCategory, type Catalog, type MeanPoint } from '../data/wnc2'
import { basinTracks, pointInRegion, pressureCategories, pressureColor, regionLongitude, type BasinRegion, type MapTheme } from '../data/basin'
import { geographicPaths, visiblePlaces } from '../data/map-geography'
import type { ProbabilityField } from '../data/probability'

const props = withDefaults(defineProps<{ catalog: Catalog; region: BasinRegion; theme: MapTheme; modelLabel?: string; windMode?: boolean; mean?: MeanPoint[]; meanLabel?: string; storm?: string; probability?: ProbabilityField; leadStart?: number; leadEnd?: number; showLeadLabels?: boolean; timeAnchor?: string }>(), { modelLabel: 'WNC2', windMode: false, mean: () => [], meanLabel: 'Ensemble mean', storm: '', leadStart: 0, leadEnd: 312, showLeadLabels: false, timeAnchor: '' })
const clipId = `basin-${useId().replace(/:/g, '')}`
const colors = computed(() => props.theme === 'dark' ? { sea: '#182330', land: '#354455', line: '#8794a2', text: '#e3edf5', grid: '#495b6d' } : props.theme === 'color' ? { sea: '#e8f5fc', land: '#d9e8ce', line: '#829786', text: '#344b60', grid: '#b7d0df' } : { sea: '#fff', land: '#e9ecef', line: '#a8adb3', text: '#333', grid: '#c6cbd0' })
const rawX = (lon: number) => 62 + (lon - props.region.west) / (props.region.east - props.region.west) * 1110
const x = (lon: number) => rawX(regionLongitude(lon, props.region))
const y = (lat: number) => 85 + (props.region.north - lat) / (props.region.north - props.region.south) * 815
const tracks = computed(() => basinTracks(props.catalog, props.region))
const segments = computed(() => tracks.value.flatMap(track => track.points.slice(1).flatMap((point, index) => {
  const previous = track.points[index]!
  if (Math.abs(regionLongitude(point.lon, props.region) - regionLongitude(previous.lon, props.region)) > 180) return []
  return [{ key: `${track.key}:${point.leadHours}`, point, previous }]
})))
const visiblePoints = computed(() => tracks.value.flatMap(track => track.points.filter(point => pointInRegion(point, props.region))))
const minPressure = computed(() => {
  const pressures = visiblePoints.value.flatMap(point => point.pressure != null && point.pressure > 0 && Number.isFinite(point.pressure) ? [point.pressure] : [])
  return pressures.length ? Math.min(...pressures).toFixed(1) : '—'
})
const lands = computed(() => geographicPaths('land', props.region))
const boundaries = computed(() => geographicPaths('borders', props.region))
const places = computed(() => {
  const chosen: ReturnType<typeof visiblePlaces> = []
  for (const place of visiblePlaces(props.region)) if (chosen.every(other => Math.hypot(x(other.lon) - x(place.lon), y(other.lat) - y(place.lat)) > 75)) chosen.push(place)
  return chosen
})
const step = computed(() => props.region.east - props.region.west > 60 ? 10 : 5)
const lonTicks = computed(() => Array.from({ length: Math.max(0, Math.floor(props.region.east / step.value) - Math.ceil(props.region.west / step.value) + 1) }, (_, i) => (Math.ceil(props.region.west / step.value) + i) * step.value))
const latTicks = computed(() => Array.from({ length: Math.max(0, Math.floor(props.region.north / 5) - Math.ceil(props.region.south / 5) + 1) }, (_, i) => (Math.ceil(props.region.south / 5) + i) * 5))
function lonLabel(lon: number) { const normalized = ((lon + 180) % 360 + 360) % 360 - 180; return `${Math.abs(normalized)}°${normalized < 0 ? 'W' : 'E'}` }
const peaks = computed(() => {
  const members = new Map<number, number>()
  for (const track of tracks.value) for (const point of track.points) {
    const previous = members.get(point.sample)
    members.set(point.sample, Number.isFinite(point.wind) && point.wind >= 0 ? Math.max(Number.isFinite(previous) ? previous! : -Infinity, point.wind) : previous ?? NaN)
  }
  return [...members].map(([sample, wind]) => ({ sample, wind })).sort((a, b) => a.sample - b.sample)
})
const peakSpacing = computed(() => Math.min(15, 800 / Math.max(1, Math.min(64, peaks.value.length))))
const svgWidth = computed(() => props.windMode ? 1200 + 180 * Math.max(1, Math.ceil(peaks.value.length / 64)) : 1200)
const windColor = (wind: number) => windCategory(wind)?.color ?? '#7b8798'
const meanSegments = computed(() => props.mean.slice(1).flatMap((point, i) => Math.abs(regionLongitude(point.lon, props.region) - regionLongitude(props.mean[i]!.lon, props.region)) > 180 ? [] : [{ point, previous: props.mean[i]! }]))
const windowLabel = computed(() => `${props.probability?.minLead ?? props.leadStart}–${props.probability?.maxLead ?? props.leadEnd}h`)
const leadLabels = computed(() => {
  const chosen = new Set(peaks.value.filter((_, i) => i % Math.max(1, Math.ceil(peaks.value.length / 48)) === 0).map(peak => peak.sample))
  return props.showLeadLabels ? visiblePoints.value.filter(point => point.leadHours % 24 === 0 && chosen.has(point.sample)).slice(0, 400) : []
})
const probabilityBands = [{ level: 5, color: '#73ccff', label: '5–25%' }, { level: 25, color: '#00bddd', label: '25–50%' }, { level: 50, color: '#ffe500', label: '50–75%' }, { level: 75, color: '#ed5aef', label: '75–100%' }, { level: 100, color: '#ff8ff2', label: '100%' }]
const probabilityPaths = computed(() => props.probability?.contours.map(band => ({ level: band.level, color: probabilityBands.find(item => item.level === band.level)!.color, path: band.rings.map(ring => ring.map((point, i) => `${i ? 'L' : 'M'}${rawX(point[0]!).toFixed(2)},${y(point[1]!).toFixed(2)}`).join(' ') + 'Z').join(' ') })) ?? [])
</script>

<template>
  <svg class="basin-map" :viewBox="`0 0 ${svgWidth} 970`" xmlns="http://www.w3.org/2000/svg" role="img" :aria-label="`${modelLabel} ${storm || region.label}系集預報 ${catalog.initTime} UTC`" :style="{ background: colors.sea, color: colors.text }">
    <title>{{ modelLabel }} {{ probability ? 'Local 120 km Passage Probability' : 'Ensemble Forecast' }} · {{ storm || region.label }} · {{ windowLabel }}</title>
    <desc>{{ probability ? `Local ensemble fraction passing within ${probability.radiusKm} km during ${windowLabel}. ${probability.allSystems ? 'All-system union: independent track IDs remain separate and never connected; each member contributes at most one hit per location across all its storms.' : 'Single matched cyclone.'} Full ensemble denominator ${probability.denominator}; tracked members ${probability.trackedMembers}. Each member counted once, spherical interpolation, both time boundaries clipped, gaps over 12h not connected. Missing/untracked members do not count as hits; this does not imply no risk. View may focus on the ≥5% corridor. City percentages refer to city-centre points, not county-wide coverage. Not an official probability or warning.` : `Independent member/track-ID paths during ${windowLabel}; no cross-storm merging. Original winds in kt, unknown values gray. Peak winds are per member across window tracks touching this map; labels sample members at 24h intervals. City codes are display abbreviations, not station identifiers. Natural Earth; not an official warning.` }}</desc>
    <rect :width="svgWidth" height="970" :fill="colors.sea" />
    <defs><clipPath :id="clipId"><rect x="62" y="85" width="1110" height="815" /></clipPath></defs>
    <text x="62" y="33" font-size="20" fill="currentColor">{{ modelLabel }} {{ probability ? 'Local Passage Probability' : 'Ensemble Forecast' }} · {{ storm || region.label }} ({{ windowLabel }}){{ probability ? ` · within ${probability.radiusKm} km` : '' }}</text>
    <text x="62" y="60" font-size="16" fill="currentColor">Initial time: {{ catalog.initTime }} UTC{{ timeAnchor ? ` · Lead anchor: ${timeAnchor}` : '' }}</text>
    <text x="1170" y="76" text-anchor="end" font-size="16" fill="currentColor">{{ probability ? `N=${probability.denominator} · ${probability.trackedMembers} tracked members · ${windowLabel}` : `min. MSLP: ${minPressure} hPa` }}</text>
    <g :clip-path="`url(#${clipId})`">
      <rect x="62" y="85" width="1110" height="815" :fill="colors.sea" />
      <g class="basin-coastlines"><path v-for="(path, i) in lands" :key="i" :d="path" :fill="colors.land" :stroke="colors.line" stroke-width=".8" /></g>
      <g class="basin-boundaries" fill="none" :stroke="colors.line" stroke-width=".7"><path v-for="(path, i) in boundaries" :key="i" :d="path" /></g>
      <g v-if="probability" class="passage-probability-contours" fill-rule="evenodd"><path v-for="band in probabilityPaths" :key="band.level" :data-level="band.level" :d="band.path" :fill="band.color" fill-opacity=".55" :stroke="band.color" stroke-width="1.5"><title>Local passage probability ≥{{ band.level }}% · within {{ probability.radiusKm }} km · {{ windowLabel }} · N={{ probability.denominator }}</title></path></g>
      <g :stroke="colors.grid" stroke-width=".8" stroke-dasharray="3 4"><line v-for="lon in lonTicks" :key="`lon-${lon}`" :x1="rawX(lon)" :x2="rawX(lon)" y1="85" y2="900" /><line v-for="lat in latTicks" :key="`lat-${lat}`" x1="62" x2="1172" :y1="y(lat)" :y2="y(lat)" /></g>
      <g class="basin-track-lines" :stroke-width="windMode ? 1.8 : 1" :stroke-opacity="probability ? .18 : windMode ? .9 : .45"><line v-for="segment in segments" :key="segment.key" :x1="x(segment.previous.lon)" :x2="x(segment.point.lon)" :y1="y(segment.previous.lat)" :y2="y(segment.point.lat)" :stroke="windMode ? windColor(segment.previous.wind) : '#a8adb4'"><title>{{ segment.point.trackId }} · Member {{ segment.point.sample }} · +{{ segment.point.leadHours }}h · {{ Number.isFinite(segment.point.wind) ? segment.point.wind.toFixed(1) : '—' }} kt · {{ segment.point.pressure ?? '—' }} hPa · {{ segment.point.validTime }}</title></line></g>
      <g v-if="!windMode && !probability" class="basin-pressure-points"><circle v-for="point in visiblePoints" :key="`${point.sample}:${point.trackId}:${point.leadHours}`" :cx="x(point.lon)" :cy="y(point.lat)" r="3.1" fill="none" :stroke="pressureColor(point.pressure)" stroke-width="1.4"><title>{{ point.trackId }} · Member {{ point.sample }} · +{{ point.leadHours }}h · {{ point.pressure ?? '—' }} hPa · {{ Number.isFinite(point.wind) ? point.wind.toFixed(1) : '—' }} kt · {{ point.validTime }}</title></circle></g>
      <g v-if="windMode || probability" class="potential-mean"><line v-for="segment in meanSegments" :key="segment.point.leadHours" :x1="x(segment.previous.lon)" :x2="x(segment.point.lon)" :y1="y(segment.previous.lat)" :y2="y(segment.point.lat)" stroke="currentColor" :stroke-width="probability ? 2.5 : 4"><title>{{ meanLabel }}</title></line><g v-for="point in mean.filter(item => probability || item.leadHours % 24 === 0)" :key="point.leadHours"><circle v-if="probability" :cx="x(point.lon)" :cy="y(point.lat)" r="2.3" fill="currentColor" /><rect v-else :x="x(point.lon) - 3" :y="y(point.lat) - 3" width="6" height="6" fill="currentColor" /><text v-if="!probability" :x="x(point.lon) + 7" :y="y(point.lat) - 5" font-size="17" fill="currentColor">+{{ point.leadHours }}h</text></g></g>
      <g v-if="leadLabels.length" class="potential-lead-labels"><g v-for="point in leadLabels" :key="`${point.sample}:${point.trackId}:${point.leadHours}`"><circle :cx="x(point.lon)" :cy="y(point.lat)" r="1.5" :fill="windColor(point.wind)" /><text :x="x(point.lon)+3" :y="y(point.lat)-3" font-size="10" fill="currentColor" :stroke="colors.sea" stroke-width="1.6" paint-order="stroke">{{ point.leadHours }}<title>{{ point.trackId }} · Member {{ point.sample }} · +{{ point.leadHours }}h · {{ point.validTime }}</title></text></g></g>
      <g class="basin-place-labels"><g v-for="place in places" :key="place.name"><title>{{ place.code }} · {{ place.enName }} / {{ place.name }} · {{ place.lat }},{{ place.lon }} (display abbreviation, not a station ID)</title><circle :cx="x(place.lon)" :cy="y(place.lat)" r="2" :fill="colors.text" /><text :x="x(place.lon) + 5" :y="y(place.lat) - 5" font-size="13" :fill="colors.text" :stroke="colors.sea" stroke-width="2.5" paint-order="stroke">{{ place.code }}</text></g></g>
    </g>
    <rect x="62" y="85" width="1110" height="815" fill="none" :stroke="colors.line" stroke-width="1.5" />
    <g font-size="15" fill="currentColor"><text v-for="lon in lonTicks" :key="lon" :x="rawX(lon)" y="924" text-anchor="middle">{{ lonLabel(lon) }}</text><text v-for="lat in latTicks" :key="lat" x="55" :y="y(lat) + 5" text-anchor="end">{{ Math.abs(lat) }}°{{ lat < 0 ? 'S' : 'N' }}</text></g>
    <g v-if="probability" class="passage-probability-legend"><g transform="translate(76,98)"><rect width="165" height="115" :fill="colors.sea" fill-opacity=".95" /><g v-for="(band, i) in probabilityBands" :key="band.level" :transform="`translate(10,${18 + i * 20})`"><line x1="0" x2="30" :stroke="band.color" stroke-width="4" /><text x="40" y="5" font-size="14" fill="currentColor">{{ band.label }}</text></g></g><g transform="translate(946,98)"><rect width="210" :height="mean.length ? 54 : 32" :fill="colors.sea" fill-opacity=".94" /><line x1="10" x2="38" y1="16" y2="16" stroke="#a8adb4" /><text x="46" y="20" font-size="13" fill="currentColor">Ensemble members</text><g v-if="mean.length" class="probability-mean-legend"><line x1="10" x2="38" y1="38" y2="38" stroke="currentColor" stroke-width="2.5" /><text x="46" y="42" font-size="13" fill="currentColor">{{ meanLabel }}</text></g></g></g>
    <g v-else-if="!windMode" class="basin-pressure-legend" transform="translate(76,98)"><rect width="170" height="161" rx="4" :fill="colors.sea" fill-opacity=".93" /><g v-for="(category, i) in pressureCategories" :key="category.label" :transform="`translate(14,${18 + i * 20})`"><circle r="4" fill="none" :stroke="category.color" stroke-width="1.5" /><text x="16" y="5" font-size="14" fill="currentColor">{{ category.label }}</text></g><circle cy="138" r="4" fill="none" stroke="#8b929c" /><text x="16" y="143" font-size="14" fill="currentColor">MSLP unavailable</text></g>
    <g v-else class="potential-wind-legend" transform="translate(940,98)"><rect width="220" height="215" :fill="colors.sea" fill-opacity=".94" :stroke="colors.line" /><g v-for="(category, i) in categories" :key="category.label" :transform="`translate(12,${18 + i * 20})`"><rect width="25" height="8" :fill="category.color" /><text x="33" y="8" font-size="13" fill="currentColor">{{ category.label }} ≥{{ category.min }}kt</text></g><line x1="12" x2="37" y1="178" y2="178" stroke="#7b8798" stroke-width="3" /><text x="45" y="182" font-size="13" fill="currentColor">Wind unavailable</text><line v-if="mean.length" class="potential-mean-legend-line" x1="12" x2="37" y1="200" y2="200" stroke="currentColor" stroke-width="3" /><text :x="mean.length ? 45 : 12" y="204" font-size="12" fill="currentColor">{{ meanLabel }}</text></g>
    <g v-if="windMode" class="potential-member-peaks"><text v-for="(peak, i) in peaks" :key="peak.sample" :x="1188 + Math.floor(i / 64) * 180" :y="100 + (i % 64) * peakSpacing" :font-size="Math.min(14, peakSpacing)" :fill="windColor(peak.wind)">Member {{ peak.sample }}: {{ Number.isFinite(peak.wind) ? peak.wind.toFixed(1) : '—' }} kt</text></g>
    <g v-if="probability" class="passage-city-labels"><g v-for="(city, i) in probability.cities" :key="city.name" :transform="`translate(${76 + i * 154},866)`"><rect width="145" height="27" rx="13" fill="#f05b49" /><text x="72" y="18" text-anchor="middle" font-size="14" fill="white">{{ city.code ?? city.name }} {{ Math.round(city.percent) }}%</text><title>{{ city.enName ?? city.name }} / {{ city.name }} point {{ city.lat }},{{ city.lon }} · {{ city.hits }}/{{ probability.denominator }} members within {{ probability.radiusKm }} km; not county-wide probability</title></g></g>
    <text v-if="!visiblePoints.length" x="615" y="510" text-anchor="middle" font-size="25" fill="currentColor">此圖域沒有 {{ windowLabel }} 可用路徑；不代表零風險</text>
    <text x="62" y="951" font-size="15" fill="currentColor">{{ modelLabel }} · {{ probability ? `Local estimate, not official · N=${probability.denominator} · ${windowLabel} · ${probability.radiusKm} km` : `${windMode ? peaks.length : catalog.totalSamples} members · ${windowLabel} · ${windMode ? 'wind-colored · ' + meanLabel : 'pressure-colored guidance'}` }} · Natural Earth 1:50m</text>
  </svg>
</template>

<style scoped>
.basin-map { display: block; width: 100%; height: auto; font-family: Arial, sans-serif; border-radius: 5px; }
</style>
