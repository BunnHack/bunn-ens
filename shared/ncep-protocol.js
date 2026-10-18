/* Shared, side-effect-free trust boundary for Worker and browser. No I/O or secrets. */
export const NCEP_ROOT='https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod/'
export const NCEP_GRID='https://nomads.ncep.noaa.gov/pub/data/nccf/com/aigefs/prod/'
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)
const integer=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max
const text=(v,max,optional=false)=>{if(optional&&(v===undefined||v===null))return '';if(typeof v!=='string'||v.length>max)throw Error('Invalid NCEP source text');return v}
const scalar=(v,min,max)=>{if(v===null)return null;if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error('Invalid native NCEP value');return v}
const utc=v=>typeof v==='string'&&/^20\d{2}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().replace('.000Z','Z')===v
export const ncepRun=v=>utc(v)&&/T(?:00|06|12|18):00:00Z$/.test(v)
export const ncepMember=(model,sample)=>model==='AIGEFS'?'A'+String(sample).padStart(3,'0'):sample===0?'AC00':'AP'+String(sample).padStart(2,'0')
export const ncepDirectory=(model,run)=>`${NCEP_ROOT}${model.toLowerCase()}.${run.slice(0,10).replaceAll('-','')}/${run.slice(11,13)}/`
export function projectNcep(v,expectedModel,requestedRun='latest') {
  if(!object(v)||v.schema!==1||v.generator!=='ncep-hybrid-v1'||!['GEFS','AIGEFS'].includes(v.model)||expectedModel&&v.model!==expectedModel||!ncepRun(v.run)||requestedRun!=='latest'&&v.run!==requestedRun||!utc(v.checkedAt)||Date.parse(v.run)>Date.parse(v.checkedAt)||v.ensembleSize!==31||v.windUnit!=='kt'||v.fieldWindUnit!=='m/s'||v.pressureUnit!=='hPa'||v.horizonHours!==(v.model==='GEFS'?120:240)||v.source!==ncepDirectory(v.model,v.run)) throw Error('NCEP model/cycle/unit/ensemble identity mismatch')
  const {model,run}=v, directory=ncepDirectory(model,run), stamp=run.replaceAll('-','').replaceAll(':','').slice(0,11).replace('T',''), hour=run.slice(11,13)
  if(!Array.isArray(v.members)||v.members.length!==31||!Array.isArray(v.tracks)||!v.tracks.length||v.tracks.length>12000||!Array.isArray(v.failures)||v.failures.length>100||!object(v.derived)) throw Error('Invalid NCEP member/track publication')
  const ids=new Set()
  const members=v.members.map(m=>{
    if(!object(m)||!integer(m.sample,0,30)||ids.has(m.sample)||m.nativeId!==ncepMember(model,m.sample)||m.type!==(m.sample===0?'control':'perturbed')||!['available','unavailable'].includes(m.tracker)||!['available','unavailable','not_published'].includes(m.genesis)||model==='AIGEFS'&&m.genesis!=='not_published'||!integer(m.duplicateGenesisOmitted,0,10000))throw Error('Invalid NCEP native member')
    ids.add(m.sample)
    return {sample:m.sample,nativeId:m.nativeId,type:m.type,tracker:m.tracker,genesis:m.genesis,duplicateGenesisOmitted:m.duplicateGenesisOmitted}
  })
  const keys=new Set();let totalPoints=0
  const tracks=v.tracks.map(t=>{
    if(!object(t)||!integer(t.sample,0,30)||t.nativeMember!==ncepMember(model,t.sample)||!['matched','genesis','derived_low'].includes(t.kind)||typeof t.trackId!=='string'||t.trackId.length>160||t.trackId!==t.sourceId||keys.has(t.sample+'|'+t.kind+'|'+t.trackId)||!Array.isArray(t.points)||!t.points.length||t.points.length>41||model==='GEFS'&&t.kind==='derived_low'||model==='AIGEFS'&&t.kind==='genesis')throw Error('Invalid NCEP native track identity')
    keys.add(t.sample+'|'+t.kind+'|'+t.trackId)
    if(t.kind==='matched'&&!/^(?:AL|EP|CP|WP|IO|SH|SP|SI)(?:0[1-9]|[1-9]\d)20\d{2}$/.test(t.trackId)||t.kind==='genesis'&&!/^[A-Za-z0-9_-]{1,100}$/.test(t.trackId)||t.kind==='derived_low'&&!new RegExp('^L_AIGEFS_'+stamp+'_M'+String(t.sample).padStart(3,'0')+'_F\\d{3}_-?\\d{1,2}\\.\\d{2}_-?\\d{1,3}\\.\\d{2}$').test(t.trackId))throw Error('Invalid NCEP source ID format')
    const nativeBasin=text(t.nativeBasin,8,true),nativeStormNumber=text(t.nativeStormNumber,12,true)
    const member=ncepMember(model,t.sample).toLowerCase()
    const expectedSource=t.kind==='matched'?`${directory}tctrack/${member}.t${hour}z.cyclone.trackatcfunix`:t.kind==='genesis'?`${directory}genesis/storms.${member}.atcf_gen.altg.${run.slice(0,10).replaceAll('-','')}${hour}`:`${NCEP_GRID}aigefs.${run.slice(0,10).replaceAll('-','')}/${hour}/mem${String(t.sample).padStart(3,'0')}/`
    if(t.sourceFile!==expectedSource)throw Error('NCEP source locator mismatch')
    let last=-1
    const points=t.points.map(p=>{
      if(!object(p)||!integer(p.hour,0,v.horizonHours)||p.hour%6||p.hour<=last||t.kind==='derived_low'&&last>=0&&p.hour-last!==6)throw Error('Invalid NCEP native valid UTC/cadence')
      last=p.hour
      const q={hour:p.hour,lat:scalar(p.lat,-90,90),lon:scalar(p.lon,-180,180),windKt:scalar(p.windKt,1,250),pressureHpa:scalar(p.pressureHpa,800,1100),windMs:scalar(p.windMs,0,200)}
      if(q.lat===null||q.lon===null||(t.kind==='derived_low'?(q.windKt!==null||q.pressureHpa===null):(q.windMs!==null)))throw Error('Native tracker and field winds must remain statistically separate')
      return q
    })
    if(t.kind==='derived_low'&&(points.length<2||points[0].hour===0))throw Error('A new field L requires two consecutive post-initialization fixes')
    totalPoints+=points.length;if(totalPoints>100000)throw Error('NCEP point budget')
    return {sample:t.sample,trackId:t.trackId,sourceId:t.sourceId,nativeMember:t.nativeMember,nativeBasin,nativeStormNumber,kind:t.kind,sourceFile:t.sourceFile,method:text(t.method,1000),endReason:text(t.endReason,300,true),points}
  })
  const d=v.derived
  if(!['pending','not_needed','available','partial','unavailable'].includes(d.status)||!integer(d.fields,0,1271)||model==='GEFS'&&(d.status!=='not_needed'||d.fields!==0)||model==='AIGEFS'&&d.status==='not_needed'||d.status==='available'&&d.fields!==1271)throw Error('Invalid NCEP field coverage')
  const derived={status:d.status,fields:d.fields,expectedFields:d.expectedFields??(model==='AIGEFS'?1271:0),membersComplete:d.membersComplete??0,duplicateFieldTracksOmitted:d.duplicateFieldTracksOmitted??0,method:text(d.method,1000)}
  if(!integer(derived.expectedFields,0,1271)||!integer(derived.membersComplete,0,31)||!integer(derived.duplicateFieldTracksOmitted,0,10000))throw Error('Invalid NCEP grid member evidence')
  const failures=v.failures.map(f=>{if(!object(f)||!integer(f.sample,0,30)||!['tracker','genesis','gridded'].includes(f.stage))throw Error('Invalid NCEP failure metadata');return {sample:f.sample,stage:f.stage,reason:text(f.reason,300)}})
  return {schema:1,generator:'ncep-hybrid-v1',model,run,checkedAt:v.checkedAt,horizonHours:v.horizonHours,ensembleSize:31,windUnit:'kt',fieldWindUnit:'m/s',pressureUnit:'hPa',source:directory,members,tracks,failures,derived}
}
