import { cachedJson, forgetRequest } from './request-cache'
export const ZOOM_SOURCE = 'https://zoom.earth/'
export type StormFix = { date: string; lat: number; lon: number; wind: number | null; pressure: number | null; basin: string; forecast: boolean; rank: number; code: string; description: string }
export type CurrentStorm = { id: string; name: string; title: string; description: string; season: string; active: boolean; invest: boolean; disturbance: boolean; centroid: boolean; agencies: string; place: string; chance: string; chance2day: number | null; chance7day: number | null; track: StormFix[] }
export type StormEntry = { id: string; kind: 'storm' | 'disturbance'; data: CurrentStorm | null; checkedAt: string; error: string; retained?: boolean }
export type CurrentStorms = { source: typeof ZOOM_SOURCE; providerTime: string; catalogDate: string; checkedAt: string; entries: StormEntry[] }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
export const zoomStormId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,39}-20\d{2}$/.test(v)
export function stormUtc(v: unknown): v is string { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().replace('.000Z','Z') === v }
const text = (v: unknown, limit = 200) => typeof v === 'string' ? v.slice(0,limit) : ''
function scalar(v: unknown, min: number, max: number) { if(v === null || v === undefined) return null; if(typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error('气旋原始数值无效'); return v }
export function parseZoomStorm(v: unknown, id: string): CurrentStorm {
  if(!object(v) || v.id !== id || !zoomStormId(id) || typeof v.active !== 'boolean' || !Array.isArray(v.track) || !v.track.length || v.track.length > 600) throw new Error('气旋来源身份／路径无效')
  const seen = new Map<string,StormFix>(), track: StormFix[] = []
  for(const p of v.track){
    if(!object(p) || !stormUtc(p.date) || !Array.isArray(p.coordinates) || p.coordinates.length !== 2 || typeof p.forecast !== 'boolean') throw new Error('气旋路径时间／位置无效')
    const lon=scalar(p.coordinates[0],-180,180),lat=scalar(p.coordinates[1],-90,90)
    if(lon===null||lat===null)throw new Error('气旋缺少坐标')
    const fix:StormFix={date:p.date,lat,lon,wind:scalar(p.wind,0,250),pressure:scalar(p.pressure,800,1100),basin:text(p.basin,8),forecast:p.forecast,rank:scalar(p.rank,-5,10)??-3,code:text(p.code,12),description:text(p.description)}
    const previous=seen.get(fix.date)
    if(previous){if(JSON.stringify(previous)!==JSON.stringify(fix))throw new Error('同一UTC路径点冲突');continue}
    seen.set(fix.date,fix);track.push(fix)
  }
  track.sort((a,b)=>Date.parse(a.date)-Date.parse(b.date))
  return {id,name:text(v.name,80),title:text(v.title),description:text(v.description),season:text(v.season,12),active:v.active,invest:v.invest===true,disturbance:v.disturbance===true,centroid:v.centroid===true,agencies:text(v.agencies,100),place:text(v.place),chance:text(v.chance,20),chance2day:scalar(v.chance2day,0,100),chance7day:scalar(v.chance7day,0,100),track}
}
export function parseCurrentStorms(v: unknown): CurrentStorms {
  if(!object(v)||v.schema!==1||v.source!==ZOOM_SOURCE||v.windUnit!=='kt'||v.pressureUnit!=='hPa'||!stormUtc(v.providerTime)||!stormUtc(v.checkedAt)||typeof v.catalogDate!=='string'||!/^\d{4}-\d\d-\d\dT(?:00|06|12|18):00Z$/.test(v.catalogDate)||Date.parse(v.catalogDate)!==Math.floor(Date.parse(v.providerTime)/21600000)*21600000||!Array.isArray(v.entries)||v.entries.length>20)throw new Error('即时气旋清单／来源时间无效')
  const ids=new Set<string>()
  const entries=v.entries.map((e:unknown):StormEntry=>{
    if(!object(e)||!zoomStormId(e.id)||ids.has(e.id)||!['storm','disturbance'].includes(e.kind))throw new Error('即时气旋编号无效／重复')
    ids.add(e.id)
    return {id:e.id,kind:e.kind,data:e.data===null?null:parseZoomStorm(e.data,e.id),checkedAt:v.checkedAt,error:text(e.error)}
  })
  return {source:ZOOM_SOURCE,providerTime:v.providerTime,catalogDate:v.catalogDate,checkedAt:v.checkedAt,entries}
}
export async function loadCurrentStorms(signal?:AbortSignal,fetcher:typeof fetch=fetch){
  const url='/api/current-storms'
  try{return parseCurrentStorms(await cachedJson<unknown>(url,signal,fetcher))}catch(error){forgetRequest(url,fetcher);throw error}
}
export function latestAnalysis(storm:CurrentStorm,providerTime:string){return storm.track.filter(p=>!p.forecast&&Date.parse(p.date)<=Date.parse(providerTime)).slice(-1)[0]??null}
export function retainStormEntries(next:CurrentStorms,previous?:CurrentStorms):CurrentStorms{
  return {...next,entries:next.entries.map(e=>{const old=previous?.entries.find(p=>p.id===e.id);return !e.data&&old?.data?{...e,data:old.data,checkedAt:old.checkedAt,retained:true}:e})}
}
export const displayUtc=(raw:string)=>raw.replace('T',' ').replace(/Z$/,' UTC')
