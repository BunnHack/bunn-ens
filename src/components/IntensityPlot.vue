<script setup lang="ts">
import { computed, useId } from 'vue'
import type { IntensityMetric, IntensitySeries } from '../data/intensity'
const props=defineProps<{ series: IntensitySeries[]; cyclone: string; metric: IntensityMetric }>()
const clip=`intensity-${useId().replace(/:/g,'')}`
const points=computed(()=>props.series.flatMap(series=>series.points))
const minimumTime=computed(()=>Math.floor(Math.min(...points.value.map(point=>point.time))/21600000)*21600000)
const maximumTime=computed(()=>Math.max(minimumTime.value+21600000,Math.ceil(Math.max(...points.value.map(point=>point.time))/21600000)*21600000))
const step=computed(()=>{const values=points.value.map(point=>point.value),range=props.metric==='wind'?Math.max(20,...values):Math.max(5,Math.max(...values)-Math.min(...values));return [1,2,5,10,20,50,100,200,500,1000].find(step=>step>=range/7)??1000})
const low=computed(()=>props.metric==='wind'?0:Math.floor((Math.min(...points.value.map(point=>point.value))-2)/step.value)*step.value)
const high=computed(()=>Math.max(low.value+step.value,Math.ceil((Math.max(...points.value.map(point=>point.value))+2)/step.value)*step.value))
const yTicks=computed(()=>Array.from({length:Math.min(20,Math.round((high.value-low.value)/step.value)+1)},(_,i)=>low.value+i*step.value))
const xTicks=computed(()=>{const interval=maximumTime.value-minimumTime.value>8*86400000?48*3600000:24*3600000;return Array.from({length:Math.floor((maximumTime.value-minimumTime.value)/interval)+1},(_,i)=>minimumTime.value+i*interval)})
const x=(time:number)=>80+(time-minimumTime.value)/(maximumTime.value-minimumTime.value)*885
const y=(value:number)=>props.metric==='wind'?420-(value-low.value)/(high.value-low.value)*330:90+(value-low.value)/(high.value-low.value)*330
const curves=computed(()=>props.series.map(series=>({...series,segments:series.points.slice(1).flatMap((point,index)=>{const previous=series.points[index]!;return point.time>previous.time&&point.time-previous.time<=12*3600000?[{point,previous}]:[]})})))
const label=(time:number)=>new Date(time).toISOString().slice(5,16).replace('T',' ')
const unit=computed(()=>props.metric==='wind'?'kt':'hPa')
const compact=(raw:string)=>raw.replace('T',' ').replace(/:00\.000Z$/,'Z')
</script>

<template>
  <svg v-if="points.length" class="intensity-chart" viewBox="0 0 1000 565" xmlns="http://www.w3.org/2000/svg" role="img" :aria-label="`${cyclone} WNC2 WNC3 WM-6 ensemble mean ${metric}, valid time in UTC`" style="background:#fff;color:#294459">
    <title>{{ cyclone }} · Ensemble-mean {{ metric === 'wind' ? 'member maximum wind (kt)' : 'member minimum MSLP (hPa)' }}</title>
    <desc>Genuine matched cyclone {{ cyclone }} only. {{ metric === 'wind' ? 'Original cyclone wind fields in kt, without pressure-derived wind or adjustment.' : 'Original cyclone minimum pressure fields in hPa, without pressure-to-wind conversion.' }} Member means are conditional arithmetic means of distinct reporting members, at least two and 25% of the full available ensemble. Missing values and untracked members are not zero. Models are aligned by absolute UTC valid time, not equal forecast lead; WM-6 uses forecast_zero + forecast_hour, never provider initialization or wall clock. No interpolation across missing mean intervals greater than 12h. Provider mean, when enabled, is separate and not relabelled as a member calculation. Model wind definitions may differ and are not calibrated. {{ series.map(item => `${item.label}: provider init ${item.initializationTime}, forecast zero ${item.forecastZero}, N=${item.denominator}, definition=${item.definition}, source=${item.source}, checkedAt=${item.checkedAt}; ` + item.points.map(point => `${point.validTime} +${point.leadHours}h=${point.value}${unit}, n=${point.count ?? 'unknown'}`).join('; ')).join(' | ') }}</desc>
    <rect width="1000" height="565" fill="white" />
    <text x="80" y="29" font-size="21" font-weight="bold" fill="currentColor">{{ cyclone }} · Ensemble-mean {{ metric === 'wind' ? 'intensity (kt)' : 'minimum pressure (hPa)' }}</text>
    <g v-for="(item,i) in series" :key="item.key" :transform="`translate(${80+i*225},55)`"><line x1="0" x2="30" :stroke="item.color" stroke-width="3" :stroke-dasharray="item.definition === 'provider_mean' ? '3 4' : item.model === 'wn3' ? '9 3' : undefined" /><text x="39" y="5" font-size="14" :fill="item.color">{{ item.label }}</text></g>
    <rect x="80" y="90" width="885" height="330" fill="#ededed" />
    <defs><clipPath :id="clip"><rect x="80" y="90" width="885" height="330" /></clipPath></defs>
    <g fill="#53697d" font-size="13"><g v-for="value in yTicks" :key="value"><line x1="80" x2="965" :y1="y(value)" :y2="y(value)" stroke="#fff" stroke-dasharray="4 3" /><text x="69" :y="y(value)+4" text-anchor="end">{{ value }}</text></g><g v-for="time in xTicks" :key="time"><line :x1="x(time)" :x2="x(time)" y1="90" y2="420" stroke="#fff" stroke-dasharray="4 3" /><text :x="x(time)" y="441" :text-anchor="x(time) > 925 ? 'end' : 'middle'">{{ label(time) }}</text></g></g>
    <rect x="80" y="90" width="885" height="330" fill="none" stroke="#8496a5" />
    <text x="25" y="255" transform="rotate(-90 25 255)" text-anchor="middle" font-size="14" fill="currentColor">{{ metric === 'wind' ? 'Member maximum wind mean (kt)' : 'Member minimum MSLP mean (hPa, inverted)' }}</text>
    <text x="520" y="462" text-anchor="middle" font-size="13" fill="#4e6579">Valid time (UTC) · model forecast bases may differ</text>
    <g :clip-path="`url(#${clip})`"><g v-for="item in curves" :key="item.key" class="intensity-model-curve" :data-model="item.model" :data-definition="item.definition"><line v-for="segment in item.segments" :key="segment.point.time" :x1="x(segment.previous.time)" :x2="x(segment.point.time)" :y1="y(segment.previous.value)" :y2="y(segment.point.value)" :stroke="item.color" stroke-width="2.7" :stroke-dasharray="item.definition === 'provider_mean' ? '3 4' : item.model === 'wn3' ? '9 3' : undefined" /><circle v-for="point in item.points" :key="point.time" class="intensity-fix" :cx="x(point.time)" :cy="y(point.value)" :r="item.definition === 'provider_mean' ? 2 : 3" :fill="item.color"><title>{{ item.label }} · {{ point.validTime }} · +{{ point.leadHours }}h · {{ point.value.toFixed(2) }} {{ unit }} · valid n={{ point.count ?? 'unknown' }}/{{ item.denominator }}{{ point.min == null ? '' : ` · member range ${point.min.toFixed(1)}–${point.max!.toFixed(1)} ${unit}` }}</title></circle></g></g>
    <text v-for="(item,i) in series" :key="item.key" x="80" :y="485+i*18" font-size="11" :fill="item.source === 'snapshot' ? '#ad5d23' : '#506c80'">{{ item.label }} · {{ item.model === 'wm6' ? 'Provider run' : 'Init' }} {{ compact(item.initializationTime) }} · Forecast base {{ compact(item.forecastZero) }} · N={{ item.denominator }}{{ item.source === 'snapshot' ? ' · DATED SNAPSHOT, NOT LATEST' : '' }}</text>
    <text x="80" y="559" font-size="10" fill="#596e7e">Conditional on reported storm members; missing ≠ zero. Raw units, no wind-pressure correction. Local comparison, not an official intensity forecast.</text>
  </svg>
  <p v-else>沒有可用強度點，不補造曲線或時間。</p>
</template>

<style scoped>
.intensity-chart { display: block; width: 100%; height: auto; font-family: Arial, sans-serif; }
</style>
