<script setup lang="ts">
import { ref } from 'vue'
import ForecastModels from './ForecastModels.vue'
import NcepPublishedCharts from './NcepPublishedCharts.vue'
withDefaults(defineProps<{active?:boolean}>(),{active:true})
const source=ref<'wm6'|'gefs'|'aigefs'>('wm6')
</script>
<template><div class="forecast-workspace"><nav aria-label="Forecast source" class="forecast-source-tabs"><button :aria-pressed="source==='wm6'" @click="source='wm6'">WM-6 原生格点成图</button><button :aria-pressed="source==='gefs'" @click="source='gefs'">GEFS · 31成员轨迹／强度图</button><button :aria-pressed="source==='aigefs'" @click="source='aigefs'">AIGEFS · 31成员轨迹／强度图</button></nav><ForecastModels v-if="source==='wm6'" :active="active"/><section v-else id="forecast-models" class="forecast-ncep"><h1 tabindex="-1">Forecast Models · {{ source.toUpperCase() }}</h1><NcepPublishedCharts :key="source" :model="source" :active="active"/><p>AIGEFS 为31成员集合，不是确定性AIGFS (L)。此处为workflow预制路径／强度图，不冒充未发布的GEFS地表格点天气场。</p></section></div></template>
<style scoped>.forecast-source-tabs{display:flex;gap:10px;flex-wrap:wrap;margin:16px 24px}.forecast-source-tabs button{font-size:12px;padding:9px 15px;border:1px solid #a9c8dc;border-radius:20px;color:#427c9e;background:white}.forecast-source-tabs button[aria-pressed="true"]{background:#2d7fa9;color:white}.forecast-ncep{margin:20px;background:white;padding:16px;border-radius:10px;min-width:0}.forecast-ncep h1{font-size:22px}.forecast-ncep>p{font-size:11px;color:#70899a;line-height:1.8}@media(max-width:600px){.forecast-source-tabs{margin:12px 10px}.forecast-ncep{margin:10px;padding:7px}}</style>
