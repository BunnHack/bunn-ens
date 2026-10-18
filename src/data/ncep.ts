import { projectNcep, ncepRun, type NcepDataset, type NcepModel } from '../../shared/ncep-protocol.js'
import { cachedJson, forgetRequest } from './request-cache'
import { eastLongitude, normalizeInit, type Catalog } from './wnc2'
import type { PotentialResult } from './potential'
export const NCEP_DATA='https://raw.githubusercontent.com/BunnHack/bunn-ens/ensemble-track-data/'
export const NCEP_CHARTS='https://bunnhack.github.io/bunn-ens/ncep-ensembles/'
export function ncepCatalog(data:NcepDataset):Catalog {
 const initTime=normalizeInit(data.run),anchor=Date.parse(data.run)
 return {initTime,totalSamples:31,rawMaxLead:data.horizonHours,points:data.tracks.flatMap(t=>t.points.map(p=>({sample:t.sample,trackId:t.kind==='matched'?t.trackId:`genesis:${t.sample}:${t.kind}:${t.trackId}`,initTime,validTime:new Date(anchor+p.hour*3600000).toISOString(),leadHours:p.hour,lat:p.lat,lon:eastLongitude(p.lon),wind:p.windKt??NaN,pressure:p.pressureHpa,sourceId:t.sourceId,nativeMember:t.nativeMember,sourceKind:t.kind,fieldWindMs:p.windMs})))}
}
export async function loadNcep(model:NcepModel,run='latest',signal?:AbortSignal,fetcher:typeof fetch=fetch):Promise<PotentialResult>{
 if(!['GEFS','AIGEFS'].includes(model)||run!=='latest'&&!ncepRun(run))throw Error('NCEP模型／起报无效')
 const url=NCEP_DATA+model+(run==='latest'?'':'-'+run.replace(/[-:]/g,''))+'.json'
 try{const data=projectNcep(await cachedJson<unknown>(url,signal,fetcher),model,run)
 return {catalog:ncepCatalog(data),ncep:data,source:'remote',checkedAt:data.checkedAt,details:{},url,warning:`NOAA/NCEP · 完整分母31；tracker ${data.members.filter(m=>m.tracker==='available').length}/31。${model==='GEFS'?`原生genesis ${data.members.filter(m=>m.genesis==='available').length}/31；保留原始类别，不自动判为热带系统。`:`场L ${data.derived.status} · ${data.derived.fields}/1271 成员时次；场10m风保留m/s，不作业务VMAX。`} 缺成员不代表无风险。`}
 }catch(error){forgetRequest(url,fetcher);throw error}
}
export type NcepChartPair={png:string;svg:string}
export type NcepChartRecord={model:NcepModel;run:string;ensembleSize:31;horizonHours:number;generatedAt:string;trackerMembers:number;genesisMembers:number;derived:NcepDataset['derived'];assets:string[];regions:({id:string;label:string}&NcepChartPair)[];storms:({id:string;members:number;track:NcepChartPair;wind:NcepChartPair;pressure:NcepChartPair})[];data:string;csv:string}
export type NcepManifest={schema:1;generator:string;records:NcepChartRecord[]}
export function ncepAsset(path:string,record:NcepChartRecord){
 const prefix=`runs/${record.model}/${record.run.replace(/[-:]/g,'')}/`
 if(!record.assets.includes(path)||!path.startsWith(prefix)||!/^runs\/(GEFS|AIGEFS)\/20\d{6}T(00|06|12|18)0000Z\/(regions\/(world|wp|ep|al|ni|si|sp)\.(png|svgz?)|storms\/(AL|EP|CP|WP|IO|SH|SP|SI)\d{2}20\d{2}-(track|wind|pressure)\.(png|svgz?)|source\.json|native\.csv)$/.test(path))throw Error('预制图路径无效；不以其他模型或时次替代')
 return NCEP_CHARTS+path
}
export async function loadNcepManifest(signal?:AbortSignal,fetcher:typeof fetch=fetch):Promise<NcepManifest>{
 const url=NCEP_CHARTS+'index.json'
 try{const v=await cachedJson<any>(url,signal,fetcher)
 if(v.schema!==1||!['ncep-charts-v1','ncep-charts-v2-svgz'].includes(v.generator)||!Array.isArray(v.records)||!v.records.length||v.records.length>4)throw Error('预制图清单无效')
 for(const r of v.records){if(!['GEFS','AIGEFS'].includes(r.model)||!ncepRun(r.run)||r.ensembleSize!==31||r.horizonHours!==(r.model==='GEFS'?120:240)||!Array.isArray(r.assets)||!Array.isArray(r.regions)||!Array.isArray(r.storms))throw Error('预制图模型／起报／分母无效');for(const p of r.assets)ncepAsset(p,r)}
 return v as NcepManifest
 }catch(error){forgetRequest(url,fetcher);throw error}
}
export async function ncepSvgBlob(url:string,signal?:AbortSignal):Promise<Blob>{
 if(!url.startsWith(NCEP_CHARTS+'runs/'))throw Error('非本站预制图')
 const r=await fetch(url,{signal,credentials:'omit',redirect:'error'});if(!r.ok)throw Error('SVG未能下载，不以其他图替代')
 async function bytes(stream:ReadableStream<Uint8Array>,limit:number){const reader=stream.getReader();const chunks:Uint8Array[]=[];let size=0;try{while(true){signal?.throwIfAborted();const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>limit){await reader.cancel();throw Error('SVG超出安全大小')}chunks.push(p.value)}}finally{reader.releaseLock()}const b=new Uint8Array(size);let i=0;for(const c of chunks){b.set(c,i);i+=c.length}return b}
 if(!r.body)throw Error('空SVG');let b=await bytes(r.body,8*1024*1024)
 if(b[0]===31&&b[1]===139)b=await bytes(new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')),64*1024*1024)
 signal?.throwIfAborted();const text=new TextDecoder('utf-8',{fatal:true}).decode(b),xml=new DOMParser().parseFromString(text,'image/svg+xml')
 if(xml.documentElement.localName!=='svg'||xml.querySelector('parsererror,script,foreignObject')||[...xml.querySelectorAll('*')].some(n=>[...n.attributes].some(a=>a.localName==='href'&&!a.value.startsWith('#'))))throw Error('SVG来源格式无效')
 return new Blob([text],{type:'image/svg+xml;charset=utf-8'})
}
