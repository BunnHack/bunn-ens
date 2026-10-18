import type { OverviewPoint, OverviewTrack } from './overview'
export type OverviewData = { base: string; tracks: OverviewTrack[] }
// Display-only UTC clipping; original model bases, identities and fixes are not rewritten.
export function overviewWindow(data: OverviewData, hours = 120, includeOlder = false) {
  if (!data.tracks.length) return { ...data, end: '', older: [] as OverviewTrack[] }
  const start=Math.max(...data.tracks.map(t=>Date.parse(t.forecastZero)))
  if(!Number.isFinite(start)||!Number.isFinite(Date.parse(data.base)))return {base:'',end:'',tracks:[],older:[] as OverviewTrack[]}
  const end=hours===0?Infinity:start+hours*3600000
  const older=data.tracks.filter(t=>Date.parse(t.forecastZero)<start-24*3600000)
  const tracks=data.tracks.filter(t=>includeOlder||!older.includes(t)).flatMap(t=>{
    const points:OverviewPoint[]=t.points.flatMap(p=>{
      const time=Date.parse(data.base)+p.leadHours*3600000
      return time>=start&&time<=end?[{...p,leadHours:(time-start)/3600000}]:[]
    })
    return points.length?[{...t,points}]:[]
  })
  const last=tracks.flatMap(t=>t.points.map(p=>start+p.leadHours*3600000))
  return {base:new Date(start).toISOString(),end:last.length?new Date(Math.max(...last)).toISOString():'',tracks,older}
}
export function overviewPointUtc(base:string,p:OverviewPoint){return new Date(Date.parse(base)+p.leadHours*3600000).toISOString()}
export function overviewLabels(tracks:OverviewTrack[],base:string,project:(p:OverviewPoint)=>{x:number;y:number}){
  const used:{x:number;y:number}[]=[],labels:{model:string;color:string;point:OverviewPoint;text:string;utc:string}[]=[]
  for(const t of tracks){
    const candidates=t.points.filter((p,i)=>i===t.points.length-1||Date.parse(overviewPointUtc(base,p))%(48*3600000)===0).reverse()
    let n=0
    for(const point of candidates){const pos=project(point);if(pos.x<65||pos.x>1435||pos.y<120||pos.y>975||used.some(p=>Math.abs(p.x-pos.x)<110&&Math.abs(p.y-pos.y)<25))continue
      const utc=overviewPointUtc(base,point);used.push(pos);labels.push({model:t.model,color:t.color,point,utc,text:utc.slice(5,10)+' '+utc.slice(11,13)+'Z'});if(++n>=2)break
    }
  }
  return labels
}
