<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import ChartFrame from './ChartFrame.vue'
import IntensityPlot from './IntensityPlot.vue'
import { loadPotential, type PotentialModel, type PotentialResult } from '../data/potential'
import { loadWm6, type Wm6Response } from '../data/wm6'
import { intensityModels, loadWm6Intensity, matchedCyclone, memberIntensity, providerIntensity, type IntensityMetric } from '../data/intensity'
import { aiModels, associateAi, loadAi, type AiResult } from '../data/wmc'
import { extraModels, extraAssociation, loadModelTracks, type ModelTracks } from '../data/model-tracks'
import { aiIntensity, extraIntensity, guidanceCsv, type GuidanceSeries } from '../data/intensity-sources'
import { aidIntensity, loadIntensityAids, supportsIntensityAids, type IntensityAids } from '../data/intensity-aids'
import { clearRequestCache } from '../data/request-cache'
const props=withDefaults(defineProps<{active?:boolean}>(),{active:true})
const results=shallowRef<Partial<Record<PotentialModel,PotentialResult>>>({}),wm6List=shallowRef<Wm6Response|null>(null),catalog=shallowRef<AiResult>(),aiResults=shallowRef<Record<string,AiResult>>({}),extras=shallowRef<ModelTracks>(),aids=shallowRef<Record<string,IntensityAids>>({})
const storm=ref('WP292026'),metric=ref<IntensityMetric>('wind'),enabled=ref<string[]>([...intensityModels.map(m=>m.id),...aiModels.map(m=>m.id),...extraModels.map(m=>m.id)]),showProvider=ref(false)
const errors=ref<Partial<Record<PotentialModel,string>>>({}),catalogError=ref(''),aiError=ref(''),extraError=ref(''),aidError=ref(''),loading=ref(false),detailLoading=ref(false),aiLoading=ref(false),aidLoading=ref(false),exportError=ref(''),wm6ListError=ref(''),dataRevision=ref(0)
const knownAids=new Set<string>(),aiLoaded:Record<string,number>={},aidAttempt:Record<string,number>={}
const aiFailures:Record<string,string>={},aidFailures:Record<string,string>={},nhcInput=ref(''),requestedNHC=ref<string[]>([])
let lastDetailKey=''
watch([enabled,showProvider,metric,storm],()=>{dataRevision.value++},{deep:true,flush:'sync'})
watch([results,aiResults,extras,aids],()=>{dataRevision.value++},{flush:'sync'})
let controller:AbortController|undefined,detailController:AbortController|undefined,aiController:AbortController|undefined,aidController:AbortController|undefined,timer:ReturnType<typeof setInterval>|undefined,revision=0,detailRevision=0,aiRevision=0,aidRevision=0,lastAttempt=0
const choices=computed(()=>{
 const values=new Map<string,Set<string>>()
 for(const model of intensityModels){const ids=model.id==='wm6'?Object.keys(wm6List.value?.tropical_cyclones??{}):[...new Set(results.value[model.id]?.catalog.points.map(p=>p.trackId)??[])];for(const id of ids.filter(matchedCyclone)){const sources=values.get(id)??new Set<string>();sources.add(model.label);values.set(id,sources)}}
 for(const id of requestedNHC.value){const sources=values.get(id)||new Set<string>();sources.add(aids.value[id]?'NHC已验证归档':'NHC查询ID／待归档验证');values.set(id,sources)}
 return [...values].sort(([a],[b])=>a.localeCompare(b)).map(([id,sources])=>({id,label:`${id} · ${[...sources].join(' / ')}`}))
})
const aiChoices=computed(()=>[...new Set(catalog.value?.tracks.map(t=>t.code)??[])].map(code=>({code,name:catalog.value!.tracks.find(t=>t.code===code)!.name})))
const extraChoices=computed(()=>[...new Set(extras.value?.tracks.map(t=>t.systemId)??[])].map(id=>({id,name:extras.value!.tracks.find(t=>t.systemId===id)!.name})))
const independent=computed(()=>storm.value.startsWith('wmc:')||storm.value.startsWith('extra:'))
const association=computed(()=>independent.value?null:associateAi(catalog.value,results.value.wm6,storm.value))
const aiCode=computed(()=>storm.value.startsWith('wmc:')?storm.value.slice(4):association.value?.code??'')
const aiResult=computed(()=>aiResults.value[aiCode.value])
const extraTracks=computed(()=>extras.value?.tracks.filter(t=>storm.value.startsWith('extra:')?t.systemId===storm.value.slice(6):!!aiCode.value&&extraAssociation(t,catalog.value)?.code===aiCode.value)??[])
const calculated=computed(()=>{
 const series:GuidanceSeries[]=[],issues:Record<string,string>={}
 if(!independent.value){for(const model of intensityModels){const result=results.value[model.id];if(!result||!storm.value||(model.id==='wm6'&&!result.details[storm.value]))continue;try{const value=memberIntensity(result,model.id,storm.value,metric.value);series.push(value);if(!value.points.length)issues[model.id]='没有同一 ID 的足量有效成员，未画线。'}catch(cause){issues[model.id]=cause instanceof Error?cause.message:String(cause)}}
 if(showProvider.value&&enabled.value.includes('wm6')&&results.value.wm6?.details[storm.value]){try{series.push(providerIntensity(results.value.wm6,storm.value,metric.value))}catch(cause){issues.provider=cause instanceof Error?cause.message:String(cause)}}
 series.push(...aidIntensity(aids.value[storm.value],metric.value))}
 series.push(...aiIntensity(aiResult.value,aiCode.value,metric.value),...extraIntensity(extraTracks.value,extras.value?.checkedAt??'',metric.value))
 return {series,issues}
})
const plotted=computed(()=>calculated.value.series.filter(s=>enabled.value.includes(s.model)&&s.points.length))
const groups=computed(()=>metric.value==='pressure'?[{unit:'hPa' as const,series:plotted.value}]:[{unit:'kt' as const,series:plotted.value.filter(s=>(s.unit??'kt')==='kt')},{unit:'m/s' as const,series:plotted.value.filter(s=>s.unit==='m/s')}])
const sourceRows=computed(()=>intensityModels.map(m=>({...m,result:results.value[m.id],series:calculated.value.series.find(s=>s.model===m.id&&s.definition==='member_mean'),error:[m.id==='wm6'?wm6ListError.value:'',errors.value[m.id],calculated.value.issues[m.id]].filter(Boolean).join(' '),failed:!!errors.value[m.id]||(m.id==='wm6'&&!!wm6ListError.value)})))
const extraRows=computed(()=>[...aiModels,...extraModels].map(m=>({...m,series:calculated.value.series.find(s=>s.model===m.id)})))
const aidRows=computed(()=>aidIntensity(aids.value[storm.value],metric.value))
const filename=computed(()=>`Intensity-${storm.value.replace(/[^A-Za-z0-9_-]/g,'-')}-${metric.value}-${plotted.value.map(s=>`${s.key}-${s.initializationTime.replace(/[^0-9]/g,'')}`).join('_').slice(0,155)}-data${dataRevision.value}`)
const loadingAny=computed(()=>loading.value||detailLoading.value||aiLoading.value||aidLoading.value)
function utc(raw:string){return raw.replace('T',' ').replace(/(?:\.000)?Z$/,' UTC')}
function retryAids(){if(!props.active||!supportsIntensityAids(storm.value))return;clearRequestCache(fetch,'/api/intensity-aids');void loadSelectedAids(true)}
function queryNHC(){if(!props.active)return;const id=nhcInput.value.trim().toUpperCase();if(!supportsIntensityAids(id)){aidError.value='请输入完整NHC编号：AL／EP／CP + 01–49 + 四位年份。';return}nhcInput.value=id;requestedNHC.value=[...requestedNHC.value.filter(v=>v!==id).slice(-19),id];if(storm.value===id)retryAids();else storm.value=id}
async function loadSelectedWm6(){
 if(!props.active||independent.value)return
 const list=wm6List.value,id=storm.value,token=++detailRevision;detailController?.abort();detailLoading.value=false
 if(!list||!id)return
 if(!Object.prototype.hasOwnProperty.call(list.tropical_cyclones,id)){errors.value.wm6='WM-6 此次清单没有所选 ID；不借用其他系统。';return}
 const active=new AbortController();detailController=active;detailLoading.value=true;errors.value.wm6='';lastDetailKey=id+'|'+list.initialization_time
 try{const result=await loadWm6Intensity(list,id,active.signal);if(!active.signal.aborted&&token===detailRevision){results.value={...results.value,wm6:result};dataRevision.value++}}
 catch(cause){if(!active.signal.aborted&&token===detailRevision)errors.value.wm6=cause instanceof Error?cause.message:String(cause)}
 finally{if(token===detailRevision)detailLoading.value=false}
}
async function loadSelectedAi(force=false){
 const code=aiCode.value;if(!props.active||!code)return
 if(!force&&Date.now()-(aiLoaded[code]??0)<300000){aiError.value=aiFailures[code]??'';return}
 delete aiFailures[code]
 const token=++aiRevision;aiController?.abort();const active=new AbortController();aiController=active;aiLoading.value=true;aiError.value='';aiLoaded[code]=Date.now()
 try{const result=await loadAi(code,active.signal);if(!active.signal.aborted&&token===aiRevision){aiResults.value={...aiResults.value,[code]:result};dataRevision.value++}}
 catch(cause){if(!active.signal.aborted&&token===aiRevision){aiError.value=cause instanceof Error?cause.message:String(cause);aiFailures[code]=aiError.value}}
 finally{if(token===aiRevision)aiLoading.value=false}
}
async function loadSelectedAids(force=false){
 const id=storm.value;if(!props.active||!supportsIntensityAids(id))return
 if(!force&&Date.now()-(aidAttempt[id]??0)<300000){aidError.value=aidFailures[id]??'';return}
 delete aidFailures[id]
 const token=++aidRevision;aidController?.abort();const active=new AbortController();aidController=active;aidLoading.value=true;aidError.value='';aidAttempt[id]=Date.now()
 try{const result=await loadIntensityAids(id,active.signal);if(!active.signal.aborted&&token===aidRevision){aids.value={...Object.fromEntries(Object.entries(aids.value).slice(-19)),[id]:result};for(const aid of result.aids){const model='aid:'+aid.code;if(!knownAids.has(model)){knownAids.add(model);enabled.value.push(model)}}dataRevision.value++}}
 catch(cause){if(!active.signal.aborted&&token===aidRevision){aidError.value=cause instanceof Error?cause.message:String(cause);aidFailures[id]=aidError.value}}
 finally{if(token===aidRevision)aidLoading.value=false}
}
async function refresh(){
 if(loading.value||!props.active)return
 const token=++revision;controller?.abort();const active=new AbortController();controller=active;loading.value=true;lastAttempt=Date.now()
 try{await Promise.all([
  ...(['wn2','wn3','genc'] as const).map(async model=>{errors.value[model]='';try{const result=await loadPotential(model,'latest',active.signal);if(!active.signal.aborted&&token===revision){if(result.source==='snapshot'&&results.value[model]?.source==='remote')errors.value[model]=result.warning??'仅收到旧备份，保留先前来源。';else results.value={...results.value,[model]:result}}}catch(cause){if(!active.signal.aborted&&token===revision)errors.value[model]=cause instanceof Error?cause.message:String(cause)}}),
  (async()=>{wm6ListError.value='';try{const list=await loadWm6({initialization_time:'latest',include_details:true,include_unofficial_ids:false,format:'json'},active.signal) as Wm6Response;if(!active.signal.aborted&&token===revision)wm6List.value=list}catch(cause){if(!active.signal.aborted&&token===revision)wm6ListError.value=cause instanceof Error?cause.message:String(cause)}})(),
  (async()=>{catalogError.value='';try{const result=await loadAi(undefined,active.signal);if(!active.signal.aborted&&token===revision)catalog.value=result}catch(cause){if(!active.signal.aborted&&token===revision)catalogError.value=cause instanceof Error?cause.message:String(cause)}})(),
  (async()=>{extraError.value='';try{const result=await loadModelTracks(active.signal);if(!active.signal.aborted&&token===revision)extras.value=result}catch(cause){if(!active.signal.aborted&&token===revision)extraError.value=cause instanceof Error?cause.message:String(cause)}})(),
 ])
 if(!active.signal.aborted&&token===revision){dataRevision.value++;if(!independent.value&&!choices.value.some(c=>c.id===storm.value))storm.value=choices.value.find(c=>c.id==='WP292026')?.id??choices.value[0]?.id??(aiChoices.value[0]?`wmc:${aiChoices.value[0].code}`:extraChoices.value[0]?`extra:${extraChoices.value[0].id}`:'');await nextTick();if(!detailLoading.value&&!independent.value&&wm6List.value&&lastDetailKey!==storm.value+'|'+wm6List.value.initialization_time)void loadSelectedWm6();await Promise.all([loadSelectedAi(),loadSelectedAids()])}
 }finally{if(token===revision)loading.value=false}
}
function reload(){for(const path of ['/api/wnc2','/api/wm6','/api/wmc','/api/model-tracks','/api/intensity-aids'])clearRequestCache(fetch,path);if(aiCode.value)aiLoaded[aiCode.value]=0;aidAttempt[storm.value]=0;void refresh()}
function downloadCsv(){exportError.value='';try{const url=URL.createObjectURL(new Blob([guidanceCsv(plotted.value)],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=filename.value+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch{exportError.value='无法下载 CSV，请重试。'}}
watch([storm,wm6List],()=>{++detailRevision;detailController?.abort();detailLoading.value=false;if(!independent.value)void loadSelectedWm6()})
watch(aiCode,(code,old)=>{if(old&&aiLoading.value)aiLoaded[old]=0;++aiRevision;aiController?.abort();aiLoading.value=false;aiError.value='';if(code)void loadSelectedAi()})
watch(storm,(_,old)=>{if(aidLoading.value)aidAttempt[old]=0;++aidRevision;aidController?.abort();aidLoading.value=false;aidError.value='';void loadSelectedAids()})
function stop(){if(detailLoading.value)lastDetailKey='';if(loadingAny.value)lastAttempt=0;if(aiLoading.value&&aiCode.value)aiLoaded[aiCode.value]=0;if(aidLoading.value)aidAttempt[storm.value]=0;++revision;++detailRevision;++aiRevision;++aidRevision;controller?.abort();detailController?.abort();aiController?.abort();aidController?.abort();loading.value=false;detailLoading.value=false;aiLoading.value=false;aidLoading.value=false}
watch(()=>props.active,active=>{if(active){if(!lastAttempt||Date.now()-lastAttempt>=300000)void refresh()}else stop()})
onMounted(()=>{if(props.active)void refresh();timer=setInterval(()=>{if(props.active&&document.visibilityState==='visible'&&!loadingAny.value)void refresh()},300000)})
onBeforeUnmount(()=>{stop();clearInterval(timer)})
</script>
<template>
<section class="intensity-guidance" aria-label="Multi-model intensity guidance in native units">
<p class="ig-intro">WN2／WN3／WM-6／GENC 成员条件均值＋WMC 七AI＋SD3原生＋AIGFS低压气压＋NHC ATCF强度aid。仅同一可验证身份叠加；模型指引独立于上方 Zoom Earth 系统。</p>
<div class="ig-controls"><label>强度系统<select v-model="storm" aria-label="Intensity cyclone"><optgroup label="模式ATCF／手动NHC查询ID"><option v-for="c in choices" :key="c.id" :value="c.id">{{ c.label }}</option></optgroup><optgroup label="WMC来源独立系统"><option v-for="c in aiChoices" :key="c.code" :value="`wmc:${c.code}`">{{ c.name }} · WMC {{ c.code }}</option></optgroup><optgroup label="其他来源独立系统"><option v-for="c in extraChoices" :key="c.id" :value="`extra:${c.id}`">{{ c.name }} · {{ c.id }}</option></optgroup><option v-if="!choices.length&&!aiChoices.length&&!extraChoices.length" value="">等待来源</option></select></label><label>强度字段<select v-model="metric" aria-label="Intensity metric"><option value="wind">风速 · kt／m/s分图保留原始单位</option><option value="pressure">气压 · hPa（含低压L中心场值）</option></select></label><button class="ig-refresh" :disabled="loadingAny" @click="reload">{{ loadingAny?'读取中…':'更新资料' }}</button></div>
<p v-if="loadingAny" class="ig-status" role="status">读取实际来源；原始ID／版本／单位分别保留，不借其他风暴补线。</p>
<p v-if="association" class="ig-association">WMC {{ association.code }} ↔ {{ association.atcfId }}：{{ association.rule }}（{{ association.fixes }}点，最大{{ association.maxKm.toFixed(0) }}km）；非官方对照。</p><p v-else-if="!independent&&catalog" class="ig-status">此ATCF系统暂无唯一WMC对照，不混入AI或SD3；可选择独立来源系统查看。</p>
<div class="ig-model-toggles"><label v-for="m in intensityModels" :key="m.id" :style="{color:m.color}"><input v-model="enabled" type="checkbox" :value="m.id" :aria-label="`Show ${m.label} intensity`"/>{{ m.label }} mean<small>{{ calculated.series.some(s=>s.model===m.id&&s.points.length)?' · 可用':' · 此系统无足量值' }}</small></label><label v-for="m in extraRows" :key="m.id" :style="{color:m.color}"><input v-model="enabled" type="checkbox" :value="m.id" :aria-label="`Show ${m.label} intensity`"/>{{ m.label }}<small>{{ m.series?.points.length?' · 原始单路／场值':m.id==='AIGFS'&&metric==='wind'?' · 无风速，仅L气压':' · 此系统无已核对值' }}</small></label></div>
<p v-if="metric==='wind'" class="ig-unit-note">kt 与 m/s 各用独立坐标轴，未作强度换算／校准。色带沿用既有 kt 分档阈值与颜色，仅为数值参照；不把AI原始m/s或来源rank当Cat。</p>
<template v-if="plotted.length&&active"><template v-for="g in groups" :key="g.unit"><ChartFrame v-if="g.series.length" :filename="filename+'-'+g.unit.replace('/','-')" :title="`${storm} intensity ${g.unit}`"><IntensityPlot :series="g.series" :cyclone="storm" :metric="metric" :unit="g.unit"/></ChartFrame></template></template><p v-else-if="!loadingAny&&active" class="ig-empty" role="status">此系统／字段暂无可绘制的真实强度，或尚未勾选模型。不以历史图、其他系统或推算风速代替。</p>
<template v-for="item in sourceRows" :key="item.id"><p v-if="item.error||item.result?.source==='snapshot'" class="ig-warning" role="status">{{ item.label }}：{{ item.error||item.result?.warning||'有日期备份，未确认最新' }}{{ item.failed&&item.result?' 保留先前成功来源；不同ID不画旧线。':'' }}</p></template>
<p v-if="catalogError||aiError" class="ig-warning">WMC：{{ catalogError||aiError }}{{ catalog||aiResult?'；保留有日期的先前成功结果，非本次确认更新':'' }}</p><p v-if="extraError" class="ig-warning">AIGFS／SD3：{{ extraError }}{{ extras?'；保留有日期的先前成功结果，非本次确认更新':'' }}</p><p v-if="extras&&Date.now()-Date.parse(extras.checkedAt)>43200000" class="ig-warning">AIGFS／SD3发布检查已超过12小时；请核对来源版本，未确认最新。</p><p v-if="aidError" class="ig-warning">NHC：{{ aidError }}{{ aids[storm]?'；保留先前有日期的同ID资料':'' }}</p><p v-if="calculated.issues.provider||exportError" class="ig-warning">{{ calculated.issues.provider||exportError }}</p>
<details class="ig-aids" :open="!!aidRows.length"><summary>NHC / ATCF 模型与强度aid（{{ aidRows.length }}个有来源值的代码）</summary><div class="ig-nhc-query"><label>NHC原始编号<input :value="nhcInput" @input="nhcInput=($event.target as HTMLInputElement).value" aria-label="NHC cyclone ID" maxlength="8" placeholder="EP212026" @keydown.enter.prevent="queryNHC"/></label><button :disabled="aidLoading" @click="queryNHC">按编号查询</button><button class="ig-nhc-retry" :disabled="aidLoading||!supportsIntensityAids(storm)" @click="retryAids">重试本系统NHC（仅此来源）</button></div><p>可手动查询已知AL／EP／CP编号；须由原始归档验证，不把Zoom编号自动当ATCF，也不借其他系统补值。</p><p v-if="!supportsIntensityAids(storm)">此公开归档仅接入 AL／EP／CP 已编号系统；其他洋区不拿NHC气旋代替，也不假称已接入JTWC A-deck。</p><p v-else>保留源文件模型／aid代码，只取同一最新发布cycle，不拼旧时次。包含确定性、统计或发布方共识aid；其统计定义依来源，不当本站成员均值，未猜N。ATCF 0／缺项不作为零风／零气压画线；24h原生定点保留，超过12h间隔不连线。</p><div class="ig-model-toggles"><label v-for="s in aidRows" :key="s.key" :style="{color:s.color}"><input v-model="enabled" type="checkbox" :value="s.model" :aria-label="`Show ${s.label} intensity`"/>{{ s.label }}<small>{{ s.points.length?' · 有值':' · 本字段缺值' }}</small></label></div><p v-if="aids[storm]">NOAA/NHC · ATCF cycle {{ utc(aids[storm]!.forecastZero) }} · 查询 {{ utc(aids[storm]!.checkedAt) }} · <a :href="aids[storm]!.source" target="_blank" rel="noopener">公开原始A-deck ↗</a></p></details>
<p v-if="plotted.some(s=>s.model==='SD3')" class="ig-license">天机 SD3：TianJi Weather Science and Technology Company · <a href="https://www.tjweather.com" target="_blank" rel="noopener">tjweather.com</a> · <a href="https://creativecommons.org/licenses/by-nc/4.0/" target="_blank" rel="noopener">CC BY-NC 4.0，仅限非商业且须署名</a>。目录版本与首个有效UTC不冒充已验证起报；SVG／PNG／CSV保留署名及许可。</p>
<details class="ig-options"><summary>模式、來源與CSV</summary><label><input v-model="showProvider" type="checkbox" aria-label="Show WM-6 provider intensity mean"/>另列 WM-6 供应商均值（不同定义）</label><div class="ig-option-actions"><button :disabled="!plotted.length" @click="downloadCsv">下载原始单位 CSV</button></div><div class="ig-sources"><div v-for="item in sourceRows" :key="item.id" class="ig-source"><strong :style="{color:item.color}">{{ item.label }} · {{ item.source }}</strong><template v-if="item.result"><span>{{ item.id==='wm6'?'供应商版本':'模型起报' }} {{ item.result.catalog.initTime }} UTC</span><span>预报基准 {{ item.id==='wm6'?item.result.wm6?.forecastZero:item.result.catalog.initTime+'Z' }}</span><span v-if="item.series">N={{ item.series.denominator }}；逐时至少{{ item.series.minimumMembers }}位且达25%</span><span>查询完成 {{ utc(item.result.checkedAt) }}（非模式时间）</span><span v-if="item.result.source==='snapshot'">有日期备份，未确认最新。</span></template></div></div><div class="ig-source" v-for="s in calculated.series.filter(s=>!['member_mean','provider_mean'].includes(s.definition))" :key="s.key"><strong :style="{color:s.color}">{{ s.label }} · {{ s.identity }}</strong><span>{{ s.initializationLabel??'模型起报' }} {{ utc(s.initializationTime) }} · {{ s.baseLabel??'预报基准' }} {{ utc(s.forecastZero) }}</span><span>{{ s.unit }} · {{ s.definition }} · 无已验证系集N · 查询 {{ utc(s.checkedAt) }}</span><p>{{ s.note }} {{ s.attribution }} {{ s.license }}</p></div></details>
<details class="ig-method"><summary>均值、原始单位与时间轴定义</summary><p>四个系集主要模型沿用同ID、同有效UTC、每成员一笔原始值的条件算术平均；至少2位且完整可用N的25%。没有跟踪或缺字段不是0；同成员互相冲突的强度剔除，超过12h缺口断线。完整CSV可能漏成员或路径，分母及条件平均有选择偏差。WM-6 有效UTC=forecast_zero+forecast_hour，Provider run不是时效零点；mean_path为另列的供应商统计，不与本站均值混称。</p><p>WMC／SD3单一路径无系集N或概率，风速保留m/s；WMC为传统HTTP，wrapper epoch存在8h不一致，依逐点UTC验证，不当成起报。AIGFS仅本站低压L格点气压场值，非官方气旋中心强度，没有风速、不推算Cat，不保证热带结构。其WMC种子也是预报参考而非实测。只有唯一、已披露的名称／洋区／同UTC位置对照才叠加；否则独立查看。</p><p>所有模型用绝对UTC而非相同+h对齐；每条曲线保留自己的来源版本／时间轴、原始ID与统计。风速取样／持续时间不同，图线不构成校准后强度差。切换字段或模型只在本地重算；5分钟共享请求快取，失败保留并标明旧来源，隐藏页面不轮询。</p><p v-for="s in calculated.series" :key="s.key">{{ s.label }}：时间不符 {{ s.invalidTimes }}、冲突 {{ s.conflicts }}、缺值 {{ s.missingValues }}。</p></details>
<details v-if="plotted.length" class="ig-values"><summary>逐时原始单位值与有效成员</summary><div><table><thead><tr><th>模型 / 定义</th><th>UTC有效时间</th><th>原生+h</th><th>值 / 单位</th><th>n/N</th></tr></thead><tbody><template v-for="s in plotted" :key="s.key"><tr v-for="p in s.points" :key="p.time"><td>{{ s.label }} / {{ s.definition }}</td><td>{{ utc(p.validTime) }}</td><td>{{ p.leadHours }}</td><td>{{ p.value.toFixed(2) }} {{ s.unit??(metric==='wind'?'kt':'hPa') }}</td><td>{{ s.denominator===null?'不适用':`${p.count??'未知'}/${s.denominator}` }}</td></tr></template></tbody></table></div></details>
<details class="intensity-reference-note"><summary>历史 TRUDY 参考图（非实时、非其他系统预报）</summary><p>用户提供的21E强度图仅作版式参考；不是上方曲线数据或故障备援。</p><a href="/images/21E-intensity-reference.png" target="_blank" rel="noopener">2026-10-17 00Z 原参考图 ↗</a> · <a href="/images/21E-intensities-reference.png" download>新增强度配色参考原图 PNG</a></details>
</section>
</template>
<style scoped>
.intensity-guidance{padding:16px 18px;min-width:0;color:#597186}.ig-intro,.ig-unit-note{font-size:12px;line-height:1.9;margin:0 0 12px}.ig-controls{display:flex;align-items:end;flex-wrap:wrap;gap:10px;margin-bottom:12px}.ig-controls label{display:grid;gap:6px;font-size:12px;min-width:0;max-width:100%}.ig-controls select{max-width:100%;min-width:0;border:1px solid #cedce7;border-radius:5px;padding:8px;background:white;color:#45657e;font-size:12px}.ig-controls button,.ig-option-actions button{padding:8px 14px;border-radius:18px;background:#e8f4fb;color:#318bc0;font-size:12px}.ig-controls button:disabled,.ig-option-actions button:disabled{opacity:.5}.ig-model-toggles{display:flex;flex-wrap:wrap;gap:9px 16px;margin:14px 0;font-size:12px}.ig-model-toggles label{display:flex;align-items:center;flex-wrap:wrap;gap:5px}.ig-model-toggles small{font-size:10px;color:#8b98a4}.ig-model-toggles input{accent-color:currentColor}.ig-status,.ig-empty,.ig-association{padding:10px;color:#6c8ca5;background:#eff6fc;font-size:12px;line-height:1.9}.ig-empty{min-height:100px}.ig-warning{color:#9d6a26;background:#fff8e8;padding:8px;font-size:11px;line-height:1.9}.ig-options,.ig-method,.ig-values,.ig-aids,.intensity-reference-note{margin-top:14px;border-top:1px solid #e4ebf1;padding-top:10px;font-size:11px;line-height:1.9}.ig-options summary,.ig-method summary,.ig-values summary,.ig-aids summary,.intensity-reference-note summary{cursor:pointer;color:#3d84ac}.ig-aids a,.ig-options a,.ig-license a,.intensity-reference-note a{color:#388bad}.ig-license{font-size:11px;line-height:1.9;padding:10px;background:#f2f7fb}.ig-sources{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}.ig-source{min-width:0;background:#f4f8fb;padding:10px;font-size:11px;line-height:1.8;overflow-wrap:anywhere;margin:7px 0}.ig-source strong,.ig-source span{display:block}.ig-option-actions{margin:12px 0}.ig-values>div{max-height:350px;overflow:auto}.ig-values table{border-collapse:collapse;white-space:nowrap;width:100%}.ig-values th,.ig-values td{padding:6px 9px;border-bottom:1px solid #e6ecf1;text-align:left}
@media(max-width:700px){.intensity-guidance{padding:12px}.ig-controls{display:grid;grid-template-columns:minmax(0,1fr)}.ig-controls select{width:100%}.ig-sources{grid-template-columns:minmax(0,1fr)}}
.ig-nhc-query{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin:10px 0}.ig-nhc-query label{display:flex;flex-direction:column;gap:4px}.ig-nhc-query input{width:150px;max-width:100%;padding:8px;border:1px solid #c6d6e4;border-radius:5px}
</style>
