import { cachedJson } from './request-cache'
import type { PotentialResult } from './potential'
export const aiModels = [
  { id: 'FUXI', label: '伏羲 FUXI', color: '#d34d35' },
  { id: 'FENGQING', label: '風清 FengQing', color: '#d68b00' },
  { id: 'FENGWU', label: '風烏 FengWu', color: '#ca48ae' },
  { id: 'PANGU', label: '盤古 Pangu', color: '#258245' },
  { id: 'AIFS', label: 'AIFS', color: '#1d50d2' },
  { id: 'GRAPHCAST', label: 'GraphCast', color: '#9c672b' },
  { id: 'FOURCASTNET', label: 'FourCastNet', color: '#008c9c' },
] as const
export type AiModel = typeof aiModels[number]['id']
export type AiPoint = { lat: number; lon: number; leadHours: number; validTime: string; windMs: number | null; pressureHpa: number | null; producedAt: string }
export type AiTrack = { model: AiModel; code: string; name: string; chineseName: string; basin: string; forecastZero: string; sourceEpoch: number | null; points: AiPoint[]; warnings: string[] }
export type AiResult = { tracks: AiTrack[]; checkedAt: string; source: string; transport: 'http' }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
export function aiUtc(value: unknown): string {
  const raw = text(value).replace(' ', 'T').replace(/Z$/, '')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) return ''
  const date = new Date(raw + 'Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === raw ? date.toISOString() : ''
}
export function parseAiResult(value: unknown, expectedCode?: string): AiResult {
  const root = record(value)
  if (!Array.isArray(root.entries) || root.entries.length > 200 || !Number.isFinite(Date.parse(String(root.checkedAt))) || root.transport !== 'http' || typeof root.source !== 'string' || !root.source.startsWith('http://ew4all.wmc-bj.net/EW4ALL/typh/api/cmes-typhoonOcean/api/tcRealtime/')) throw Error('AI 來源資料格式無效')
  if (expectedCode && root.cycloneCode !== expectedCode) throw Error('AI 氣旋來源編號不符')
  const tracks: AiTrack[] = []
  for (const item of root.entries) {
    const row = record(item), model = aiModels.find(m => m.id === row.FCSTType)
    const code = String(row.xuhao), name = text(row.enname).toUpperCase()
    if (!model || !/^[12]\d{7}$/.test(code) || (expectedCode && code !== expectedCode) || !name || !Array.isArray(row.points) || row.points.length > 2000) continue
    const valid = row.points.flatMap(value => {
      const p = record(value), base = aiUtc(p.datetime), time = aiUtc(p.validtime), h = p.fcsthour
      if (String(p.xuhao) !== code || p.fcsttype !== model.id || text(p.engname).toUpperCase() !== name || !base || !time || typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h > 312 || Date.parse(time) !== Date.parse(base) + h * 3600000 || typeof p.lat !== 'number' || typeof p.lon !== 'number' || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return []
      const pressure = typeof p.pressure === 'number' ? p.pressure : typeof p.pressure === 'string' && p.pressure.trim() ? Number(p.pressure) : NaN
      return [{ base, basin: text(p.zone), lat: p.lat, lon: p.lon, leadHours: h, validTime: time, windMs: typeof p.windv === 'number' && Number.isFinite(p.windv) && p.windv >= 0 ? p.windv : null, pressureHpa: Number.isFinite(pressure) && pressure > 0 ? pressure : null, producedAt: aiUtc(p.handletime) }]
    })
    const bases = [...new Set(valid.map(p => p.base))]
    if (bases.length !== 1) continue // Never silently combine different cycles of one model.
    const points = valid.filter(p => valid.filter(q => q.leadHours === p.leadHours).every(q => q.lat === p.lat && q.lon === p.lon && q.windMs === p.windMs && q.pressureHpa === p.pressureHpa)).filter((p,i,a) => a.findIndex(q => q.leadHours === p.leadHours) === i).sort((a,b) => a.leadHours - b.leadHours)
    if (!points.length || new Set(points.map(p => p.basin)).size !== 1) continue
    const warnings = []
    if (points.length !== row.points.length) warnings.push('無效、衝突或超出0–312h的點已排除；不補點。')
    const epoch = typeof row.time === 'number' && Number.isFinite(row.time) ? row.time : null
    if (epoch !== null && epoch * 1000 !== Date.parse(bases[0]!)) warnings.push('來源 time epoch 與點 datetime 不一致；依來源文件以點 datetime／validtime 的 UTC 對齊，不以 epoch 或產製時間代替起報。')
    tracks.push({ model: model.id, code, name, chineseName: text(row.cname), basin: points[0]!.basin, forecastZero: bases[0]!, sourceEpoch: epoch, points, warnings })
  }
  // One latest complete cycle per model and source cyclone; no blend of two runs.
  const latest = tracks.filter(t => !tracks.some(q => q.code === t.code && q.model === t.model && Date.parse(q.forecastZero) > Date.parse(t.forecastZero)))
  const unique = latest.filter((t,i,a) => a.findIndex(q => q.code === t.code && q.model === t.model) === i && latest.filter(q => q.code === t.code && q.model === t.model).every(q => JSON.stringify(q.points) === JSON.stringify(t.points)))
  return { tracks: unique, checkedAt: String(root.checkedAt), source: root.source, transport: 'http' }
}
export async function loadAi(code?: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<AiResult> {
  if (code !== undefined && !/^[12]\d{7}$/.test(code)) throw Error('AI 氣旋來源編號無效')
  return parseAiResult(await cachedJson('/api/wmc' + (code ? '?code=' + code : ''), signal, fetcher), code)
}
const distance = (a: {lat:number;lon:number}, b: {lat:number;lon:number}) => {
  const r = Math.PI / 180, dlat = (b.lat-a.lat)*r, dlon = (b.lon-a.lon)*r
  return 12742 * Math.asin(Math.min(1, Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dlon/2)**2)))
}
export type AiAssociation = { code: string; atcfId: string; name: string; fixes: number; maxKm: number; rule: string }
export function associateAi(catalog: AiResult | undefined, wm6: PotentialResult | undefined, atcfId: string): AiAssociation | null {
  const detail = wm6?.details[atcfId]
  const name = text(detail?.storm_name).toUpperCase()
  if (!catalog || !detail || !/^[A-Z]{2}\d{6}$/.test(atcfId) || !name || !Number.isFinite(Date.parse(detail.forecast_zero))) return null
  const basin = atcfId.slice(0,2), zones: Record<string,string[]> = { WP:['W'], EP:['E'], CP:['C'], AL:['L'], SH:['P','S'], SI:['S'], SP:['P'], NI:['B','A'], IO:['B','A'] }
  if (Object.entries(wm6!.details).some(([id, other]) => id !== atcfId && text(other.storm_name).toUpperCase() === name && (zones[id.slice(0,2)] ?? []).some(zone => (zones[basin] ?? []).includes(zone)))) return null
  const candidates = [...new Set(catalog.tracks.filter(t => t.name === name && (zones[basin] ?? []).includes(t.basin)).map(t => t.code))]
  const matches = candidates.flatMap(code => {
    const track = catalog.tracks.find(t => t.code === code && t.name === name)!
    const early = detail.mean_path.filter(p => Number.isFinite(p.forecast_hour) && p.forecast_hour >= 0 && p.forecast_hour <= 12 && Date.parse(p.valid_at) === Date.parse(detail.forecast_zero) + p.forecast_hour * 3600000).filter((p,i,a) => a.findIndex(q => q.valid_at === p.valid_at) === i)
    const pairs = early.flatMap(p => {
      const other = track.points.find(q => Date.parse(q.validTime) === Date.parse(p.valid_at))
      return other && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Math.abs(p.latitude)<=90 && Math.abs(p.longitude)<=360 ? [{time:Date.parse(p.valid_at),km:distance(other,{lat:p.latitude,lon:p.longitude})}] : []
    })
    const fixes = pairs.map(p=>p.km), span = Math.max(...pairs.map(p=>p.time))-Math.min(...pairs.map(p=>p.time))
    return fixes.length >= 2 && span >= 6*3600000 && fixes.every(km => km <= 250) ? [{code,atcfId,name,fixes:fixes.length,maxKm:Math.max(...fixes),rule:'本站名稱＋洋區＋同UTC早期至少2點／跨度≥6h／各≤250km對照；非供應商官方ATCF對照'}] : []
  })
  return matches.length === 1 ? matches[0]! : null
}
