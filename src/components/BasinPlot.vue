<script setup lang="ts">
import { computed, useId } from 'vue'
import type { Catalog } from '../data/wnc2'
import { basinTracks, pointInRegion, pressureCategories, pressureColor, regionLongitude, type BasinRegion, type MapTheme } from '../data/basin'
import land from '../data/wm6-land.json'

const props = defineProps<{ catalog: Catalog; region: BasinRegion; theme: MapTheme }>()
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
</script>

<template>
  <svg class="basin-map" viewBox="0 0 1200 970" xmlns="http://www.w3.org/2000/svg" role="img" :aria-label="`WNC2 ${region.label}系集預報 ${catalog.initTime} UTC`" :style="{ background: colors.sea, color: colors.text }">
    <title>WeatherNext 2 Cyclones · {{ region.label }} · 0–312h</title>
    <desc>各成員與氣旋獨立分組，圓圈依最低海平面氣壓著色；缺少氣壓顯示灰色。底圖為 Natural Earth，非官方警報。</desc>
    <defs><clipPath :id="clipId"><rect x="62" y="85" width="1110" height="815" /></clipPath></defs>
    <text x="62" y="33" font-size="20" fill="currentColor">WeatherNext 2 Cyclones Ensemble Forecast · {{ region.label }} (0–312 hours)</text>
    <text x="62" y="60" font-size="18" fill="currentColor">Initial time: {{ catalog.initTime }} UTC</text>
    <text x="1170" y="76" text-anchor="end" font-size="16" fill="currentColor">min. MSLP: {{ minPressure }} hPa</text>
    <g :clip-path="`url(#${clipId})`">
      <rect x="62" y="85" width="1110" height="815" :fill="colors.sea" />
      <path v-for="(path, i) in lands" :key="i" :d="path" :fill="colors.land" :stroke="colors.line" stroke-width="1" />
      <g :stroke="colors.grid" stroke-width=".8" stroke-dasharray="3 4"><line v-for="lon in lonTicks" :key="`lon-${lon}`" :x1="rawX(lon)" :x2="rawX(lon)" y1="85" y2="900" /><line v-for="lat in latTicks" :key="`lat-${lat}`" x1="62" x2="1172" :y1="y(lat)" :y2="y(lat)" /></g>
      <g class="basin-track-lines" stroke="#a8adb4" stroke-width="1" stroke-opacity=".45"><line v-for="segment in segments" :key="segment.key" :x1="x(segment.previous.lon)" :x2="x(segment.point.lon)" :y1="y(segment.previous.lat)" :y2="y(segment.point.lat)" /></g>
      <g class="basin-pressure-points"><circle v-for="point in visiblePoints" :key="`${point.sample}:${point.trackId}:${point.leadHours}`" :cx="x(point.lon)" :cy="y(point.lat)" r="3.1" fill="none" :stroke="pressureColor(point.pressure)" stroke-width="1.4"><title>{{ point.trackId }} · Member {{ point.sample + 1 }} · +{{ point.leadHours }}h · {{ point.pressure ?? '—' }} hPa</title></circle></g>
    </g>
    <rect x="62" y="85" width="1110" height="815" fill="none" :stroke="colors.line" stroke-width="1.5" />
    <g font-size="15" fill="currentColor"><text v-for="lon in lonTicks" :key="lon" :x="rawX(lon)" y="924" text-anchor="middle">{{ lonLabel(lon) }}</text><text v-for="lat in latTicks" :key="lat" x="55" :y="y(lat) + 5" text-anchor="end">{{ Math.abs(lat) }}°{{ lat < 0 ? 'S' : 'N' }}</text></g>
    <g class="basin-pressure-legend" transform="translate(76,98)"><rect width="170" height="161" rx="4" :fill="colors.sea" fill-opacity=".93" /><g v-for="(category, i) in pressureCategories" :key="category.label" :transform="`translate(14,${18 + i * 20})`"><circle r="4" fill="none" :stroke="category.color" stroke-width="1.5" /><text x="16" y="5" font-size="14" fill="currentColor">{{ category.label }}</text></g><circle cy="138" r="4" fill="none" stroke="#8b929c" /><text x="16" y="143" font-size="14" fill="currentColor">MSLP unavailable</text></g>
    <text v-if="!visiblePoints.length" x="615" y="510" text-anchor="middle" font-size="25" fill="currentColor">此洋區沒有 0–312h 氣旋資料</text>
    <text x="62" y="951" font-size="15" fill="currentColor">WNC2 · {{ catalog.totalSamples }} ensemble members · pressure-colored guidance · Natural Earth coastlines</text>
  </svg>
</template>

<style scoped>
.basin-map { display: block; width: 100%; height: auto; font-family: Arial, sans-serif; border-radius: 5px; }
</style>
