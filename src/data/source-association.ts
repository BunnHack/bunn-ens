import { associateAi, type AiResult, type AiAssociation } from './wmc'
import { cycloneMean, type PotentialModel, type PotentialResult } from './potential'
const distance=(a:{lat:number;lon:number},b:{lat:number;lon:number})=>{const r=Math.PI/180,dlat=(a.lat-b.lat)*r,dlon=(a.lon-b.lon)*r;return 12742*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dlon/2)**2)))}
const zones:Record<string,string[]>={WP:['W'],EP:['E'],CP:['C'],AL:['L'],SH:['S','P'],SI:['S'],SP:['P'],IO:['A','B'],NI:['A','B']}
// Forecast references, NOT observations or provider identity verification. No suffix/name-only matching.
export function associateAiSources(catalog:AiResult|undefined,results:Partial<Record<PotentialModel,PotentialResult>>,id:string):AiAssociation|null{
 const named=associateAi(catalog,results.wm6,id);if(named)return named
 if(!catalog||!/^([A-Z]{2})\d{6}$/.test(id))return null
 const allIds=[...new Set(Object.values(results).flatMap(r=>r?.catalog.points.map(p=>p.trackId)??[]).filter(s=>/^[A-Z]{2}\d{6}$/.test(s)))]
 const matches:{code:string;id:string;fixes:number;maxKm:number;model:string;name:string}[]=[]
 for(const candidate of allIds){
  for(const [model,result]of Object.entries(results)){
   if(!result)continue
   const raw=result.wm6?.forecastZero??result.catalog.initTime,base=Date.parse(raw.replace(' ','T')+(/Z$|[+-]\d\d:\d\d$/.test(raw)?'':'Z'));if(!Number.isFinite(base))continue
   const refs=cycloneMean(result,candidate).filter(p=>p.leadHours>=0&&p.leadHours<=24)
   for(const code of [...new Set(catalog.tracks.filter(t=>(zones[candidate.slice(0,2)]??[]).includes(t.basin)).map(t=>t.code))]){
    const track=catalog.tracks.find(t=>t.code===code)!
    const pairs=refs.flatMap(p=>{const time=base+p.leadHours*3600000,q=track.points.find(q=>Date.parse(q.validTime)===time);return q?[{time,km:distance(p,q)}]:[]})
    const unique=pairs.filter((p,i,a)=>a.findIndex(q=>q.time===p.time)===i)
    if(unique.length>=3&&Math.max(...unique.map(p=>p.time))-Math.min(...unique.map(p=>p.time))>=12*3600000&&unique.every(p=>p.km<=250))matches.push({code,id:candidate,fixes:unique.length,maxKm:Math.max(...unique.map(p=>p.km)),model,name:track.name})
   }
  }
 }
 const own=matches.filter(m=>m.id===id),codes=[...new Set(own.map(m=>m.code))]
 if(codes.length!==1||matches.some(m=>m.code===codes[0]&&m.id!==id))return null
 const m=own.sort((a,b)=>b.fixes-a.fixes||a.maxKm-b.maxKm)[0]!
 return {code:m.code,atcfId:id,name:m.name,fixes:m.fixes,maxKm:m.maxKm,rule:`本站洋区＋${m.model.toUpperCase()}同ID成员均线早期0–24h的≥3个同UTC点／跨度≥12h／各≤250km且全目录唯一对照；均线仅是预报参考，不是观测、官方身份或跨模式共识。原始WMC编号保留`}
}
