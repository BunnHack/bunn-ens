<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import coastlines from '../data/north-pacific-land.json'
import { categories, windColor, type EnsembleData } from '../data/wnc2'

const props = withDefaults(defineProps<{ data: EnsembleData; maxLead?: number }>(), { maxLead: 312 })
const selectedMember = ref<number | null>(null)
const clipId = `wnc2-${useId().replace(/:/g, '')}`
const plot = computed(() => {
  if (props.data.trackId === 'WP272026' && props.data.initTime === '2026-10-12 06:00:00') return { left: 80, top: 86, width: 1710, height: 1506, west: 143.7, east: 183.6, south: 20.5, north: 55.6 }
  const points = props.data.members.flatMap(member => member.points)
  const lons = points.map(point => point.lon), lats = points.map(point => point.lat)
  const west = Math.floor((Math.min(...lons) - 3) / 5) * 5, east = Math.ceil((Math.max(...lons) + 3) / 5) * 5
  const south = Math.max(-90, Math.floor((Math.min(...lats) - 3) / 5) * 5), north = Math.min(90, Math.ceil((Math.max(...lats) + 3) / 5) * 5)
  return { left: 80, top: 86, width: 1710, height: 1506, west, east, south, north }
})
const x = (lon: number) => plot.value.left + (lon - plot.value.west) / (plot.value.east - plot.value.west) * plot.value.width
const y = (lat: number) => plot.value.top + (plot.value.north - lat) / (plot.value.north - plot.value.south) * plot.value.height
const ticks = (start: number, end: number) => Array.from({ length: Math.floor((end - start) / 5) + 1 }, (_, i) => start + i * 5)
const longitudeTicks = computed(() => ticks(Math.ceil(plot.value.west / 5) * 5, plot.value.east))
const latitudeTicks = computed(() => ticks(Math.ceil(plot.value.south / 5) * 5, plot.value.north))
const legend = [...categories, { label: 'Ens Mean', color: '#000000', min: 0 }]
const lands = computed(() => coastlines.map(ring => ring.map((point, index) => `${index ? 'L' : 'M'}${x(point[0]!).toFixed(2)},${y(point[1]!).toFixed(2)}`).join(' ') + 'Z'))
const mean = computed(() => props.data.mean.filter(point => point.leadHours <= props.maxLead && point.count >= Math.ceil(props.data.members.length * .25)))
const meanPath = computed(() => mean.value.map(point => `${x(point.lon)},${y(point.lat)}`).join(' '))
const markers = computed(() => mean.value.filter(point => point.leadHours > 0 && point.leadHours % (props.maxLead > 96 ? 48 : 24) === 0))
const start = computed(() => props.data.mean.find(point => point.leadHours === 0) ?? props.data.mean[0]!)
const maxMeanWind = computed(() => Math.max(0, ...mean.value.map(point => point.wind)))
const visibleMembers = computed(() => props.data.members.map(member => ({ ...member, maxWind: Math.max(0, ...member.points.filter(point => point.leadHours <= props.maxLead).map(point => point.wind)) })))
const segments = computed(() => props.data.members.flatMap(member => member.points.slice(1).filter(point => point.leadHours <= props.maxLead).map(point => {
  const previous = member.points[member.points.indexOf(point) - 1]!
  return { key: `${member.sample}-${point.leadHours}`, sample: member.sample, previous, point, color: windColor(previous.wind) }
})))
function toggleMember(sample: number) {
  selectedMember.value = selectedMember.value === sample ? null : sample
}
const selected = computed(() => visibleMembers.value.find(member => member.sample === selectedMember.value))
</script>

<template>
  <div class="wnc2-plot">
    <svg viewBox="0 0 2000 1640" xmlns="http://www.w3.org/2000/svg" role="img" :aria-label="`WN2-C ensemble forecast for ${data.trackId}: ${data.members.length} members initialized ${data.initTime} UTC`">
      <title>WN2-C Ensemble Forecast [{{ data.trackId }}]</title>
      <desc>Maximum 1-minute sustained wind speed colors. Black ensemble mean uses lead times with at least 25% of members remaining. Activate a member label to highlight its track.</desc>
      <defs><clipPath :id="clipId"><rect :x="plot.left" :y="plot.top" :width="plot.width" :height="plot.height" /></clipPath></defs>
      <rect width="2000" height="1640" fill="white" />
      <text x="80" y="38" font-size="31">WN2-C Ensemble Forecast [{{ data.trackId }}] Tropical Cyclone Track (Maximum 1-minute Sustained Wind Speed)</text>
      <text x="80" y="74" font-size="30">Initial time:{{ data.initTime.slice(0, 10) }}-{{ data.initTime.slice(11, 13) }}Z</text>
      <text x="1780" y="74" text-anchor="end" font-size="23">[lon,lat]=[{{ start.lon.toFixed(1) }},{{ start.lat.toFixed(1) }}]</text>
      <g :clip-path="`url(#${clipId})`">
        <path v-for="(land, index) in lands" :key="index" :d="land" fill="#e3e3e3" stroke="#707070" stroke-width="1.2" />
        <g stroke="#b9b9b9" stroke-width=".65" stroke-dasharray="1.5 1">
          <line v-for="lon in longitudeTicks" :key="`lon-${lon}`" :x1="x(lon)" :x2="x(lon)" :y1="plot.top" :y2="plot.top + plot.height" />
          <line v-for="lat in latitudeTicks" :key="`lat-${lat}`" :x1="plot.left" :x2="plot.left + plot.width" :y1="y(lat)" :y2="y(lat)" />
        </g>
        <g class="member-tracks">
          <line v-for="segment in segments" :key="segment.key" :data-sample="segment.sample" :x1="x(segment.previous.lon)" :y1="y(segment.previous.lat)" :x2="x(segment.point.lon)" :y2="y(segment.point.lat)" :stroke="segment.color" :stroke-width="selectedMember === segment.sample ? 5 : 2.5" :opacity="selectedMember === null || selectedMember === segment.sample ? 1 : .12">
            <title>Member {{ segment.sample + 1 }} · +{{ segment.point.leadHours }}h · {{ segment.point.wind.toFixed(1) }} kt · {{ segment.point.lat.toFixed(2) }}°N {{ segment.point.lon.toFixed(2) }}°E</title>
          </line>
        </g>
        <polyline class="ensemble-mean" :points="meanPath" fill="none" stroke="black" stroke-width="8" stroke-linejoin="round" />
        <g v-for="marker in markers" :key="marker.leadHours">
          <rect :x="x(marker.lon)-9" :y="y(marker.lat)-9" width="18" height="18" fill="black"><title>Mean +{{ marker.leadHours }}h · {{ marker.count }} members · {{ marker.wind.toFixed(1) }} kt</title></rect>
          <text :x="x(marker.lon)+20" :y="y(marker.lat)" font-size="31">+{{ marker.leadHours }}h</text>
        </g>
        <path :d="`M${x(start.lon)-10},${y(start.lat)-10}l20,20 M${x(start.lon)-10},${y(start.lat)+10}l20,-20`" stroke="black" stroke-width="4" />
      </g>
      <rect :x="plot.left" :y="plot.top" :width="plot.width" :height="plot.height" fill="none" stroke="black" stroke-width="1.5" />
      <g font-size="22">
        <text v-for="lon in longitudeTicks" :key="lon" :x="x(lon)" y="1620" text-anchor="middle">{{ lon === 180 ? '180°' : `${lon}°E` }}</text>
        <text v-for="lat in latitudeTicks" :key="lat" x="68" :y="y(lat)+8" text-anchor="end">{{ Math.abs(lat) }}°{{ lat < 0 ? 'S' : 'N' }}</text>
      </g>
      <g transform="translate(1568,96)">
        <rect width="213" height="258" fill="white" stroke="#ccc" stroke-width="2" rx="4" />
        <g v-for="(category, index) in legend" :key="category.label" :transform="`translate(12,${13 + index*27})`"><rect width="38" height="14" :fill="category.color" /><text x="53" y="14" font-size="19">{{ category.label }}</text></g>
      </g>
      <g class="member-labels" font-size="21">
        <g v-for="(member, index) in visibleMembers" :key="member.sample" :transform="`translate(1808,${95 + index*23.5})`" tabindex="0" role="button" :aria-label="`Highlight member ${member.sample + 1}, maximum ${member.maxWind.toFixed(1)} knots`" :aria-pressed="selectedMember === member.sample" @click="toggleMember(member.sample)" @keydown.enter.prevent="toggleMember(member.sample)" @keydown.space.prevent="toggleMember(member.sample)">
          <rect x="-4" y="-19" width="181" height="23" :fill="selectedMember === member.sample ? '#e9edf6' : 'transparent'" />
          <text :fill="windColor(member.maxWind)">Member{{ member.sample + 1 }}:{{ Math.floor(member.maxWind) }}kt</text>
        </g>
        <text x="1808" :y="95 + data.members.length*23.5" :fill="windColor(maxMeanWind)">Ens Mean:{{ Math.floor(maxMeanWind) }}kt</text>
      </g>
      <text x="110" y="1566" fill="#ff3030" font-size="22">WeatherNext 2 Cyclones (WN2-C), Google's AI cyclone forecasting model · {{ data.members.length }} members · 0–{{ maxLead }}h</text>
    </svg>
    <p v-if="selected" class="selected-member" role="status">Member {{ selected.sample + 1 }} · peak {{ selected.maxWind.toFixed(1) }} kt · {{ selected.points.length }} forecast positions <button @click="selectedMember = null">Show all</button></p>
  </div>
</template>

<style scoped>
.wnc2-plot { width: 100%; color: #000; }
svg { display: block; width: 100%; height: auto; font-family: Arial, sans-serif; }
.member-labels g { cursor: pointer; }
.member-labels g:focus { outline: none; }
.member-labels g:focus rect { stroke: #3658a3; stroke-width: 2; }
.selected-member { font-size: 11px; line-height: 1.6; color: #63708b; margin: 8px; }
.selected-member button { color: #3658a3; background: #eef2fa; padding: 5px 9px; border-radius: 5px; margin-left: 5px; font-size: 10px; }
</style>
