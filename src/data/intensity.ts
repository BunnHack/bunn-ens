import { wm6Catalog, type PotentialModel, type PotentialResult } from './potential'
import { loadWm6Cyclone, type Wm6Response } from './wm6'

export type IntensityMetric = 'wind' | 'pressure'
export type IntensityPoint = { leadHours: number; validTime: string; time: number; value: number; count: number | null; min: number | null; max: number | null }
export type IntensitySeries = { key: string; model: PotentialModel; label: string; color: string; cyclone: string; metric: IntensityMetric; definition: 'member_mean' | 'provider_mean'; denominator: number; minimumMembers: number; initializationTime: string; forecastZero: string; source: 'remote' | 'snapshot'; checkedAt: string; points: IntensityPoint[]; invalidTimes: number; conflicts: number; missingValues: number }
export const intensityModels = [
  { id: 'wn2', label: 'WNC2', color: '#d55e00', source: 'WeatherNext 2 · FNV3P1' },
  { id: 'wn3', label: 'WNC3', color: '#0072b2', source: 'WeatherNext · WNV3' },
  { id: 'wm6', label: 'WM-6', color: '#009773', source: 'WindBorne cyclone tracker' },
] as const
export const matchedCyclone = (id: string) => /^[A-Z]{2}\d{6}$/.test(id)
export function forecastEpoch(raw: string): number {
  if(typeof raw!=='string')return NaN
  let value=raw.trim().replace(' ','T')
  if(/^\d{4}-\d{2}-\d{2}$/.test(value))value+='T00:00:00'
  if(!/(?:Z|[+-]\d{2}:\d{2})$/.test(value))value+='Z'
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return NaN
  return Date.parse(value)
}
function metadata(result: PotentialResult, model: PotentialModel, cyclone: string, metric: IntensityMetric, provider = false): IntensitySeries {
  if(!matchedCyclone(cyclone))throw new Error('跨模型強度僅比較相同已匹配 ATCF ID，不把本站群組當成跨模型共同風暴。')
  const info=intensityModels.find(item=>item.id===model)!,detail=result.details[cyclone]
  const denominator=model==='wm6'?detail?.ens_size:result.catalog.totalSamples
  if(!Number.isInteger(denominator)||denominator!<2)throw new Error('缺少可靠系集大小，不能計算系集強度平均。')
  const zero=model==='wm6'?result.wm6?.forecastZero:result.catalog.initTime,anchor=forecastEpoch(zero??''),initialization=forecastEpoch(result.catalog.initTime)
  if(!Number.isFinite(anchor)||!Number.isFinite(initialization))throw new Error('缺少有效 forecast_zero／初始化，不能猜測強度時間軸。')
  if(model==='wm6'&&(!detail||forecastEpoch(detail.forecast_zero)!==anchor||forecastEpoch(detail.initialization_time)!==initialization))throw new Error('WM-6 詳情版本／forecast_zero 不符，不混合不同預報。')
  return {key:`${model}-${provider?'provider':'members'}`,model,label:info.label+(provider?' provider mean':''),color:info.color,cyclone,metric,definition:provider?'provider_mean':'member_mean',denominator:denominator!,minimumMembers:Math.max(2,Math.ceil(denominator!*.25)),initializationTime:new Date(initialization).toISOString(),forecastZero:new Date(anchor).toISOString(),source:result.source,checkedAt:result.checkedAt??'',points:[],invalidTimes:0,conflicts:0,missingValues:0}
}
export function memberIntensity(result: PotentialResult, model: PotentialModel, cyclone: string, metric: IntensityMetric): IntensitySeries {
  const series=metadata(result,model,cyclone,metric),anchor=Date.parse(series.forecastZero),initialization=Date.parse(series.initializationTime)
  const hours=new Map<number,Map<number,number|null>>()
  for(const point of result.catalog.points){
    if(point.trackId!==cyclone)continue
    if(!Number.isInteger(point.sample)||point.sample<0||!Number.isFinite(point.leadHours)||point.leadHours<0||point.leadHours>312)continue
    const expected=anchor+point.leadHours*3600000
    if(forecastEpoch(point.validTime)!==expected||forecastEpoch(point.initTime)!==initialization){series.invalidTimes++;continue}
    const value=metric==='wind'?point.wind:point.pressure
    if(value==null||!Number.isFinite(value)||(metric==='wind'?value<0:value<=0)){series.missingValues++;continue}
    const members=hours.get(point.leadHours)??new Map<number,number|null>()
    if(!members.has(point.sample))members.set(point.sample,value)
    else if(members.get(point.sample)!==value && members.get(point.sample)!==null){members.set(point.sample,null);series.conflicts++}
    hours.set(point.leadHours,members)
  }
  for(const [leadHours,members] of hours){
    const values=[...members.values()].filter((value):value is number=>value!=null)
    if(values.length<series.minimumMembers)continue
    if(values.length>series.denominator)throw new Error('有效成員超過聲明的系集大小，拒絕錯誤平均。')
    const time=anchor+leadHours*3600000
    series.points.push({leadHours,time,validTime:new Date(time).toISOString(),value:values.reduce((sum,value)=>sum+value,0)/values.length,count:values.length,min:Math.min(...values),max:Math.max(...values)})
  }
  series.points.sort((a,b)=>a.time-b.time)
  return series
}
export function providerIntensity(result: PotentialResult, cyclone: string, metric: IntensityMetric): IntensitySeries {
  const series=metadata(result,'wm6',cyclone,metric,true),anchor=Date.parse(series.forecastZero),seen=new Set<number>()
  for(const point of result.details[cyclone]!.mean_path){
    if(!Number.isFinite(point.forecast_hour)||point.forecast_hour<0||point.forecast_hour>312)continue
    const time=anchor+point.forecast_hour*3600000
    if(forecastEpoch(point.valid_at)!==time){series.invalidTimes++;continue}
    const value=metric==='wind'?point.max_wind_kt:point.min_mslp_hpa
    if(value==null||!Number.isFinite(value)||(metric==='wind'?value<0:value<=0)){series.missingValues++;continue}
    const rawCount=point.contributing_members_count
    if(rawCount!=null&&(!Number.isInteger(rawCount)||rawCount<0||rawCount>series.denominator))throw new Error('供應商均線的逐時成員數無效。')
    const count=rawCount??null
    if(count!=null&&count<series.minimumMembers)continue
    if(seen.has(point.forecast_hour))throw new Error('供應商均線有重複時效，不能任意挑一筆。')
    seen.add(point.forecast_hour)
    series.points.push({leadHours:point.forecast_hour,time,validTime:new Date(time).toISOString(),value,count,min:null,max:null})
  }
  series.points.sort((a,b)=>a.time-b.time)
  return series
}
export async function loadWm6Intensity(list: Wm6Response, cyclone: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<PotentialResult> {
  if(!matchedCyclone(cyclone)||!Object.prototype.hasOwnProperty.call(list.tropical_cyclones,cyclone))throw new Error('WM-6 此版本未包含所選已匹配 ID。')
  const detail=await loadWm6Cyclone(cyclone,{initialization_time:list.initialization_time,include_members:true,include_cones:false},signal,fetcher)
  if(forecastEpoch(detail.forecast_zero)!==forecastEpoch(list.forecast_zero)||!Number.isFinite(forecastEpoch(detail.forecast_zero)))throw new Error('WM-6 forecast_zero 不符或缺失，不能猜測預報基準。')
  return {catalog:wm6Catalog([detail],list.initialization_time),details:{[cyclone]:detail},source:'remote',checkedAt:new Date().toISOString(),url:`/api/wm6/${encodeURIComponent(cyclone)}?initialization_time=${encodeURIComponent(list.initialization_time)}&include_members=true&include_cones=false`,wm6:{forecastZero:list.forecast_zero,matchedCount:Object.keys(list.tropical_cyclones).filter(matchedCyclone).length,unmatchedCount:0,includedUnofficial:false}}
}
export function intensityCsv(series: IntensitySeries[]): string {
  return ['model,cyclone_id,definition,source_kind,checked_at,metric,unit,provider_initialization,forecast_zero,valid_time,lead_hours,mean,valid_members,ensemble_size,min_member,max_member',...series.flatMap(model=>model.points.map(point=>[model.label,model.cyclone,model.definition,model.source,model.checkedAt,model.metric,model.metric==='wind'?'kt':'hPa',model.initializationTime,model.forecastZero,point.validTime,point.leadHours,point.value,point.count??'',model.denominator,point.min??'',point.max??''].join(',')))].join('\n')+'\n'
}
