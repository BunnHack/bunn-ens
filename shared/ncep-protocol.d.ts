export type NcepModel = 'GEFS' | 'AIGEFS'
export type NcepKind = 'matched' | 'genesis' | 'derived_low'
export type NcepPoint = { hour:number; lat:number; lon:number; windKt:number|null; pressureHpa:number|null; windMs:number|null }
export type NcepTrack = { sample:number; trackId:string; sourceId:string; nativeMember:string; nativeBasin:string; nativeStormNumber:string; kind:NcepKind; sourceFile:string; method:string; endReason:string; points:NcepPoint[] }
export type NcepMember = { sample:number; nativeId:string; type:'control'|'perturbed'; tracker:'available'|'unavailable'; genesis:'available'|'unavailable'|'not_published'; duplicateGenesisOmitted:number }
export type NcepDataset = { schema:1; generator:'ncep-hybrid-v1'; model:NcepModel; run:string; checkedAt:string; horizonHours:number; ensembleSize:31; windUnit:'kt'; fieldWindUnit:'m/s'; pressureUnit:'hPa'; source:string; members:NcepMember[]; tracks:NcepTrack[]; failures:{sample:number;stage:'tracker'|'genesis'|'gridded';reason:string}[]; derived:{status:'pending'|'not_needed'|'available'|'partial'|'unavailable'; fields:number; expectedFields:number; membersComplete:number; duplicateFieldTracksOmitted:number; method:string} }
export const NCEP_ROOT: string
export const NCEP_GRID: string
export function ncepRun(v:unknown): v is string
export function ncepMember(model:NcepModel,sample:number):string
export function ncepDirectory(model:NcepModel,run:string):string
export function projectNcep(v:unknown,expectedModel?:NcepModel,requestedRun?:string):NcepDataset
