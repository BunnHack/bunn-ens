import type { TrackPoint } from './wnc2'
import { aiModels, type AiModel, type AiTrack } from './wmc'
import type { BasinRegion } from './basin'
import { cycloneMean, type PotentialModel, type PotentialResult } from './potential'
export const overviewModels = [
  { id: 'wn3', label: 'WN3C(M)', color: '#674589' },
  { id: 'wn2', label: 'WN2C(M)', color: '#9c6acc' },
  { id: 'wm6', label: 'WM-6(M)', color: '#008d70' },
  { id: 'genc', label: 'GENC(M)', color: '#168bef' },
  { id: 'gefs', label: 'GEFS(M)', color: '#bb701a' },
  { id: 'aigefs', label: 'AIGEFS(M)', color: '#256b97' },
] as const
export type OverviewPoint = { lat: number; lon: number; leadHours: number; count?: number; windMs?: number | null; pressureHpa?: number | null; validTime?: string }
export type OverviewTrack = { model: PotentialModel | AiModel | import('./model-tracks').ExtraModel; label: string; color: string; initialization: string; forecastZero: string; source: 'remote' | 'snapshot'; points: OverviewPoint[]; kind?: 'ensemble' | 'single' | 'derived'; identity?: string; initializationLabel?: string; baseLabel?: string; provenance?: string }
export function focusTrackRegion(points: ReadonlyArray<Pick<TrackPoint, 'lon' | 'lat'>>, fallback: BasinRegion, context = 1): BasinRegion {
  if (!points.length) return fallback
  const reference=points[0]!.lon, lons=points.map(p=>reference+((p.lon-reference+540)%360+360)%360-180), lats=points.map(p=>p.lat)
  const west=Math.min(...lons), east=Math.max(...lons), south=Math.min(...lats), north=Math.max(...lats)
  const padding=Number.isFinite(context)?Math.max(1,Math.min(4,context)):1
  const dx=Math.max(3,(east-west)*.15)*padding,dy=Math.max(3,(north-south)*.15)*padding
  return {id:'focused-storm',label:'系統聚焦圖域（外圍成員可能超出圖域）',west:Math.floor((west-dx)/2)*2,east:Math.ceil((east+dx)/2)*2,south:Math.max(-85,Math.floor((south-dy)/2)*2),north:Math.min(85,Math.ceil((north+dy)/2)*2)}
}
export function overviewTracks(results: Partial<Record<PotentialModel, PotentialResult>>, cyclone: string): { base: string; tracks: OverviewTrack[] } {
  if (!/^[A-Z]{2}\d{6}$/.test(cyclone)) return {base:'',tracks:[]}
  const rows=overviewModels.flatMap(model=>{
    const result=results[model.id];if(!result)return []
    const base=model.id==='wm6' ? result.wm6?.forecastZero??'' : result.catalog.initTime.replace(' ','T')+'Z'
    if(!Number.isFinite(Date.parse(base)))return []
    const points=cycloneMean(result,cyclone).filter(p=>model.id==='wm6'||p.count>=Math.max(2,Math.ceil(result.catalog.totalSamples*.25)));if(!points.length)return []
    return [{...model,model:model.id,initialization:result.catalog.initTime,forecastZero:base,source:result.source,points}]
  })
  if(!rows.length)return {base:'',tracks:[]}
  const anchor=Math.min(...rows.map(row=>Date.parse(row.forecastZero)))
  // Labels use one common UTC anchor, never equal +h from different model bases.
  return {base:new Date(anchor).toISOString(),tracks:rows.map(row=>({...row,points:row.points.map(p=>({...p,leadHours:p.leadHours+(Date.parse(row.forecastZero)-anchor)/3600000})).filter(p=>p.leadHours>=0)}))}
}
export function addAiTracks(existing: {base:string;tracks:OverviewTrack[]}, ai: AiTrack[], identity: string): {base:string;tracks:OverviewTrack[]} {
  if (!ai.length) return existing
  const anchor = Math.min(...ai.map(t=>Date.parse(t.forecastZero)), ...(existing.base?[Date.parse(existing.base)]:[]))
  const means = existing.tracks.map(t=>({...t,points:t.points.map(p=>({...p,leadHours:p.leadHours+(Date.parse(existing.base)-anchor)/3600000}))}))
  const singles: OverviewTrack[] = ai.map(t=>({ model:t.model,label:aiModels.find(m=>m.id===t.model)!.label,color:aiModels.find(m=>m.id===t.model)!.color,initialization:t.forecastZero,forecastZero:t.forecastZero,source:'remote',kind:'single',identity:`WMC ${t.code} ${t.name} · ${identity}`,points:t.points.map(p=>({...p,leadHours:(Date.parse(p.validTime)-anchor)/3600000})) }))
  return {base:new Date(anchor).toISOString(),tracks:[...means,...singles].map(t=>({...t,points:t.points.filter(p=>p.leadHours>=0)})).filter(t=>t.points.length>0)}
}
