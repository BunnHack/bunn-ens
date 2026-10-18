<script setup lang="ts">
import { computed, useId } from 'vue'
import { geographicPaths, visiblePlaces } from '../data/map-geography'
import { focusTrackRegion } from '../data/overview'
import { regionLongitude, type BasinRegion } from '../data/basin'
import { displayUtc, latestAnalysis, type CurrentStorm } from '../data/current-storms'
const props=defineProps<{storm:CurrentStorm;providerTime:string;historyHours:number;showForecast:boolean;checkedAt?:string;retained?:boolean}>()
const clip='current-storm-'+useId().replace(/:/g,'')
const current=computed(()=>latestAnalysis(props.storm,props.providerTime))
const points=computed(()=>props.storm.track.filter(p=>p.forecast?props.showForecast&&Date.parse(p.date)>Date.parse(props.providerTime):Date.parse(p.date)<=Date.parse(props.providerTime)&&(!props.historyHours||Date.parse(p.date)>=Date.parse(props.providerTime)-props.historyHours*3600000)))
const fallback:BasinRegion={id:'world',label:'Storm',west:100,east:180,south:0,north:55}
const region=computed(()=>focusTrackRegion(points.value.length?points.value:current.value?[current.value]:[],fallback))
const x=(lon:number)=>62+(regionLongitude(lon,region.value)-region.value.west)/(region.value.east-region.value.west)*1110
const y=(lat:number)=>85+(region.value.north-lat)/(region.value.north-region.value.south)*815
const lands=computed(()=>geographicPaths('land',region.value)),borders=computed(()=>geographicPaths('borders',region.value))
const step=computed(()=>region.value.east-region.value.west>45?10:5)
const lons=computed(()=>Array.from({length:Math.max(0,Math.floor(region.value.east/step.value)-Math.ceil(region.value.west/step.value)+1)},(_,i)=>(Math.ceil(region.value.west/step.value)+i)*step.value))
const lats=computed(()=>Array.from({length:Math.max(0,Math.floor(region.value.north/5)-Math.ceil(region.value.south/5)+1)},(_,i)=>(Math.ceil(region.value.south/5)+i)*5))
const segments=computed(()=>points.value.flatMap((p,i)=>{const before=points.value[i-1];return before&&Date.parse(p.date)>Date.parse(before.date)&&(Date.parse(p.date)-Date.parse(before.date))/3600000<=12&&Math.abs(x(p.lon)-x(before.lon))<850?[{before,point:p}]:[]}))
const labels=computed(()=>{const used:{x:number;y:number}[]=[];return points.value.filter((p,i)=>{if(i!==points.value.length-1&&p!==current.value&&new Date(p.date).getUTCHours()!==0)return false;const item={x:x(p.lon),y:y(p.lat)};if(used.some(a=>Math.abs(a.x-item.x)<90&&Math.abs(a.y-item.y)<28))return false;used.push(item);return true})})
const places=computed(()=>{const used:{x:number;y:number}[]=[];return visiblePlaces(region.value).filter(p=>{const q={x:x(p.lon),y:y(p.lat)};if(used.some(a=>Math.abs(a.x-q.x)<75&&Math.abs(a.y-q.y)<20))return false;used.push(q);return true}).slice(0,20)})
function longitude(lon:number){const n=((lon+180)%360+360)%360-180;return `${Math.abs(n)}°${n<0?'W':'E'}`}
</script>
<template>
<svg class="current-storm-map" viewBox="0 0 1200 1020" xmlns="http://www.w3.org/2000/svg" role="img" :aria-label="`${storm.title} analysis and forecast track`" style="background:#eef5fa;color:#42586e">
<title>{{ storm.title }} · {{ storm.id }} · Zoom Earth / {{ storm.agencies }}</title><desc>Source analysis points (blue) and separately identified forecast points (red); no line across gaps longer than 12h, no forecast cones or landfall markers. Wind kt, pressure hPa unchanged. Source IDs are not ATCF IDs. Provider clock {{ providerTime }}; selected data checked {{ checkedAt??'unavailable' }}. {{ retained?'Retained dated result, NOT confirmed fresh by this attempt.':'' }} {{ storm.centroid?'Disturbance positions are source centroids, not cyclone centres.':'' }}</desc>
<rect width="1200" height="1020" fill="#eef5fa"/><text x="62" y="32" font-size="23" fill="#284c71">{{ storm.title }} · {{ storm.name }}</text><text x="62" y="60" font-size="16" fill="#42586e">Latest analysis: {{ current ? displayUtc(current.date) : 'Unavailable' }} · {{ storm.agencies }} via Zoom Earth</text>
<defs><clipPath :id="clip"><rect x="62" y="85" width="1110" height="815"/></clipPath></defs>
<g :clip-path="`url(#${clip})`"><g fill="#dde6db" stroke="#839a9d" stroke-width="1"><path v-for="(d,i) in lands" :key="i" :d="d"/></g><g stroke="#b5c8cf" stroke-width=".8"><line v-for="lon in lons" :key="lon" :x1="x(lon)" :x2="x(lon)" y1="85" y2="900"/><line v-for="lat in lats" :key="lat" x1="62" x2="1172" :y1="y(lat)" :y2="y(lat)"/></g><g fill="none" stroke="#a4b3a6" stroke-width=".8"><path v-for="(d,i) in borders" :key="i" :d="d"/></g>
<g class="current-storm-segments"><line v-for="s in segments" :key="s.point.date" :x1="x(s.before.lon)" :x2="x(s.point.lon)" :y1="y(s.before.lat)" :y2="y(s.point.lat)" :stroke="s.point.forecast?'#cf5349':'#2c75ac'" stroke-width="4" stroke-linecap="round"/></g>
<g v-for="p in points" :key="p.date" class="current-storm-fix" :data-forecast="p.forecast"><circle :cx="x(p.lon)" :cy="y(p.lat)" :r="p===current?7:4" :fill="p.forecast?'#cf5349':'#2c75ac'" stroke="white" stroke-width="1.5"/><title>{{ p.forecast?'Forecast':'Analysis' }} · {{ displayUtc(p.date) }} · {{ p.lat }},{{ p.lon }} · {{ storm.centroid?'Source centroid; wind not a calm measurement':`${p.wind??'—'} kt` }} · {{ p.pressure??'—' }} hPa · {{ p.description }}</title></g>
<text v-for="p in labels" :key="p.date" :x="Math.min(1080,x(p.lon)+10)" :y="Math.max(108,y(p.lat)-10)" font-size="17" fill="#354f6c" stroke="#eef5fa" stroke-width="4" paint-order="stroke">{{ p.date.slice(5,10) }} {{ p.date.slice(11,13) }}Z</text>
<g v-for="p in places" :key="p.code"><circle :cx="x(p.lon)" :cy="y(p.lat)" r="2" fill="#60775e"/><text :x="x(p.lon)+5" :y="y(p.lat)-5" font-size="13" fill="#586956" stroke="#eef5fa" stroke-width="2" paint-order="stroke">{{ p.code }}</text></g></g>
<rect x="62" y="85" width="1110" height="815" fill="none" stroke="#7f9bab"/><text v-for="lon in lons" :key="lon" :x="x(lon)" y="925" text-anchor="middle" font-size="14" fill="#42586e">{{ longitude(lon) }}</text><text v-for="lat in lats" :key="lat" x="54" :y="y(lat)+5" text-anchor="end" font-size="14" fill="#42586e">{{ Math.abs(lat) }}°{{ lat<0?'S':'N' }}</text>
<g transform="translate(62,956)"><line x2="35" stroke="#2c75ac" stroke-width="4"/><text x="45" y="5" font-size="17" fill="#42586e">分析路径 / Analysis</text><line x1="300" x2="335" stroke="#cf5349" stroke-width="4"/><text x="345" y="5" font-size="17" fill="#42586e">来源预报 / Forecast</text></g>
<text x="62" y="979" font-size="13" fill="#42586e">Provider UTC {{ displayUtc(providerTime) }} · Checked {{ checkedAt?displayUtc(checkedAt):'unavailable' }}{{ retained?' · RETAINED / NOT confirmed fresh':'' }}</text>
<text x="62" y="1003" font-size="14" fill="#42586e">Zoom Earth / {{ storm.agencies }} · {{ storm.id }} · Natural Earth 1:50m · Not an official warning</text>
</svg>
</template>
<style scoped>.current-storm-map{display:block;width:100%;height:auto}</style>
