<script setup lang="ts">
import type { Wm6Cyclone, Wm6Point } from '../data/wm6'
import { computed, useId } from 'vue'
import { categories, windCategory } from '../data/wnc2'
import land from '../data/wm6-land.json'

const props = defineProps<{ cyclone: Wm6Cyclone; initializationTime: string; forecastZero?: string }>()
const memberLines = computed(() => props.cyclone.members_path ?? [])
const referenceLongitude = computed(() => props.cyclone.genesis?.longitude ?? props.cyclone.mean_path?.[0]?.longitude ?? props.cyclone.members_path?.[0]?.path[0]?.longitude ?? 0)
const unwrap = (longitude: number) => referenceLongitude.value + ((longitude - referenceLongitude.value + 540) % 360) - 180
const pointsForBounds = computed(() => {
  const points: Array<[number, number]> = []
  for (const member of memberLines.value) for (const point of member.path) points.push([point.longitude, point.latitude])
  for (const point of props.cyclone.mean_path ?? props.cyclone.path ?? []) points.push([point.longitude, point.latitude])
  if (props.cyclone.genesis) points.push([props.cyclone.genesis.longitude, props.cyclone.genesis.latitude])
  return points.length ? points : [[referenceLongitude.value, 0]]
})
const view = computed(() => {
  const coordinates = pointsForBounds.value
  const lons = coordinates.map(coordinate => unwrap(coordinate[0])), lats = coordinates.map(coordinate => coordinate[1])
  const minLon = Math.min(...lons), maxLon = Math.max(...lons), minLat = Math.min(...lats), maxLat = Math.max(...lats)
  const lonSpan = Math.max(12, maxLon - minLon), latSpan = Math.max(12, maxLat - minLat)
  return { left: 85, top: 100, width: 1830, height: 1370, west: Math.floor((minLon - lonSpan * .12) / 5) * 5, east: Math.ceil((maxLon + lonSpan * .12) / 5) * 5, south: Math.max(-90, Math.floor((minLat - latSpan * .12) / 5) * 5), north: Math.min(90, Math.ceil((maxLat + latSpan * .12) / 5) * 5) }
})
const x = (longitude: number) => view.value.left + (unwrap(longitude) - view.value.west) / (view.value.east - view.value.west) * view.value.width
const y = (latitude: number) => view.value.top + (view.value.north - latitude) / (view.value.north - view.value.south) * view.value.height
const meanPath = computed(() => props.cyclone.mean_path ?? props.cyclone.path ?? [])
const memberPaths = computed(() => memberLines.value.map(member => ({ member: member.member, segments: member.path.slice(1).map((point, index) => ({ previous: member.path[index]!, point, color: windColor(member.path[index]!.max_wind_kt) })) })))
const landPolygons = computed(() => land.features.flatMap(feature => feature.geometry.coordinates).flatMap(ring => {
  // Unwrap each land ring continuously, then repeat it in nearby world copies.
  // Wrapping vertices independently draws false land across the map seam.
  const continuous: number[][] = []
  for (const point of ring) {
    let longitude = point[0]!
    const previous = continuous[continuous.length - 1]?.[0]
    if (previous !== undefined) longitude += 360 * Math.round((previous - longitude) / 360)
    continuous.push([longitude, point[1]!])
  }
  const longitudes = continuous.map(point => point[0]!), latitudes = continuous.map(point => point[1]!)
  const west = Math.min(...longitudes), east = Math.max(...longitudes)
  if (Math.max(...latitudes) < view.value.south || Math.min(...latitudes) > view.value.north) return []
  const paths: string[] = []
  for (let copy = Math.ceil((view.value.west - east) / 360); copy <= Math.floor((view.value.east - west) / 360); copy++) {
    paths.push(continuous.map((point, index) => `${index ? 'L' : 'M'}${(view.value.left + (point[0]! + copy * 360 - view.value.west) / (view.value.east - view.value.west) * view.value.width).toFixed(2)},${y(point[1]!).toFixed(2)}`).join(' ') + 'Z')
  }
  return paths
}))
const longitudeTicks = computed(() => Array.from({ length: Math.floor((view.value.east - view.value.west) / 10) + 1 }, (_, index) => view.value.west + index * 10))
const latitudeTicks = computed(() => Array.from({ length: Math.floor((view.value.north - view.value.south) / 10) + 1 }, (_, index) => view.value.south + index * 10))
const latestPoint = computed(() => meanPath.value[meanPath.value.length - 1])
const maxWind = computed(() => Math.max(0, ...memberLines.value.flatMap(member => member.path.map(point => point.max_wind_kt ?? 0))))
const legendCategories = categories
function windColor(wind: number | null | undefined) { return windCategory(wind)?.color ?? '#7b8798' }
const clipId = `wm6-${useId().replace(/:/g, '')}`
function longitudeLabel(value: number) { const normalized = ((value + 180) % 360 + 360) % 360 - 180; return `${Math.abs(normalized)}°${normalized < 0 ? 'W' : 'E'}` }
function latitudeLabel(value: number) { return `${Math.abs(value)}°${value < 0 ? 'S' : 'N'}` }
function pointLabel(point: Wm6Point) { return `+${point.forecast_hour}h · ${point.max_wind_kt == null ? 'wind —' : `${point.max_wind_kt.toFixed(1)} kt`} · ${windCategory(point.max_wind_kt)?.label ?? 'Wind unavailable'}` }
</script>

<template>
  <div class="wm6-plot">
    <svg viewBox="0 0 2000 1580" role="img" :aria-label="`WM-6 intensity-colored member forecast map for ${cyclone.tropical_cyclone_id}`">
      <title>WM-6 Forecast Map — {{ cyclone.tropical_cyclone_id }}</title>
      <desc>Geographic map with Natural Earth coastlines and provider mean. Member intensity is calculated locally from max_wind_kt using WNC2 categories, not upstream storm_type. Missing wind is gray.</desc>
      <defs><clipPath :id="clipId"><rect :x="view.left" :y="view.top" :width="view.width" :height="view.height" /></clipPath></defs>
      <rect width="2000" height="1580" fill="#eaf4fb" />
      <text x="85" y="46" font-size="32" fill="#294578">{{ cyclone.tropical_cyclone_id }}{{ cyclone.storm_name ? ` · ${cyclone.storm_name}` : '' }} · WM-6 forecast</text>
      <text x="85" y="78" font-size="22" fill="#73839d">Forecast base {{ forecastZero || 'unavailable' }} · provider run {{ initializationTime }} · {{ memberLines.length || cyclone.matched_members || '—' }} member tracks · intensity-colored</text>
      <g stroke="#b9d3e5" stroke-width="1" stroke-dasharray="4 6"><line v-for="longitude in longitudeTicks" :key="`lon-${longitude}`" :x1="x(longitude)" :x2="x(longitude)" :y1="view.top" :y2="view.top + view.height" /><line v-for="latitude in latitudeTicks" :key="`lat-${latitude}`" :x1="view.left" :x2="view.left + view.width" :y1="y(latitude)" :y2="y(latitude)" /></g>
      <g class="coastlines" :clip-path="`url(#${clipId})`"><path v-for="(polygon, index) in landPolygons" :key="index" :d="polygon" fill="#dce3d7" stroke="#759080" stroke-width="1.5" /></g>
      <g fill="#55718c" font-size="21"><text v-for="longitude in longitudeTicks" :key="`lon-label-${longitude}`" :x="x(longitude)" y="1510" text-anchor="middle">{{ longitudeLabel(longitude) }}</text><text v-for="latitude in latitudeTicks" :key="`lat-label-${latitude}`" x="70" :y="y(latitude) + 7" text-anchor="end">{{ latitudeLabel(latitude) }}</text></g>
      <g class="wm6-member-tracks"><template v-for="member in memberPaths" :key="member.member"><line v-for="segment in member.segments" :key="`${member.member}-${segment.point.forecast_hour}`" :x1="x(segment.previous.longitude)" :y1="y(segment.previous.latitude)" :x2="x(segment.point.longitude)" :y2="y(segment.point.latitude)" :stroke="segment.color" stroke-width="3" stroke-opacity=".68" stroke-linecap="round"><title>Member {{ member.member }} · {{ pointLabel(segment.point) }}</title></line></template></g>
      <polyline v-if="meanPath.length" :points="meanPath.map(point => `${x(point.longitude)},${y(point.latitude)}`).join(' ')" fill="none" stroke="#172f68" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"><title>WM-6 provider ensemble mean</title></polyline>
      <g v-for="point in meanPath" :key="`${point.valid_at}-${point.forecast_hour}`"><circle :cx="x(point.longitude)" :cy="y(point.latitude)" r="7" fill="#172f68" stroke="white" stroke-width="3"><title>{{ pointLabel(point) }}</title></circle><text v-if="point.forecast_hour === 0 || point.forecast_hour % 48 === 0" :x="x(point.longitude) + 14" :y="y(point.latitude) - 12" font-size="19" fill="#172f68">+{{ point.forecast_hour }}h</text></g>
      <g v-if="cyclone.genesis"><path :d="`M${x(cyclone.genesis.longitude)-13},${y(cyclone.genesis.latitude)-13}l26,26 M${x(cyclone.genesis.longitude)-13},${y(cyclone.genesis.latitude)+13}l26,-26`" stroke="#111827" stroke-width="5" /><text :x="x(cyclone.genesis.longitude) + 16" :y="y(cyclone.genesis.latitude) + 7" font-size="20" fill="#111827">Genesis</text></g>
      <rect :x="view.left" :y="view.top" :width="view.width" :height="view.height" fill="none" stroke="#7896ad" stroke-width="2" />
      <g class="wm6-intensity-legend" transform="translate(1470,112)"><rect width="430" height="330" rx="8" fill="white" fill-opacity=".95" stroke="#cad6e5" /><text x="18" y="28" font-size="21" fill="#526889">WNC2 wind categories (kt)</text><g v-for="(category, index) in legendCategories" :key="category.label" :transform="`translate(18,${48 + index * 28})`"><rect width="42" height="14" :fill="category.color" /><text x="60" y="14" font-size="19" fill="#526889">{{ category.label }} · ≥{{ category.min }} kt</text></g><line x1="18" y1="286" x2="60" y2="286" stroke="#7b8798" stroke-width="5" /><text x="74" y="293" font-size="19" fill="#526889">Wind unavailable</text><line x1="18" y1="316" x2="60" y2="316" stroke="#172f68" stroke-width="7" /><text x="74" y="323" font-size="19" fill="#526889">Provider mean</text></g>
      <text v-if="!meanPath.length && !memberLines.length" :x="view.left + view.width / 2" :y="view.top + view.height / 2" text-anchor="middle" font-size="28" fill="#71839e">No path points in this initialization</text>
      <text v-if="latestPoint" :x="view.left" y="1555" font-size="20" fill="#55718c">Forecast through +{{ latestPoint.forecast_hour }}h · peak member wind {{ maxWind.toFixed(1) }} kt</text>
    </svg>
  </div>
</template>

<style scoped>
.wm6-plot { width: 100%; margin-top: 10px; border: 1px solid #b7cedf; border-radius: 6px; overflow: hidden; background: #eaf4fb; }
.wm6-plot svg { display: block; width: 100%; height: auto; font-family: Arial, sans-serif; }
</style>
