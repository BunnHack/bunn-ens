<script setup lang="ts">
import { computed, useId } from 'vue'
import { geographicPaths, visiblePlaces } from '../data/map-geography'
import { focusTrackRegion } from '../data/overview'
import { regionLongitude, type BasinRegion } from '../data/basin'
import { categories, windCategory } from '../data/wnc2'
import { displayUtc, latestAnalysis, type CurrentStorm, type StormFix, type SourceGeometry } from '../data/current-storms'
const props=defineProps<{storm:CurrentStorm;providerTime:string;historyHours:number;showForecast:boolean;checkedAt?:string;retained?:boolean}>()
const clip='current-storm-'+useId().replace(/:/g,'')
const current=computed(()=>latestAnalysis(props.storm,props.providerTime))
const points=computed(()=>props.storm.track.filter(p=>p.forecast?props.showForecast&&Date.parse(p.date)>Date.parse(props.providerTime):Date.parse(p.date)<=Date.parse(props.providerTime)&&(!props.historyHours||Date.parse(p.date)>=Date.parse(props.providerTime)-props.historyHours*3600000)))
const cone=computed(()=>props.showForecast&&(props.storm.cone?.length??0)>=3?props.storm.cone!:[])
const fallback:BasinRegion={id:'world',label:'Storm',west:100,east:180,south:0,north:55}
const region=computed(()=>focusTrackRegion([...points.value,...cone.value.map(([lon,lat])=>({lon,lat}))],fallback))
const x=(lon:number)=>62+(regionLongitude(lon,region.value)-region.value.west)/(region.value.east-region.value.west)*1110
const y=(lat:number)=>85+(region.value.north-lat)/(region.value.north-region.value.south)*815
const lands=computed(()=>geographicPaths('land',region.value)),borders=computed(()=>geographicPaths('borders',region.value))
const step=computed(()=>region.value.east-region.value.west>45?10:5)
const lons=computed(()=>Array.from({length:Math.max(0,Math.floor(region.value.east/step.value)-Math.ceil(region.value.west/step.value)+1)},(_,i)=>(Math.ceil(region.value.west/step.value)+i)*step.value))
const lats=computed(()=>Array.from({length:Math.max(0,Math.floor(region.value.north/5)-Math.ceil(region.value.south/5)+1)},(_,i)=>(Math.ceil(region.value.south/5)+i)*5))
function geometryPath(geometry:SourceGeometry,close=false){if(geometry.some((p,i)=>i>0&&Math.abs(x(p[0])-x(geometry[i-1]![0]))>850))return '';return geometry.map(([lon,lat],i)=>`${i?'L':'M'}${x(lon)},${y(lat)}`).join(' ')+(close?' Z':'')}
const conePath=computed(()=>geometryPath(cone.value,true))
const segments=computed(()=>points.value.flatMap((p,i)=>{
 const before=points.value[i-1];if(!before||Date.parse(p.date)<=Date.parse(before.date)||Math.abs(x(p.lon)-x(before.lon))>=850)return []
 const spline=p.spline,first=spline?.[0],last=spline?.[spline.length-1]
 const source=!!first&&!!last&&Math.abs(first[0]-before.lon)<.05&&Math.abs(first[1]-before.lat)<.05&&Math.abs(last[0]-p.lon)<.05&&Math.abs(last[1]-p.lat)<.05
 const hours=(Date.parse(p.date)-Date.parse(before.date))/3600000
 // Late official forecasts use 24h spacing. Draw only their verified native spline, never synthesize that gap.
 if(hours>12&&!(hours===24&&before.forecast&&p.forecast&&source))return []
 return [{before,point:p,source,d:geometryPath(source?spline!:[[before.lon,before.lat],[p.lon,p.lat]])}]
}))
const color=(p:StormFix)=>props.storm.centroid?'#7b8798':windCategory(p.wind)?.color??'#7b8798'
const labels=computed(()=>{const used:{x:number;y:number}[]=[];return points.value.filter((p,i)=>{if(i!==points.value.length-1&&p!==current.value&&new Date(p.date).getUTCHours()!==0)return false;const item={x:x(p.lon),y:y(p.lat)};if(used.some(a=>Math.abs(a.x-item.x)<90&&Math.abs(a.y-item.y)<28))return false;used.push(item);return true})})
const places=computed(()=>{const used:{x:number;y:number}[]=[];return visiblePlaces(region.value).filter(p=>{const q={x:x(p.lon),y:y(p.lat)};if(used.some(a=>Math.abs(a.x-q.x)<75&&Math.abs(a.y-q.y)<20))return false;used.push(q);return true}).slice(0,20)})
function longitude(lon:number){const n=((lon+180)%360+360)%360-180;return `${Math.abs(n)}°${n<0?'W':'E'}`}
</script>
<template>
<svg class="current-storm-map" viewBox="0 0 1200 1060" xmlns="http://www.w3.org/2000/svg" role="img" :aria-label="`${storm.name} analysis and forecast track`" style="background:#eef5fa;color:#42586e">
<title>{{ storm.name }} · {{ storm.id }} · Zoom Earth / {{ storm.agencies }}</title><desc>Actual source analysis/forecast fixes. Native kt/hPa and existing category thresholds/colours unchanged. Only genuine provider cone and spline coordinates, no locally invented cone or smoothing; no connection across gaps longer than 12h. Forecast points have dark outlines. Original ID {{ storm.id }} is not an ATCF ID. Provider {{ providerTime }}; checked {{ checkedAt??'unavailable' }}. {{ retained?'Retained dated result, NOT confirmed fresh.':'' }} {{ storm.centroid?'Disturbance centroid, original wind=0 is not a calm measurement.':'' }}</desc>
<rect width="1200" height="1060" fill="#eef5fa"/><text x="62" y="32" font-size="23" fill="#284c71">{{ storm.name }}</text><text x="62" y="60" font-size="16" fill="#42586e">Latest analysis: {{ current ? displayUtc(current.date) : 'Unavailable' }} · {{ storm.agencies }} via Zoom Earth</text>
<defs><clipPath :id="clip"><rect x="62" y="85" width="1110" height="815"/></clipPath></defs>
<g :clip-path="`url(#${clip})`"><g fill="#dde6db" stroke="#839a9d" stroke-width="1"><path v-for="(d,i) in lands" :key="i" :d="d"/></g><g stroke="#b5c8cf" stroke-width=".8"><line v-for="lon in lons" :key="lon" :x1="x(lon)" :x2="x(lon)" y1="85" y2="900"/><line v-for="lat in lats" :key="lat" x1="62" x2="1172" :y1="y(lat)" :y2="y(lat)"/></g><g fill="none" stroke="#a4b3a6" stroke-width=".8"><path v-for="(d,i) in borders" :key="i" :d="d"/></g>
<path v-if="conePath&&cone.length" class="current-storm-source-cone" :d="conePath" fill="#7a8897" fill-opacity=".16" stroke="#677a8b" stroke-width="1.6"><title>Zoom Earth / {{ storm.agencies }} actual source cone · {{ cone.length }} original vertices · not a locally computed probability or ensemble envelope</title></path>
<g class="current-storm-segments"><path v-for="s in segments" :key="s.point.date" :d="s.d" :data-source-spline="s.source" :stroke="color(s.before)" fill="none" stroke-width="5" stroke-linecap="round"/></g>
<g v-for="p in points" :key="p.date" class="current-storm-fix" :data-forecast="p.forecast"><circle :cx="x(p.lon)" :cy="y(p.lat)" :r="p===current?10:7" :fill="color(p)" :stroke="p.forecast?'#394e61':'white'" stroke-width="2"/><title>{{ p.forecast?'Forecast':'Analysis' }} · {{ displayUtc(p.date) }} · {{ p.lat }},{{ p.lon }} · {{ storm.centroid?'Source centroid; wind not a calm measurement':`${p.wind??'—'} kt` }} · {{ p.pressure??'—' }} hPa · {{ p.description }}</title></g>
<text v-for="p in labels" :key="p.date" :x="Math.min(1080,x(p.lon)+12)" :y="Math.max(108,y(p.lat)-12)" font-size="17" fill="#354f6c" stroke="#eef5fa" stroke-width="4" paint-order="stroke">{{ p.date.slice(5,10) }} {{ p.date.slice(11,13) }}Z</text>
<g v-for="p in places" :key="p.code"><circle :cx="x(p.lon)" :cy="y(p.lat)" r="2" fill="#60775e"/><text :x="x(p.lon)+5" :y="y(p.lat)-5" font-size="13" fill="#586956" stroke="#eef5fa" stroke-width="2" paint-order="stroke">{{ p.code }}</text></g></g>
<rect x="62" y="85" width="1110" height="815" fill="none" stroke="#7f9bab"/><text v-for="lon in lons" :key="lon" :x="x(lon)" y="925" text-anchor="middle" font-size="14" fill="#42586e">{{ longitude(lon) }}</text><text v-for="lat in lats" :key="lat" x="54" :y="y(lat)+5" text-anchor="end" font-size="14" fill="#42586e">{{ Math.abs(lat) }}°{{ lat<0?'S':'N' }}</text>
<g v-for="(c,i) in categories" :key="c.label" :transform="`translate(${62+(i%4)*275},${953+Math.floor(i/4)*25})`"><rect width="14" height="14" :fill="c.color"/><text x="21" y="12" font-size="13" fill="#42586e">{{ c.label }} ≥{{ c.min }}kt</text></g>
<text x="62" y="1013" font-size="13" fill="#42586e">原始kt风级着色 · 白边=分析，深色边=来源预报 · 灰色区域仅来源原生cone（有提供时）</text>
<text x="62" y="1033" font-size="12" fill="#42586e">Provider {{ displayUtc(providerTime) }} · Checked {{ checkedAt?displayUtc(checkedAt):'unavailable' }}{{ retained?' · RETAINED / NOT confirmed fresh':'' }}</text>
<text x="62" y="1052" font-size="12" fill="#42586e">Zoom Earth / {{ storm.agencies }} · Natural Earth 1:50m · Not an official warning</text>
</svg>
</template>
<style scoped>.current-storm-map{display:block;width:100%;height:auto}</style>
