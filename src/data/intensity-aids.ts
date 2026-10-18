import { cachedJson, forgetRequest } from './request-cache'
import type { IntensityMetric } from './intensity'
import type { GuidanceSeries } from './intensity-sources'
export type AidPoint={leadHours:number;validTime:string;wind:number|null;pressure:number|null;windConflict:boolean;pressureConflict:boolean}
export type IntensityAid={code:string;points:AidPoint[]}
export type IntensityAids={storm:string;source:string;latestCycle:string;forecastZero:string;checkedAt:string;aids:IntensityAid[]}
export const supportsIntensityAids=(id:string)=>/^(AL|EP|CP)(0[1-9]|[1-4]\d)20\d{2}$/.test(id)
const excluded=new Set(['CARQ','BEST','WRNG','GEMI','GEML'])
const palette=['#6950a2','#b39212','#0e9fbb','#e37b35','#bd5e92','#519145','#9b6151','#dc3650','#507a9f','#6d7928','#6d4fd0','#168b83','#be6422','#485c7d']
function color(code:string){return code==='OFCL'?'#263746':palette[[...code].reduce((v,c)=>v+c.charCodeAt(0),0)%palette.length]!}
function scalar(raw:string,lo:number,hi:number){const value=Number(raw);return raw!==''&&Number.isFinite(value)&&value>=lo&&value<=hi?value:null}
export function parseIntensityAids(v:unknown,storm:string):IntensityAids{
  const x=v as Record<string,unknown>,source=`https://ftp.nhc.noaa.gov/atcf/aid_public/a${storm.toLowerCase()}.dat.gz`
  if(!x||!supportsIntensityAids(storm)||x.storm!==storm||x.source!==source||typeof x.latestCycle!=='string'||!/^\d{10}$/.test(x.latestCycle)||!x.latestCycle.startsWith(storm.slice(4))||typeof x.checkedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(x.checkedAt)||!Number.isFinite(Date.parse(x.checkedAt))||typeof x.rows!=='string'||x.rows.length>4000000)throw Error('NHC ATCF 强度来源格式／身份无效')
  const c=x.latestCycle,zero=`${c.slice(0,4)}-${c.slice(4,6)}-${c.slice(6,8)}T${c.slice(8,10)}:00:00.000Z`
  if(!Number.isFinite(Date.parse(zero))||new Date(zero).toISOString()!==zero||![0,6,12,18].includes(Number(c.slice(8))))throw Error('ATCF cycle 不是有效UTC时次')
  const groups=new Map<string,Map<number,{wind:Set<number>;pressure:Set<number>}>>()
  for(const line of x.rows.split(/\r?\n/)){
    if(!line.trim())continue
    const r=line.split(',').map(s=>s.trim())
    if(r.length<10||r[0]!==storm.slice(0,2)||r[1]!.padStart(2,'0')!==storm.slice(2,4)||r[2]!==c)throw Error('ATCF 行混入其他气旋或时次')
    const code=r[4]!,lead=Number(r[5]);if(!/^[A-Z0-9]{2,4}$/.test(code)||excluded.has(code)||/^(?:AP|CP|EP|EE|GE|UK|CM|NP)\d{2}$/.test(code)||!/^\d+$/.test(r[5]!)||!Number.isInteger(lead)||lead<0||lead>312)continue
    const model=groups.get(code)??new Map(),p=model.get(lead)??{wind:new Set<number>(),pressure:new Set<number>()}
    // ATCF 0 / absent values are retained as unavailable rather than a zero-wind / zero-pressure forecast.
    const wind=scalar(r[8]!,1,250),pressure=scalar(r[9]!,750,1100)
    if(wind!==null)p.wind.add(wind);if(pressure!==null)p.pressure.add(pressure);model.set(lead,p);groups.set(code,model)
    if(groups.size>120)throw Error('ATCF guidance 种类超出限制')
  }
  const aids=[...groups].map(([code,values])=>({code,points:[...values].sort(([a],[b])=>a-b).map(([lead,p])=>({leadHours:lead,validTime:new Date(Date.parse(zero)+lead*3600000).toISOString(),wind:p.wind.size===1?[...p.wind][0]!:null,pressure:p.pressure.size===1?[...p.pressure][0]!:null,windConflict:p.wind.size>1,pressureConflict:p.pressure.size>1}))})).filter(a=>a.points.some(p=>p.wind!==null||p.pressure!==null)).sort((a,b)=>a.code==='OFCL'?-1:b.code==='OFCL'?1:a.code.localeCompare(b.code))
  return {storm,source,latestCycle:c,forecastZero:zero,checkedAt:x.checkedAt,aids}
}
export async function loadIntensityAids(storm:string,signal?:AbortSignal,fetcher:typeof fetch=fetch){
  const url='/api/intensity-aids?'+new URLSearchParams({storm})
  try{return parseIntensityAids(await cachedJson(url,signal,fetcher),storm)}catch(e){forgetRequest(url,fetcher);throw e}
}
export function aidIntensity(result:IntensityAids|undefined,metric:IntensityMetric):GuidanceSeries[]{
  return result?.aids.map(a=>({key:`aid-${a.code}`,model:`aid:${a.code}`,label:a.code,color:color(a.code),cyclone:result.storm,identity:result.storm,metric,definition:'aid',denominator:null,minimumMembers:0,initializationTime:result.forecastZero,initializationLabel:'ATCF cycle',forecastZero:result.forecastZero,source:'remote',checkedAt:result.checkedAt,unit:metric==='wind'?'kt':'hPa',invalidTimes:0,conflicts:a.points.filter(p=>metric==='wind'?p.windConflict:p.pressureConflict).length,missingValues:a.points.filter(p=>(metric==='wind'?p.wind:p.pressure)===null).length,note:`NOAA/NHC public ATCF aid ${a.code}; original technique code, statistic as published (not a locally calculated member mean); N unknown. Original VMAX kt / MSLP hPa; source 0/absent unavailable. Same cycle only. ${result.source}`,attribution:'NOAA/NHC public ATCF aid archive',points:a.points.flatMap(p=>{const value=metric==='wind'?p.wind:p.pressure;return value===null?[]:[{time:Date.parse(p.validTime),validTime:p.validTime,leadHours:p.leadHours,value,count:null,min:null,max:null}]})} satisfies GuidanceSeries))??[]
}
