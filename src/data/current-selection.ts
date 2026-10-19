import type { CurrentStorm } from './current-storms'
import { cycloneMean, type PotentialResult } from './potential'
export type CurrentSelection={storm:CurrentStorm|null;storms:CurrentStorm[];providerTime:string}
export type TrackReference={id:string;points:{validTime:string;lat:number;lon:number}[]}
const distance=(a:{lat:number;lon:number},b:{lat:number;lon:number})=>{const r=Math.PI/180,h=Math.sin((a.lat-b.lat)*r/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin((a.lon-b.lon)*r/2)**2;return 12742.0176*Math.asin(Math.min(1,Math.sqrt(h)))}
// Local forecast-reference association, not an official ID conversion or observation verification.
// Never match by name/suffix, nearest fix, an interpolated fix, or by the currently selected item alone.
export function currentReference(selection:CurrentSelection|undefined,references:TrackReference[]):string{
 if(!selection?.storm)return ''
 const matches:{zoom:string;reference:string}[]=[]
 for(const storm of selection.storms){for(const reference of references){
  const start=Math.min(...reference.points.map(p=>Date.parse(p.validTime)))
  const pairs=reference.points.filter(p=>Date.parse(p.validTime)<=start+24*3600000).flatMap(p=>{const q=storm.track.find(q=>q.date===p.validTime||Date.parse(q.date)===Date.parse(p.validTime));return q?[{time:Date.parse(p.validTime),km:distance(p,q)}]:[]})
  const unique=pairs.filter((p,i,a)=>a.findIndex(q=>q.time===p.time)===i)
  if(unique.length>=2&&Math.max(...unique.map(p=>p.time))-Math.min(...unique.map(p=>p.time))>=6*3600000&&unique.every(p=>p.km<=250))matches.push({zoom:storm.id,reference:reference.id})
 }}
 const own=[...new Set(matches.filter(m=>m.zoom===selection.storm!.id).map(m=>m.reference))]
 return own.length===1&&!matches.some(m=>m.reference===own[0]&&m.zoom!==selection.storm!.id)?own[0]!:''
}
export function currentPotentialId(selection:CurrentSelection|undefined,result:PotentialResult|undefined):string{
 if(!selection?.storm||!result)return ''
 const raw=result.wm6?.forecastZero??result.catalog.initTime,base=Date.parse(raw.replace(' ','T')+(/Z$|[+-]\d\d:\d\d$/.test(raw)?'':'Z'))
 if(!Number.isFinite(base))return ''
 const ids=[...new Set(result.catalog.points.filter(p=>/^[A-Z]{2}\d{6}$/.test(p.trackId)).map(p=>p.trackId))]
 return currentReference(selection,ids.map(id=>({id,points:cycloneMean(result,id).map(p=>({lat:p.lat,lon:p.lon,validTime:new Date(base+p.leadHours*3600000).toISOString()}))})))
}
export const currentSelectionNote='跟随Current Storm；仅用起报首24h内≥2个同UTC位置、跨度≥6h、各≤250km且两边目录唯一的非官方对照。来源预报点只作预报参考，不是观测或正式编号互换。无唯一对照就留空。'
