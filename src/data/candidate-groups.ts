import type { Catalog, MeanPoint, TrackPoint } from './wnc2'

// A conservative local association, NOT provider storm identity or calibrated genesis probability.
export const associationRules = { medianKm: 350, p80Km: 600, overlapHours: 24, comparisonHours: 48, startLagHours: 48, ambiguityKm: 75 } as const
type Vector = [number, number, number]
type Trajectory = { key: string; sample: number; trackId: string; points: TrackPoint[]; first: number; last: number; fixes: Map<number, Vector> }
export type CandidateGroup = { key: string; kind: 'cluster'; label: string; points: TrackPoint[]; members: number; tracks: Array<{ sample: number; trackId: string }>; seed: { sample: number; trackId: string }; firstLead: number }
const rad = Math.PI / 180, radius = 6371.0088
const vector = (point: { lat: number; lon: number }): Vector => [Math.cos(point.lat*rad)*Math.cos(point.lon*rad),Math.cos(point.lat*rad)*Math.sin(point.lon*rad),Math.sin(point.lat*rad)]
const dot = (a: Vector,b: Vector) => Math.max(-1,Math.min(1,a[0]*b[0]+a[1]*b[1]+a[2]*b[2]))
const distance = (a: Vector,b: Vector) => Math.acos(dot(a,b))*radius
function interpolate(a: Vector,b: Vector,fraction: number): Vector | null {
  const angle=Math.acos(dot(a,b))
  if (angle<1e-10) return a
  if (angle>Math.PI-1e-6) return null
  return a.map((value,i)=>(value*Math.sin((1-fraction)*angle)+b[i]!*Math.sin(fraction*angle))/Math.sin(angle)) as Vector
}
function trajectories(catalog: Catalog): Trajectory[] {
  const paths=new Map<string,TrackPoint[]>()
  for (const point of catalog.points) {
    if (/^[A-Z]{2}\d{6}$/.test(point.trackId) || !Number.isInteger(point.sample) || point.sample<0 || ![point.lat,point.lon,point.leadHours].every(Number.isFinite) || Math.abs(point.lat)>90 || point.leadHours<0 || point.leadHours>312) continue
    const key=`${point.sample}\0${point.trackId}`,path=paths.get(key)??[];path.push(point);paths.set(key,path)
  }
  const result: Trajectory[]=[]
  for (const [key,raw] of paths) {
    const points=[...raw].sort((a,b)=>a.leadHours-b.leadHours),unique=new Map<number,TrackPoint>();let ambiguous=false
    for (const point of points) {
      const prior=unique.get(point.leadHours)
      if (point.initTime!==catalog.initTime || (prior && (prior.lat!==point.lat || prior.lon!==point.lon))) { ambiguous=true;break }
      unique.set(point.leadHours,point)
    }
    if (ambiguous) continue
    const fixes=new Map<number,Vector>(),ordered=[...unique.values()]
    for (let i=0;i<ordered.length;i++) {
      const point=ordered[i]!,next=ordered[i+1],a=vector(point)
      if (point.leadHours%6===0) fixes.set(point.leadHours,a)
      if (!next || next.leadHours-point.leadHours>12 || next.leadHours<=point.leadHours) continue
      const b=vector(next)
      for (let hour=Math.ceil(point.leadHours/6)*6;hour<next.leadHours;hour+=6) {
        const value=interpolate(a,b,(hour-point.leadHours)/(next.leadHours-point.leadHours));if(value)fixes.set(hour,value)
      }
    }
    const first=points[0]!,last=points[points.length-1]!
    if (last.leadHours-first.leadHours>=associationRules.overlapHours) result.push({key,sample:first.sample,trackId:first.trackId,points:raw,first:first.leadHours,last:last.leadHours,fixes})
  }
  return result.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)
}
function affinity(a: Trajectory,b: Trajectory, allowSameMember = false): number | null {
  if ((!allowSameMember && a.sample===b.sample) || Math.abs(a.first-b.first)>associationRules.startLagHours) return null
  const start=Math.ceil(Math.max(a.first,b.first)/6)*6,end=Math.min(a.last,b.last,start+associationRules.comparisonHours)
  if(end-start<associationRules.overlapHours)return null
  const distances:number[]=[],hours:number[]=[]
  for(let hour=start;hour<=end;hour+=6) {
    const left=a.fixes.get(hour),right=b.fixes.get(hour);if(!left||!right)continue
    const km=distance(left,right)
    if(!hours.length && km>associationRules.p80Km)return null
    distances.push(km);hours.push(hour)
  }
  if(hours.length<3 || hours[hours.length-1]!-hours[0]!<associationRules.overlapHours)return null
  // A long common-data hole is not affirmative association evidence.
  if(hours.some((hour,i)=>i>0 && hour-hours[i-1]!>12))return null
  distances.sort((a,b)=>a-b)
  const median=(distances[Math.floor((distances.length-1)/2)]!+distances[Math.floor(distances.length/2)]!)/2,p80=distances[Math.floor((distances.length-1)*.8)]!
  return median<=associationRules.medianKm && p80<=associationRules.p80Km ? median : null
}
function stableKey(paths: Trajectory[]) {
  let hash=2166136261
  for(const char of paths.map(path=>path.key).sort().join('\n')) hash=Math.imul(hash^char.charCodeAt(0),16777619)
  return `local:${(hash>>>0).toString(36)}:${encodeURIComponent(paths.map(path=>path.key).sort()[0]!)}`
}
export function candidateGroups(catalog: Catalog): { groups: CandidateGroup[]; minimumMembers: number; note?: string } {
  const paths=trajectories(catalog),minimumMembers=Math.max(3,Math.ceil(catalog.totalSamples*.05))
  if(paths.length>2000)return{groups:[],minimumMembers,note:'獨立路徑過多，為避免阻塞頁面，本批保留原始路徑、不自動分群。'}
  const neighbors=paths.map(()=>[] as Array<{index:number;score:number}>),ambiguousSeeds=new Set<number>()
  for(let i=0;i<paths.length;i++)for(let j=i+1;j<paths.length;j++){
    if(paths[i]!.sample===paths[j]!.sample){if(affinity(paths[i]!,paths[j]!,true)!=null){ambiguousSeeds.add(i);ambiguousSeeds.add(j)}continue}
    const score=affinity(paths[i]!,paths[j]!);if(score==null)continue
    neighbors[i]!.push({index:j,score});neighbors[j]!.push({index:i,score})
  }
  const remaining=new Set(paths.map((_,i)=>i)),blocked=new Set<number>(),associated:Array<{paths:Trajectory[];seed:Trajectory}>=[]
  while(remaining.size>=minimumMembers){
    let seed=-1,best=minimumMembers-1
    for(const index of remaining){
      if(blocked.has(index)||ambiguousSeeds.has(index))continue
      const samples=new Set([paths[index]!.sample,...neighbors[index]!.filter(item=>remaining.has(item.index)).map(item=>paths[item.index]!.sample)])
      if(samples.size>best){seed=index;best=samples.size}
    }
    if(seed<0)break
    const bySample=new Map<number,Array<{index:number;score:number}>>()
    for(const item of neighbors[seed]!)if(remaining.has(item.index)){
      const sample=paths[item.index]!.sample,items=bySample.get(sample)??[];items.push(item);bySample.set(sample,items)
    }
    const selected=[seed]
    for(const items of bySample.values()){
      items.sort((a,b)=>a.score-b.score||a.index-b.index)
      // Two equally plausible paths from one member are left unassigned, not arbitrarily joined.
      if(items[1] && items[1].score-items[0]!.score<associationRules.ambiguityKm)continue
      selected.push(items[0]!.index)
    }
    if(selected.length<minimumMembers){blocked.add(seed);continue}
    associated.push({paths:selected.map(index=>paths[index]!),seed:paths[seed]!})
    selected.forEach(index=>remaining.delete(index))
  }
  associated.sort((a,b)=>Math.min(...a.paths.map(path=>path.first))-Math.min(...b.paths.map(path=>path.first)) || (a.seed.key<b.seed.key?-1:a.seed.key>b.seed.key?1:0))
  return { minimumMembers,groups:associated.map((item,index)=>({key:stableKey(item.paths),kind:'cluster',label:`本站 G${index+1} · ${item.paths.length} 成員`,points:item.paths.flatMap(path=>path.points),members:item.paths.length,tracks:item.paths.map(path=>({sample:path.sample,trackId:path.trackId})),seed:{sample:item.seed.sample,trackId:item.seed.trackId},firstLead:Math.min(...item.paths.map(path=>path.first))})) }
}
export function candidateMean(group: CandidateGroup): MeanPoint[] {
  const byHour=new Map<number,Map<number,TrackPoint>>()
  for(const point of group.points){const members=byHour.get(point.leadHours)??new Map<number,TrackPoint>();members.set(point.sample,point);byHour.set(point.leadHours,members)}
  const minimum=Math.max(3,Math.ceil(group.members*.25)),result:MeanPoint[]=[]
  for(const [leadHours,members] of byHour){
    if(members.size<minimum)continue
    const points=[...members.values()],sum=points.reduce((sum,point)=>{const v=vector(point);return sum.map((n,i)=>n+v[i]!) as Vector},[0,0,0] as Vector)
    if(Math.hypot(...sum)<members.size*.1)continue
    const winds=points.map(point=>point.wind).filter(wind=>Number.isFinite(wind)&&wind>=0)
    result.push({leadHours,lat:Math.atan2(sum[2],Math.hypot(sum[0],sum[1]))/rad,lon:((Math.atan2(sum[1],sum[0])/rad)%360+360)%360,wind:winds.length?winds.reduce((a,b)=>a+b,0)/winds.length:NaN,count:members.size})
  }
  return result.sort((a,b)=>a.leadHours-b.leadHours)
}
