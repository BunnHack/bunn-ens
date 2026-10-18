<script setup lang="ts">
import { ref, watch } from 'vue'
import BasinEnsemble from './BasinEnsemble.vue'
import ExtendedPotential from './ExtendedPotential.vue'
import TrackOverview from './TrackOverview.vue'
const props=withDefaults(defineProps<{section?:string;active?:boolean}>(),{section:'basin',active:true})
const visited=ref(new Set([props.section]))
watch(()=>props.section,s=>{visited.value=new Set([...visited.value,s])})
</script>
<template>
<section class="basin-workspace"><nav class="basin-workspace-tabs" aria-label="洋區系集預報功能"><strong>洋區系集預報</strong><a v-for="tab in [{id:'basin',label:'洋區系集'},{id:'extended',label:'中遠期襲擊潛勢'},{id:'overview',label:'預報洋區總覽'}]" :key="tab.id" :href="`#weather-tools/${tab.id}`" :aria-current="section===tab.id?'page':undefined">{{ tab.label }}</a></nav>
<BasinEnsemble v-if="visited.has('basin')" v-show="section==='basin'" :active="active&&section==='basin'" mode="basin"/>
<ExtendedPotential v-if="visited.has('extended')" v-show="section==='extended'" :active="active&&section==='extended'"/>
<TrackOverview v-if="visited.has('overview')" v-show="section==='overview'" :active="active&&section==='overview'"/>
</section>
</template>
<style scoped>.basin-workspace-tabs{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 0 16px}.basin-workspace-tabs strong{font-size:15px;color:#3a637f;margin-right:12px}.basin-workspace-tabs a{padding:9px 15px;border:1px solid #7ec8cc;color:#3a9aab;border-radius:20px;font-size:12px}.basin-workspace-tabs a[aria-current]{background:#ff713a;color:white;border-color:#ff713a}</style>
