import { cachedJson } from './request-cache'
import type { AiResult } from './wmc'
import type { OverviewTrack } from './overview'
export const extraModels = [
  {id:'AIGFS',label:'AIGFS (L)',color:'#bc354b'},
  {id:'SD3',label:'天机 SD3',color:'#36359a'},
] as const
export type ExtraModel = typeof extraModels[number]['id']
export type ExtraPoint = {lat:number;lon:number;leadHours:number;validTime:string;pressureHpa:number|null;windMs:number|null}
export type ExtraSeed = {code:string;name:string;basin:string;model:string;forecastZero:string;leadHours:number;validTime:string;lat:number;lon:number}
export type ExtraTrack = {model:ExtraModel;systemId:string;name:string;basin:string;kind:'low'|'native';source:string;directoryRun:string;timeOrigin:string;sourceTimeUnits?:string;method:string;notes:string[];attribution:string;license:string;points:ExtraPoint[];endReason:string;retained:boolean;seed?:ExtraSeed}
export type ModelTracks = {checkedAt:string;tracks:ExtraTrack[];models:{model:ExtraModel;status:'available'|'partial'|'retained'|'unavailable';run:string;checkedAt:string;message:string}[]}
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{}
const text=(v:unknown,max=2000)=>typeof v==='string'?v.slice(0,max):''
const number=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)
export const modelTrackUtc=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v.replace(/Z$/,v.includes('.')?'Z':'.000Z')?new Date(v).toISOString():''
const distance=(a:{lat:number;lon:number},b:{lat:number;lon:number})=>{const r=Math.PI/180,h=Math.sin((a.lat-b.lat)*r/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin((a.lon-b.lon)*r/2)**2;return 12742*Math.asin(Math.min(1,Math.sqrt(h)))}
export function modelTrackSource(model:ExtraModel,source:string,directory:string):boolean {
  if(model==='AIGFS')return source===`https://nomads.ncep.noaa.gov/pub/data/nccf/com/aigfs/prod/aigfs.${directory.slice(0,10).replace(/-/g,'')}/${directory.slice(11,13)}/model/atmos/grib2/`
  const m=source.match(/^https:\/\/tj-nwp\.s3-us-west-2\.amazonaws\.com\/typhoon-track\/(\d{4})\/(\d{2})\/(\d{8})\/(00|12)z\/tc_[A-Z]+_[A-Z0-9-]+_track\.nc$/)
  return !!m&&`${m[1]}${m[2]}`===m[3]!.slice(0,6)&&`${m[3]!.slice(0,4)}-${m[3]!.slice(4,6)}-${m[3]!.slice(6,8)}T${m[4]}:00:00.000Z`===directory
}
export function parseModelTracks(value:unknown):ModelTracks {
  const root=object(value)
  if(root.schema!==1||root.generator!=='low-centres-v1'||!modelTrackUtc(root.checkedAt)||!Array.isArray(root.models)||root.models.length!==2||!Array.isArray(root.tracks)||root.tracks.length>60)throw Error('新增模型公开资料格式无效')
  const models:ModelTracks['models']=root.models.map(v=>{const row=object(v);if(!extraModels.some(m=>m.id===row.model)||!['available','partial','retained','unavailable'].includes(String(row.status))||!modelTrackUtc(row.checkedAt))throw Error('新增模型来源状态无效');return {model:row.model as ExtraModel,status:row.status as ModelTracks['models'][number]['status'],run:text(row.run),checkedAt:modelTrackUtc(row.checkedAt),message:text(row.message)}})
  if(new Set(models.map(m=>m.model)).size!==2)throw Error('新增模型状态重复')
  const tracks:ExtraTrack[]=[]
  for(const raw of root.tracks){
    const row=object(raw),model=row.model as ExtraModel,directory=modelTrackUtc(row.directoryRun),origin=modelTrackUtc(row.timeOrigin),id=text(row.systemId,100),name=text(row.name,60),basin=text(row.basin,8)
    if(!extraModels.some(m=>m.id===model)||!directory||!origin||!modelTrackSource(model,text(row.source),directory)||!Array.isArray(row.points)||row.points.length<2||row.points.length>100||!name||!basin||!/^[A-Z0-9:-]+$/.test(id)||!text(row.method)||!text(row.attribution)||!text(row.license))continue
    if((model==='AIGFS'&&(row.kind!=='low'||directory!==origin||!/T(?:00|06|12|18):00:00/.test(directory)))||(model==='SD3'&&(row.kind!=='native'||Date.parse(origin)<Date.parse(directory)||Date.parse(origin)-Date.parse(directory)>86400000)))continue
    const points:ExtraPoint[]=[]
    for(const rawPoint of row.points){const p=object(rawPoint),valid=modelTrackUtc(p.validTime);if(!number(p.lat)||!number(p.lon)||Math.abs(p.lat)>90||Math.abs(p.lon)>180||!number(p.leadHours)||!Number.isInteger(p.leadHours)||p.leadHours<0||p.leadHours>384||!valid||Date.parse(valid)!==Date.parse(origin)+p.leadHours*3600000||points.some(q=>q.leadHours>=Number(p.leadHours))||!(p.pressureHpa===null||(number(p.pressureHpa)&&p.pressureHpa>0))||!(p.windMs===null||(number(p.windMs)&&p.windMs>=0)))break;points.push({lat:p.lat,lon:p.lon,leadHours:p.leadHours,validTime:valid,pressureHpa:p.pressureHpa as number|null,windMs:p.windMs as number|null})}
    if(points.length!==row.points.length)continue
    let seed:ExtraSeed|undefined
    if(model==='AIGFS'){
      const s=object(row.seed),zero=modelTrackUtc(s.forecastZero),valid=modelTrackUtc(s.validTime)
      if(!/^[12]\d{7}$/.test(String(s.code))||id!=='WMC:'+s.code||s.name!==name||s.basin!==basin||!text(s.model,30)||!zero||!valid||valid!==origin||!number(s.leadHours)||s.leadHours<0||Date.parse(zero)+s.leadHours*3600000!==Date.parse(origin)||!number(s.lat)||!number(s.lon)||Math.abs(s.lat)>90||Math.abs(s.lon)>180)continue
      seed={code:String(s.code),name,basin,model:text(s.model,30),forecastZero:zero,validTime:valid,leadHours:s.leadHours,lat:s.lat,lon:s.lon}
      if(points[0]!.leadHours!==0||distance(points[0]!,seed)>250||points.some((p,i)=>p.windMs!==null||p.pressureHpa===null||p.pressureHpa>1015||p.pressureHpa<750||p.leadHours!==i*6||(i>0&&distance(p,points[i-1]!)>510.01)))continue
    }else{
      const sourceId=text(row.source).match(/\/tc_([A-Z]+)_([A-Z0-9-]+)_track\.nc$/)
      if(!sourceId||id!==`SD3:${sourceId[1]}:${sourceId[2]}`||name!==sourceId[2])continue
    }
    tracks.push({model,systemId:id,name,basin,kind:row.kind as ExtraTrack['kind'],source:text(row.source),directoryRun:directory,timeOrigin:origin,sourceTimeUnits:text(row.sourceTimeUnits,200),method:text(row.method),notes:Array.isArray(row.notes)?row.notes.slice(0,10).map(n=>text(n)):[],attribution:text(row.attribution),license:text(row.license),points,endReason:text(row.endReason),retained:row.retained===true,seed})
  }
  const unique=tracks.filter(t=>tracks.filter(q=>q.model===t.model&&q.systemId===t.systemId).length===1)
  const aigfsBases=new Set(unique.filter(t=>t.model==='AIGFS').map(t=>t.timeOrigin))
  return {checkedAt:modelTrackUtc(root.checkedAt),models,tracks:unique.filter(t=>t.model!=='AIGFS'||aigfsBases.size===1)}
}
export async function loadModelTracks(signal?:AbortSignal,fetcher:typeof fetch=fetch):Promise<ModelTracks>{return parseModelTracks(await cachedJson('/api/model-tracks',signal,fetcher))}
export function extraAssociation(track:ExtraTrack,catalog:AiResult|undefined):{code:string;rule:string}|null {
  if(!catalog)return null
  if(track.seed){return catalog.tracks.some(t=>t.code===track.seed!.code&&t.name===track.name&&t.basin===track.basin)?{code:track.seed.code,rule:`本站L追踪以 WMC ${track.seed.code} ${track.seed.model} 同UTC预报位置作初始参考（非实测、非独立官方身份对照）`}:null}
  const candidates=[...new Set(catalog.tracks.filter(t=>t.name===track.name&&t.basin===track.basin).map(t=>t.code))]
  const matches=candidates.filter(code=>catalog.tracks.filter(t=>t.code===code).some(reference=>{
    const early=track.points.filter(p=>Date.parse(p.validTime)-Date.parse(track.points[0]!.validTime)<=43200000)
    const pairs=early.flatMap(p=>{const q=reference.points.find(q=>Date.parse(q.validTime)===Date.parse(p.validTime));return q?[{time:Date.parse(p.validTime),km:distance(p,q)}]:[]})
    return pairs.length>=2&&Math.max(...pairs.map(p=>p.time))-Math.min(...pairs.map(p=>p.time))>=21600000&&pairs.every(p=>p.km<=250)
  }))
  return matches.length===1?{code:matches[0]!,rule:'SD3↔WMC本站名称＋洋区＋同UTC早期至少2点／跨度≥6h／各≤250km对照；非官方身份映射'}:null
}
export function addExtraTracks(existing:{base:string;tracks:OverviewTrack[]},extras:ExtraTrack[],association:string):{base:string;tracks:OverviewTrack[]}{
  if(!extras.length)return existing
  const anchor=Math.min(...extras.map(t=>Date.parse(t.timeOrigin)),...(existing.base?[Date.parse(existing.base)]:[]))
  const old=existing.tracks.map(t=>({...t,points:t.points.map(p=>({...p,leadHours:p.leadHours+(Date.parse(existing.base)-anchor)/3600000}))}))
  const added:OverviewTrack[]=extras.map(t=>{const m=extraModels.find(m=>m.id===t.model)!;return{model:t.model,label:m.label,color:m.color,kind:t.kind==='low'?'derived':'single',identity:`${t.systemId} ${t.name} · ${association}`,initialization:t.directoryRun,forecastZero:t.timeOrigin,initializationLabel:t.model==='SD3'?'Directory version:':'Grid init:',baseLabel:t.model==='SD3'?'First valid UTC:':'Forecast base:',source:'remote',provenance:`${t.method} ${t.notes.join(' ')} ${t.retained?'保留上次结果，未确认更新。':''} ${t.endReason} ${t.attribution} · ${t.license} · ${t.source} ${t.sourceTimeUnits??''}`,points:t.points.map(p=>({...p,leadHours:(Date.parse(p.validTime)-anchor)/3600000}))}})
  // Bounds belong to each native run. An AIGFS +384h point can be +390h from a different common label anchor.
  return {base:new Date(anchor).toISOString(),tracks:[...old,...added]}
}
