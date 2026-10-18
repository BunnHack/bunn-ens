<script setup lang="ts">
import { computed, useId } from 'vue'
import type { OverviewTrack } from '../data/overview'
import type { BasinRegion } from '../data/basin'
import { regionLongitude } from '../data/basin'
import { geographicPaths } from '../data/map-geography'
const props=defineProps<{tracks:OverviewTrack[];region:BasinRegion;base:string;cyclone:string}>()
const clip='overview-'+useId().replace(/:/g,'')
const x=(lon:number)=>65+(regionLongitude(lon,props.region)-props.region.west)/(props.region.east-props.region.west)*1470
const y=(lat:number)=>95+(props.region.north-lat)/(props.region.north-props.region.south)*900
const lands=computed(()=>geographicPaths('land',props.region)),borders=computed(()=>geographicPaths('borders',props.region))
// geographicPaths uses the shared map's 62..1172 / 85..900 projection.
const geographyTransform='translate(-17.1,1.14) scale(1.3243243,1.1042945)'
const lons=computed(()=>Array.from({length:Math.max(0,Math.floor(props.region.east/5)-Math.ceil(props.region.west/5)+1)},(_,i)=>(Math.ceil(props.region.west/5)+i)*5))
const lats=computed(()=>Array.from({length:Math.max(0,Math.floor(props.region.north/5)-Math.ceil(props.region.south/5)+1)},(_,i)=>(Math.ceil(props.region.south/5)+i)*5))
const curves=computed(()=>props.tracks.map(t=>({...t,segments:t.points.slice(1).flatMap((p,i)=>{const a=t.points[i]!;return p.leadHours>a.leadHours&&p.leadHours-a.leadHours<=12&&Math.abs(regionLongitude(p.lon,props.region)-regionLongitude(a.lon,props.region))<180?[{a,p}]:[]})})))
</script>
<template>
<svg class="track-overview-plot" viewBox="0 0 1600 1160" xmlns="http://www.w3.org/2000/svg" role="img" :aria-label="`${cyclone} multi-model forecast track overview`" style="background:white;font-family:Arial,sans-serif">
<title>{{ cyclone }} · Multi-Model Tropical Cyclone Track Forecast Overview</title><desc>Genuine matched ATCF ID {{ cyclone }} only. No unavailable model curves, local G identities, cones or landfalls. Track labels are hours from common UTC base {{ base }}, not each model's individual +h. {{ tracks.map(t=>`${t.label}: provider/model run ${t.initialization}; forecast base ${t.forecastZero}; ${t.source}; `+t.points.map(p=>`${p.leadHours}h ${p.lat},${p.lon} n=${p.count}`).join('; ')).join(' | ') }}</desc>
<rect x="65" y="95" width="1470" height="900" fill="#edfaff"/>
<defs><clipPath :id="clip"><rect x="65" y="95" width="1470" height="900"/></clipPath></defs>
<text x="800" y="34" font-size="27" text-anchor="middle" font-weight="bold">Multi-Model Tropical Cyclone Track Forecast Overview</text><text x="800" y="65" font-size="22" text-anchor="middle">{{ cyclone }} · Common forecast base: {{ base }}</text>
<g :clip-path="`url(#${clip})`"><g :transform="geographyTransform"><path v-for="(p,i) in lands" :key="'l'+i" :d="p" fill="#faf6ed" stroke="#8d8b80" stroke-width=".65"/><path v-for="(p,i) in borders" :key="'b'+i" :d="p" fill="none" stroke="#b3a994" stroke-width=".6"/></g>
<g stroke="#a6bdc7" stroke-width=".7" stroke-dasharray="2 3"><line v-for="v in lons" :key="'x'+v" :x1="x(v)" :x2="x(v)" y1="95" y2="995"/><line v-for="v in lats" :key="'y'+v" x1="65" x2="1535" :y1="y(v)" :y2="y(v)"/></g>
<g v-for="t in curves" :key="t.model" class="overview-model" :data-model="t.model"><line v-for="s in t.segments" :key="s.p.leadHours" :x1="x(s.a.lon)" :y1="y(s.a.lat)" :x2="x(s.p.lon)" :y2="y(s.p.lat)" :stroke="t.color" stroke-width="3.2"/><g v-for="p in t.points.filter(p=>p.leadHours%24===0)" :key="p.leadHours"><rect :x="x(p.lon)-4" :y="y(p.lat)-4" width="8" height="8" :fill="t.color"/><text :x="x(p.lon)+7" :y="y(p.lat)-8" font-size="15" :fill="t.color">{{ p.leadHours }}<title>{{ t.label }} · {{ new Date(Date.parse(base)+p.leadHours*3600000).toISOString() }} · n={{ p.count }}</title></text></g></g></g>
<rect x="65" y="95" width="1470" height="900" fill="none" stroke="#333" stroke-width="2"/>
<g font-size="18"><text v-for="v in lons" :key="v" :x="x(v)" y="1022" text-anchor="middle">{{ ((v+180)%360+360)%360-180 }}°</text><text v-for="v in lats" :key="v" x="55" :y="y(v)+5" text-anchor="end">{{ v }}°</text></g>
<g v-for="(t,i) in tracks" :key="t.model" :transform="`translate(${70+i*380},1055)`"><line x1="0" x2="32" :stroke="t.color" stroke-width="4"/><text x="42" y="6" font-size="20" :fill="t.color">{{ t.label }}</text><text y="35" font-size="14">{{ t.model==='wm6'?'Provider run:':'Model init:' }} {{ t.initialization }} UTC</text><text y="53" font-size="12">Forecast base: {{ t.forecastZero }}</text></g>
<text x="65" y="1122" font-size="15">Only published genuine means; different model runs remain identified. Missing models are not replaced.</text><text x="65" y="1145" font-size="14">Labels: hours from common UTC base above. Natural Earth 1:50m. Nonofficial guidance; no cross-model composite mean.</text>
</svg>
</template>
<style scoped>.track-overview-plot{display:block;width:100%;height:auto}</style>
