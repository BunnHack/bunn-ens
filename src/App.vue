<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import WeatherTools from './components/WeatherTools.vue'
import ForecastModels from './components/ForecastWorkspace.vue'
import CurrentStorms from './components/CurrentStorms.vue'
import IntensityGuidance from './components/IntensityGuidance.vue'
import Wnc2Ensemble from './components/Wnc2Ensemble.vue'
import Wm6Ensemble from './components/Wm6Ensemble.vue'
import NcepPublishedCharts from './components/NcepPublishedCharts.vue'
import SurfaceForecastCard from './components/SurfaceForecastCard.vue'
import type { CurrentSelection } from './data/current-selection'
const selection=ref<CurrentSelection>({storm:null,storms:[],providerTime:''})
const currentHash=ref(window.location.hash)
const weatherToolsOpen=computed(()=>/^#weather-tools(?:\/|$)/.test(currentHash.value))
const forecastModelsOpen=computed(()=>currentHash.value==='#forecast-models')
const currentOpen=computed(()=>!weatherToolsOpen.value&&!forecastModelsOpen.value)
const weatherToolsVisited=ref(weatherToolsOpen.value),forecastModelsVisited=ref(forecastModelsOpen.value)
const weatherToolId=computed(()=>currentHash.value.startsWith('#weather-tools/')?currentHash.value.slice('#weather-tools/'.length):undefined)
const settingsOpen=ref(false),acronymsOpen=ref(false),informationOpen=ref(false),compact=ref(false),nativeOpen=ref(false),nativeVisited=ref(false)
const dialogOpen=computed(()=>settingsOpen.value||acronymsOpen.value)
const navigation=[{label:'Current Storms',href:'#main-content'},{label:'Weather Tools',href:'#weather-tools'},{label:'Satellite Imagery',href:'https://www.tropicaltidbits.com/sat/'},{label:'Forecast Models',href:'#forecast-models'},{label:'Analysis Tools',href:'https://www.tropicaltidbits.com/analysis/'},{label:'About',href:'https://www.tropicaltidbits.com/about.html'}]
let previousFocus:HTMLElement|null=null
function closeDialogs(){settingsOpen.value=false;acronymsOpen.value=false}
watch(dialogOpen,async open=>{if(open){previousFocus=document.activeElement as HTMLElement;await nextTick();document.querySelector<HTMLElement>('[aria-label="Close dialog"]')?.focus()}else previousFocus?.focus()})
function trapDialog(event:KeyboardEvent){if(event.key!=='Tab')return;const nodes=[...document.querySelectorAll<HTMLElement>('.dialog button,.dialog input,.dialog a')];const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}
async function onHashChange(){currentHash.value=window.location.hash;if(weatherToolsOpen.value)weatherToolsVisited.value=true;if(forecastModelsOpen.value)forecastModelsVisited.value=true;closeDialogs();await nextTick();const selector=weatherToolsOpen.value?'#weather-tools':forecastModelsOpen.value?'#forecast-models':currentHash.value==='#models-title'?'#models-title':'#main-content';document.querySelector<HTMLElement>(selector+' h1')?.focus({preventScroll:true});document.querySelector(selector)?.scrollIntoView?.({block:'start'})}
function onNativeToggle(event:Event){nativeOpen.value=(event.target as HTMLDetailsElement).open;if(nativeOpen.value)nativeVisited.value=true}
onMounted(()=>window.addEventListener('hashchange',onHashChange))
onBeforeUnmount(()=>window.removeEventListener('hashchange',onHashChange))
</script>
<template>
<div class="site-shell" :class="{compact}" @keydown.esc="closeDialogs">
<header class="site-header"><a class="brand" href="#main-content" aria-label="Tropical Tidbits home"><span class="brand-icon material-icons-round" aria-hidden="true">cyclone</span><span>Tropical <strong>Tidbits</strong></span></a><nav class="main-navigation" aria-label="Main navigation"><a v-for="(item,index) in navigation" :key="item.label" class="nav-link" :class="{current:index===0?currentOpen:index===1?weatherToolsOpen:index===3?forecastModelsOpen:false}" :aria-current="(index===0&&currentOpen)||(index===1&&weatherToolsOpen)||(index===3&&forecastModelsOpen)?'page':undefined" :href="item.href" :target="item.href.startsWith('https:')?'_blank':undefined" :rel="item.href.startsWith('https:')?'noopener noreferrer':undefined">{{ item.label }}</a></nav></header>
<WeatherTools v-if="weatherToolsVisited" v-show="weatherToolsOpen" :tool-id="weatherToolId"/>
<ForecastModels v-if="forecastModelsVisited" v-show="forecastModelsOpen" :active="forecastModelsOpen" :selection="selection"/>
<main v-show="currentOpen" id="main-content"><section class="page-title-row"><div><p class="eyebrow">TROPICAL CYCLONE MONITORING</p><h1>Global Tropical Cyclone and Disturbance Information</h1></div><div class="page-actions"><a class="support-button" href="https://www.tropicaltidbits.com/" target="_blank" rel="noopener noreferrer">Support Tropical Tidbits</a><button class="icon-button" aria-label="Display settings" @click="settingsOpen=true"><span class="material-icons-round" aria-hidden="true">settings</span></button></div></section>
<div class="information-panel"><button class="information-toggle" :aria-expanded="informationOpen" aria-controls="data-information" @click="informationOpen=!informationOpen"><span class="material-icons-round" aria-hidden="true">info_outline</span><span>Information about this data</span><span class="material-icons-round disclosure-icon" :class="{expanded:informationOpen}" aria-hidden="true">expand_more</span></button><div v-if="informationOpen" id="data-information" class="information-content">Current Storm 保留来源原始kt/hPa及实际cone/spline；不构造几何或猜测风压。不按 Zoom 名字或编号尾数自动配对。GEFS/AIGEFS由workflow产图，不在浏览器下载GRIB。各模型独立保留原始编号、起报和UTC；只有唯一、足量同UTC位置核对才作非官方对照，否则独立选择。集合统计不含预报锥或登陆点。请以原气象机构警报为准。</div></div>
<CurrentStorms :active="currentOpen" @selection="selection=$event"/>
<section class="models-section" aria-labelledby="models-title"><div class="models-heading"><h2 id="models-title">Model Forecasts</h2><button class="text-button" @click="acronymsOpen=true">List of model acronyms<span class="material-icons-round" aria-hidden="true">help_outline</span></button></div><nav class="current-model-links" aria-label="Cyclone model guidance"><a href="#weather-tools/overview">预报洋区总览 ↗</a><a href="#weather-tools/extended">中远期袭击潜势 ↗</a><a href="#forecast-models">Forecast Models ↗</a></nav>
<div class="home-restored-grid"><article class="forecast-card card home-global-models"><div class="forecast-heading"><h3>Global + Hurricane Models</h3><p>{{ selection.storm?.name??'等待Current Storm' }} · GEFS / AIGEFS 31成员</p></div><NcepPublishedCharts :active="currentOpen" :selection="selection" mode="typhoon"/></article><SurfaceForecastCard :active="currentOpen"/><article class="forecast-card card home-wnc2"><div class="forecast-heading"><h3>WNC2 Ensembles</h3><p>{{ selection.storm?.name??'等待Current Storm' }} · WeatherNext 2 Cyclones</p></div><Wnc2Ensemble :active="currentOpen" :selection="selection"/></article></div>
<article class="forecast-card card intensity-live-card"><div class="forecast-heading"><h3>Intensity Guidance</h3><p>{{ selection.storm?.name??'等待Current Storm' }} · 风速统一显示kt／气压hPa</p></div><IntensityGuidance :active="currentOpen" :selection="selection"/></article>
<details class="current-native-guidance" @toggle="onNativeToggle"><summary>WM-6 独立原始路径指引</summary><p>各模式使用自身原始编号，不代表已与上方Zoom系统配对；不因来源失败补造路径。</p><div v-if="nativeVisited" class="forecast-grid"><article class="forecast-card card"><div class="forecast-heading"><h3>WM-6 Ensemble</h3><p>WindBorne tropical cyclone ensemble tracker</p></div><Wm6Ensemble :active="currentOpen&&nativeOpen"/></article></div></details>
</section><footer><span>Zoom Earth / source agencies · WeatherNext / WindBorne / model sources</span><span>Reference guidance, not an official warning</span></footer></main>
<div v-if="dialogOpen" class="dialog-backdrop" @click.self="closeDialogs"><dialog open class="dialog" aria-modal="true" aria-labelledby="dialog-title" @keydown="trapDialog"><div class="dialog-heading"><h2 id="dialog-title">{{ settingsOpen?'Display settings':'Model acronyms' }}</h2><button class="icon-button" aria-label="Close dialog" @click="closeDialogs"><span class="material-icons-round" aria-hidden="true">close</span></button></div><template v-if="settingsOpen"><label class="setting-row"><span><strong>Compact spacing</strong><small>Reduce padding between information panels.</small></span><input v-model="compact" type="checkbox"/></label><p class="dialog-copy">Display settings do not change source data.</p></template><dl v-else class="acronyms"><div><dt>WNC2 / WNC3 / GENC</dt><dd>WeatherNext 2 Cyclones / WeatherNext WNV3 / OPER CSV; conditional member means are separately identified.</dd></div><div><dt>WM-6</dt><dd>WindBorne tracker; original wind kt, pressure hPa; Provider run and forecast_zero remain separate.</dd></div><div><dt>WMC AI / SD3 / AIGFS</dt><dd>AI individual paths / native SD3 / locally derived AIGFS low-pressure centres, not ensemble consensus. SD3: TianJi Weather Science and Technology Company, CC BY-NC 4.0.</dd></div></dl><div class="dialog-actions"><button class="filled-button" @click="closeDialogs">Done</button></div></dialog></div>
</div>
</template>
<style scoped>.current-model-links{display:flex;flex-wrap:wrap;gap:10px 20px;margin:0 0 15px;color:#3986b2;font-size:12px}.current-native-guidance{margin-top:18px;color:#657f95;font-size:12px;line-height:1.8}.current-native-guidance summary{cursor:pointer}.current-native-guidance .forecast-grid{margin-top:12px}
.home-restored-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-bottom:18px}.home-global-models{grid-column:1/-1}.home-restored-grid>article{min-width:0}@media(max-width:900px){.home-restored-grid{grid-template-columns:minmax(0,1fr)}}
</style>
