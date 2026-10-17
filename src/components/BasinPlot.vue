<script setup lang="ts">
import { computed, useId } from 'vue'
import { categories, windCategory, type Catalog, type MeanPoint } from '../data/wnc2'
import { basinTracks, pointInRegion, pressureCategories, pressureColor, regionLongitude, type BasinRegion, type MapTheme } from '../data/basin'
import land from '../data/wm6-land.json'

const props = withDefaults(defineProps<{ catalog: Catalog; region: BasinRegion; theme: MapTheme; modelLabel?: string; windMode?: boolean; mean?: MeanPoint[]; meanLabel?: string; storm?: string }>(), { modelLabel: 'WNC2', windMode: false, mean: () => [], meanLabel: 'Ensemble mean', storm: '' })
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
const lands = computed(() => land.features.flatMap(feature => feature.geometry.coordinates).flatMap(ring => {
  const continuous: number[][] = []
  for (const point of ring) {
    let lon = point[0]!
    const previous = continuous[continuous.length - 1]?.[0]
    if (previous !== undefined) lon += 360 * Math.round((previous - lon) / 360)
    continuous.push([lon, point[1]!])
  }
  const longitudes = continuous.map(point => point[0]!), latitudes = continuous.map(point => point[1]!)
  if (Math.max(...latitudes) < props.region.south || Math.min(...latitudes) > props.region.north) return []
  const result: string[] = []
  for (let copy = Math.ceil((props.region.west - Math.max(...longitudes)) / 360); copy <= Math.floor((props.region.east - Math.min(...longitudes)) / 360); copy++) result.push(continuous.map((point, i) => `${i ? 'L' : 'M'}${rawX(point[0]! + copy * 360).toFixed(2)},${y(point[1]!).toFixed(2)}`).join(' ') + 'Z')
  return result
}))
const step = computed(() => props.region.east - props.region.west > 60 ? 10 : 5)
const lonTicks = computed(() => Array.from({ length: Math.floor((props.region.east - props.region.west) / step.value) + 1 }, (_, i) => props.region.west + i * step.value))
const latTicks = computed(() => Array.from({ length: Math.floor((props.region.north - props.region.south) / 5) + 1 }, (_, i) => props.region.south + i * 5))
function lonLabel(lon: number) { const normalized = ((lon + 180) % 360 + 360) % 360 - 180; return `${Math.abs(normalized)}°${normalized < 0 ? 'W' : 'E'}` }
const peaks = computed(() => tracks.value.map(track => { const winds = track.points.map(point => point.wind).filter(wind => Number.isFinite(wind) && wind >= 0); return { sample: track.points[0]!.sample, wind: winds.length ? Math.max(...winds) : NaN } }).sort((a, b) => a.sample - b.sample))
const peakSpacing = computed(() => Math.min(15, 800 / Math.max(1, Math.min(64, peaks.value.length))))
const svgWidth = computed(() => props.windMode ? 1200 + 180 * Math.max(1, Math.ceil(peaks.value.length / 64)) : 1200)
const windColor = (wind: number) => windCategory(wind)?.color ?? '#7b8798'
const meanSegments = computed(() => props.mean.slice(1).flatMap((point, i) => Math.abs(regionLongitude(point.lon, props.region) - regionLongitude(props.mean[i]!.lon, props.region)) > 180 ? [] : [{ point, previous: props.mean[i]! }]))
</script>

<template>
  <svg class="basin-map" :viewBox="`0 0 ${svgWidth} 970`" xmlns="http://www.w3.org/2000/svg" role="img" :aria-label="`${modelLabel} ${storm || region.label}系集預報 ${catalog.initTime} UTC`" :style="{ background: colors.sea, color: colors.text }">
    <title>{{ modelLabel }} Ensemble Forecast · {{ storm || region.label }} · 0–312h</title>
    <desc>各成員與氣旋獨立分組。洋區圓圈依最低海平面氣壓著色；氣旋路徑依原始風速與本站風級著色，未知值為灰色。底圖為 Natural Earth，非官方警報。</desc>
    <rect :width="svgWidth" height="970" :fill="colors.sea" />
    <defs><clipPath :id="clipId"><rect x="62" y="85" width="1110" height="815" /></clipPath></defs>
    <text x="62" y="33" font-size="20" fill="currentColor">{{ modelLabel }} Ensemble Forecast · {{ storm || region.label }} (0–312 hours)</text>
    <text x="62" y="60" font-size="18" fill="currentColor">Initial time: {{ catalog.initTime }} UTC</text>
    <text x="1170" y="76" text-anchor="end" font-size="16" fill="currentColor">min. MSLP: {{ minPressure }} hPa</text>
    <g :clip-path="`url(#${clipId})`">
      <rect x="62" y="85" width="1110" height="815" :fill="colors.sea" />
      <path v-for="(path, i) in lands" :key="i" :d="path" :fill="colors.land" :stroke="colors.line" stroke-width="1" />
      <g :stroke="colors.grid" stroke-width=".8" stroke-dasharray="3 4"><line v-for="lon in lonTicks" :key="`lon-${lon}`" :x1="rawX(lon)" :x2="rawX(lon)" y1="85" y2="900" /><line v-for="lat in latTicks" :key="`lat-${lat}`" x1="62" x2="1172" :y1="y(lat)" :y2="y(lat)" /></g>
      <g class="basin-track-lines" :stroke-width="windMode ? 1.8 : 1" :stroke-opacity="windMode ? .9 : .45"><line v-for="segment in segments" :key="segment.key" :x1="x(segment.previous.lon)" :x2="x(segment.point.lon)" :y1="y(segment.previous.lat)" :y2="y(segment.point.lat)" :stroke="windMode ? windColor(segment.previous.wind) : '#a8adb4'"><title>{{ segment.point.trackId }} · Member {{ segment.point.sample }} · +{{ segment.point.leadHours }}h · {{ Number.isFinite(segment.point.wind) ? segment.point.wind.toFixed(1) : '—' }} kt · {{ segment.point.pressure ?? '—' }} hPa · {{ segment.point.validTime }}</title></line></g>
      <g v-if="!windMode" class="basin-pressure-points"><circle v-for="point in visiblePoints" :key="`${point.sample}:${point.trackId}:${point.leadHours}`" :cx="x(point.lon)" :cy="y(point.lat)" r="3.1" fill="none" :stroke="pressureColor(point.pressure)" stroke-width="1.4"><title>{{ point.trackId }} · Member {{ point.sample }} · +{{ point.leadHours }}h · {{ point.pressure ?? '—' }} hPa · {{ Number.isFinite(point.wind) ? point.wind.toFixed(1) : '—' }} kt · {{ point.validTime }}</title></circle></g>
      <g v-if="windMode" class="potential-mean"><line v-for="segment in meanSegments" :key="segment.point.leadHours" :x1="x(segment.previous.lon)" :x2="x(segment.point.lon)" :y1="y(segment.previous.lat)" :y2="y(segment.point.lat)" stroke="currentColor" stroke-width="4"><title>{{ meanLabel }}</title></line><g v-for="point in mean.filter(item => item.leadHours % 24 === 0)" :key="point.leadHours"><rect :x="x(point.lon) - 3" :y="y(point.lat) - 3" width="6" height="6" fill="currentColor" /><text :x="x(point.lon) + 7" :y="y(point.lat) - 5" font-size="17" fill="currentColor">+{{ point.leadHours }}h</text></g></g>
    </g>
    <rect x="62" y="85" width="1110" height="815" fill="none" :stroke="colors.line" stroke-width="1.5" />
    <g font-size="15" fill="currentColor"><text v-for="lon in lonTicks" :key="lon" :x="rawX(lon)" y="924" text-anchor="middle">{{ lonLabel(lon) }}</text><text v-for="lat in latTicks" :key="lat" x="55" :y="y(lat) + 5" text-anchor="end">{{ Math.abs(lat) }}°{{ lat < 0 ? 'S' : 'N' }}</text></g>
    <g v-if="!windMode" class="basin-pressure-legend" transform="translate(76,98)"><rect width="170" height="161" rx="4" :fill="colors.sea" fill-opacity=".93" /><g v-for="(category, i) in pressureCategories" :key="category.label" :transform="`translate(14,${18 + i * 20})`"><circle r="4" fill="none" :stroke="category.color" stroke-width="1.5" /><text x="16" y="5" font-size="14" fill="currentColor">{{ category.label }}</text></g><circle cy="138" r="4" fill="none" stroke="#8b929c" /><text x="16" y="143" font-size="14" fill="currentColor">MSLP unavailable</text></g>
    <g v-else class="potential-wind-legend" transform="translate(940,98)"><rect width="220" height="215" :fill="colors.sea" fill-opacity=".94" :stroke="colors.line" /><g v-for="(category, i) in categories" :key="category.label" :transform="`translate(12,${18 + i * 20})`"><rect width="25" height="8" :fill="category.color" /><text x="33" y="8" font-size="13" fill="currentColor">{{ category.label }} ≥{{ category.min }}kt</text></g><line x1="12" x2="37" y1="178" y2="178" stroke="#7b8798" stroke-width="3" /><text x="45" y="182" font-size="13" fill="currentColor">Wind unavailable</text><line v-if="mean.length" class="potential-mean-legend-line" x1="12" x2="37" y1="200" y2="200" stroke="currentColor" stroke-width="3" /><text :x="mean.length ? 45 : 12" y="204" font-size="12" fill="currentColor">{{ meanLabel }}</text></g>
    <g v-if="windMode" class="potential-member-peaks"><text v-for="(peak, i) in peaks" :key="peak.sample" :x="1188 + Math.floor(i / 64) * 180" :y="100 + (i % 64) * peakSpacing" :font-size="Math.min(14, peakSpacing)" :fill="windColor(peak.wind)">Member {{ peak.sample }}: {{ Number.isFinite(peak.wind) ? peak.wind.toFixed(1) : '—' }} kt</text></g>
    <text v-if="!visiblePoints.length" x="615" y="510" text-anchor="middle" font-size="25" fill="currentColor">此洋區沒有 0–312h 氣旋資料</text>
    <text x="62" y="951" font-size="15" fill="currentColor">{{ modelLabel }} · {{ windMode ? peaks.length : catalog.totalSamples }} member tracks · {{ windMode ? 'wind-colored · ' + meanLabel : 'pressure-colored guidance' }} · Natural Earth coastlines</text>
  </svg>
</template>

<style scoped>
.basin-map { display: block; width: 100%; height: auto; font-family: Arial, sans-serif; border-radius: 5px; }
</style>
