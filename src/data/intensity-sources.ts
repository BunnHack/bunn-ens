import type { IntensityMetric, IntensitySeries, IntensityPoint } from './intensity'
import { aiModels, type AiResult } from './wmc'
import { extraModels, type ExtraTrack } from './model-tracks'
export type GuidanceSeries = Omit<IntensitySeries,'model'|'definition'|'denominator'> & { model:string;definition:'member_mean'|'provider_mean'|'single'|'low'|'aid';denominator:number|null;unit?:'kt'|'m/s'|'hPa';identity?:string;initializationLabel?:string;baseLabel?:string;note?:string;attribution?:string;license?:string }
export function windGuidanceInKnots(series:GuidanceSeries):GuidanceSeries{
 if(series.metric!=='wind'||series.unit!=='m/s')return series
 if(series.definition!=='single')return {...series,unit:'kt',points:[],note:(series.note??'')+' Field vector wind is not sustained TC VMAX; excluded.'}
 const factor=3600/1852
 return {...series,unit:'kt',note:(series.note??'')+' Display conversion only: original m/s ×3600/1852 = kt; no duration/intensity calibration.',points:series.points.map(p=>({...p,value:p.value*factor,min:p.min===null?null:p.min*factor,max:p.max===null?null:p.max*factor}))}
}
function point(value:number,validTime:string,leadHours:number):IntensityPoint{return {value,validTime,time:Date.parse(validTime),leadHours,count:null,min:null,max:null}}
export function aiIntensity(result:AiResult|undefined,code:string,metric:IntensityMetric):GuidanceSeries[]{
  return (result?.tracks??[]).filter(t=>t.code===code).map(t=>{
    const model=aiModels.find(m=>m.id===t.model)!
    return {key:`ai-${t.model}-${t.code}`,model:t.model,label:model.label,color:model.color,cyclone:`WMC ${t.code}`,identity:`WMC ${t.code} ${t.name}`,metric,definition:'single',denominator:null,minimumMembers:0,initializationTime:t.forecastZero,forecastZero:t.forecastZero,source:'remote',checkedAt:result!.checkedAt,unit:metric==='wind'?'m/s':'hPa',note:`WMC 单一路径；不是系集均线。上游传统HTTP无TLS完整性保障。${t.warnings.join(' ')}`,invalidTimes:0,conflicts:0,missingValues:t.points.filter(p=>(metric==='wind'?p.windMs:p.pressureHpa)===null).length,points:t.points.flatMap(p=>{const value=metric==='wind'?p.windMs:p.pressureHpa;return value===null?[]:[point(value,p.validTime,p.leadHours)]})} satisfies GuidanceSeries
  })
}
export function extraIntensity(tracks:ExtraTrack[],checkedAt:string,metric:IntensityMetric):GuidanceSeries[]{
  return tracks.map(t=>{
    const info=extraModels.find(m=>m.id===t.model)!
    return {key:`extra-${t.model}-${t.systemId}`,model:t.model,label:info.label+(t.kind==='low'?' MSLP':''),color:info.color,cyclone:t.systemId,identity:`${t.systemId} ${t.name}`,metric,definition:t.kind==='low'?'low':'single',denominator:null,minimumMembers:0,initializationTime:t.directoryRun,initializationLabel:t.model==='SD3'?'Directory version':'Grid init',forecastZero:t.timeOrigin,baseLabel:t.model==='SD3'?'First valid UTC':'Forecast base',source:'remote',checkedAt,unit:metric==='wind'?'m/s':'hPa',note:`${t.method} ${t.notes.join(' ')} ${t.endReason} ${t.retained?'保留旧结果，未确认本次更新。':''}`,attribution:t.attribution,license:t.license,invalidTimes:0,conflicts:0,missingValues:t.points.filter(p=>(metric==='wind'?p.windMs:p.pressureHpa)===null).length,points:t.points.flatMap(p=>{const value=metric==='wind'?p.windMs:p.pressureHpa;return value===null?[]:[point(value,p.validTime,p.leadHours)]})} satisfies GuidanceSeries
  })
}
export function guidanceCsv(series:GuidanceSeries[]):string{
  const quote=(v:unknown)=>`"${String(v??'').replace(/"/g,'""')}"`
  const header=['source_id','model','definition','field','unit','source_version_label','source_version','base_label','base_or_first_valid_utc','valid_utc','native_lead_h','value','reporting_members','full_available_N','checked_at','attribution','license','method']
  return [header.join(','),...series.flatMap(s=>s.points.map(p=>[s.identity??s.cyclone,s.model,s.definition,s.metric,s.unit??(s.metric==='wind'?'kt':'hPa'),s.initializationLabel??(s.model==='wm6'?'Provider run':'Init'),s.initializationTime,s.baseLabel??'Forecast base',s.forecastZero,p.validTime,p.leadHours,p.value,p.count,s.denominator,s.checkedAt,s.attribution,s.license,s.note].map(quote).join(',')))].join('\n')
}
