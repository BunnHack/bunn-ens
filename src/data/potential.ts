import { eastLongitude, ensembleFromPoints, loadEnsemble, normalizeInit, sourceUrl, trackOptions, type Catalog, type Cycle, type MeanPoint, type TrackPoint } from './wnc2'
import { loadWm6, loadWm6Cyclone, type Wm6Cyclone, type Wm6CycloneDetail, type Wm6Point, type Wm6Response } from './wm6'
import type { BasinRegion } from './basin'
import { loadNcep } from './ncep'
import { cycloneLabel } from './cyclone-label'
import type { NcepDataset } from '../../shared/ncep-protocol.js'

export type PotentialModel = 'wn3' | 'wn2' | 'wm6' | 'genc' | 'gefs' | 'aigefs'
export type PotentialResult = { catalog: Catalog; source: 'remote' | 'snapshot'; checkedAt: string; warning?: string; url?: string; details: Record<string, Wm6CycloneDetail>; ncep?: NcepDataset; wm6?: { forecastZero: string; matchedCount: number; unmatchedCount: number; includedUnofficial: boolean } }
export const isUnmatchedWm6Id = (id: string) => !/^[A-Z]{2}\d{6}$/.test(id)
// Current provider-generated IDs encode the real ensemble member in _M###.
// Unknown ID formats must be resolved through detail, never assigned a made-up member.
export function generatedMember(id: string): number | null {
  const suffix = /_M(\d+)$/.exec(id)
  const member = suffix ? Number(suffix[1]) : NaN
  return Number.isSafeInteger(member) && member >= 0 ? member : null
}
export const potentialModels = [
  { id: 'wn3', label: 'WN3C', status: 'WNV3 · 可用' },
  { id: 'wn2', label: 'WN2C', status: 'FNV3P1 · 可用' },
  { id: 'wm6', label: 'WM-6', status: '可用' },
  { id: 'ecmwf', label: 'ECMWF', status: '未接入' },
  { id: 'aifs', label: 'AIFS', status: '未接入' },
  { id: 'gefs', label: 'GEFS', status: '31成员 · 0–120h · workflow成图' },
  { id: 'aigefs', label: 'AIGEFS', status: '31成员 · 0–240h · workflow成图' },
  { id: 'genc', label: 'GENC', status: 'OPER · 可用' },
]
export function wm6TrackPoint(point: Wm6Point, id: string, sample: number, initTime: string): TrackPoint | null {
  if (![point.latitude, point.longitude, point.forecast_hour].every(Number.isFinite) || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 360 || point.forecast_hour < 0 || point.forecast_hour > 312) return null
  return { sample, trackId: id, initTime, validTime: point.valid_at, leadHours: point.forecast_hour, lat: point.latitude, lon: eastLongitude(point.longitude), wind: point.max_wind_kt != null && Number.isFinite(point.max_wind_kt) && point.max_wind_kt >= 0 ? point.max_wind_kt : NaN, pressure: point.min_mslp_hpa != null && Number.isFinite(point.min_mslp_hpa) && point.min_mslp_hpa > 0 ? point.min_mslp_hpa : null }
}
export function wm6Catalog(details: Wm6CycloneDetail[], initialization: string, unmatched: Wm6Cyclone[] = []): Catalog {
  const initTime = normalizeInit(initialization)
  const points = details.flatMap(cyclone => (cyclone.members_path ?? []).flatMap(member => member.path.flatMap(point => {
    const converted = wm6TrackPoint(point, cyclone.tropical_cyclone_id, member.member, initTime)
    return converted ? [converted] : []
  })))
  for (const cyclone of unmatched) {
    const member = generatedMember(cyclone.tropical_cyclone_id)
    if (member == null) continue
    // Per API contract, unmatched list.path is already its single real member track.
    for (const point of cyclone.path ?? []) {
      const converted = wm6TrackPoint(point, cyclone.tropical_cyclone_id, member, initTime)
      if (converted) points.push(converted)
    }
  }
  return { initTime, points, totalSamples: new Set(points.map(point => point.sample)).size, rawMaxLead: points.reduce((max, point) => Math.max(max, point.leadHours), 0) }
}
export async function loadPotential(model: PotentialModel, run: string, signal?: AbortSignal, fetcher: typeof fetch = fetch, options: { includeUnofficial?: boolean } = {}): Promise<PotentialResult> {
  if (model === 'gefs' || model === 'aigefs') {
    const initialization=run==='latest'?'latest':`${run.split('|')[0]}T${run.split('|')[1]!.slice(0,2)}:00:00Z`
    return loadNcep(model==='gefs'?'GEFS':'AIGEFS',initialization,signal,fetcher)
  }
  if (model !== 'wm6') {
    const [date, cycle] = run.split('|')
    const result = await loadEnsemble({ model: model === 'genc' ? 'OPER' : model === 'wn3' ? 'WNV3' : 'FNV3P1', cycle: run === 'latest' ? 'latest' : cycle as Cycle, date: run === 'latest' ? undefined : date }, signal, fetcher)
    return { ...result, url: sourceUrl(result.run), details: {} }
  }
  const initialization = run === 'latest' ? 'latest' : `${run.split('|')[0]}T${run.split('|')[1]!.slice(0, 2)}:00:00Z`
  const includeUnofficial = options.includeUnofficial ?? true
  const list = await loadWm6({ initialization_time: initialization, include_details: true, include_unofficial_ids: includeUnofficial }, signal, fetcher) as Wm6Response
  if (initialization !== 'latest' && Date.parse(list.initialization_time) !== Date.parse(initialization)) throw new Error('WM-6 起報時間不符')
  const entries = Object.entries(list.tropical_cyclones).map(([id, cyclone]) => ({ ...cyclone, tropical_cyclone_id: id }))
  const unmatched = entries.filter(cyclone => isUnmatchedWm6Id(cyclone.tropical_cyclone_id) && generatedMember(cyclone.tropical_cyclone_id) != null && cyclone.path?.length)
  const summaryIds = new Set(unmatched.map(cyclone => cyclone.tropical_cyclone_id))
  // Fetch detail for matched storms and unknown/missing unmatched path formats only.
  const ids = Object.keys(list.tropical_cyclones).filter(id => !summaryIds.has(id))
  const details: Record<string, Wm6CycloneDetail> = {}, failures: string[] = []
  let cursor = 0
  // Bound detail concurrency; every request is pinned to the list initialization.
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, async () => {
    while (cursor < ids.length && !signal?.aborted) {
      const id = ids[cursor++]!
      try { details[id] = await loadWm6Cyclone(id, { initialization_time: list.initialization_time, include_members: true, include_cones: false }, signal, fetcher) }
      catch (error) { if (signal?.aborted) throw error; failures.push(id) }
    }
  }))
  signal?.throwIfAborted()
  const catalog = wm6Catalog(Object.values(details), list.initialization_time, unmatched)
  if (entries.length && !catalog.points.length && failures.length) throw new Error('WM-6 成員路徑載入失敗；不以平均路徑或錐形代替')
  return { catalog, source: 'remote', checkedAt: new Date().toISOString(), details, wm6: { forecastZero: list.forecast_zero, matchedCount: entries.filter(cyclone => !isUnmatchedWm6Id(cyclone.tropical_cyclone_id)).length, unmatchedCount: entries.filter(cyclone => isUnmatchedWm6Id(cyclone.tropical_cyclone_id)).length, includedUnofficial: includeUnofficial }, url: '/api/wm6?initialization_time=' + encodeURIComponent(list.initialization_time) + '&include_details=true&include_unofficial_ids=' + includeUnofficial, warning: failures.length ? `部分氣旋成員路徑載入失敗：${failures.join(', ')}。圖中不含這些氣旋，請重試。` : undefined }
}
export function cycloneChoices(result: PotentialResult) {
  return trackOptions(result.catalog).map(option => {
    const kind = result.wm6 && isUnmatchedWm6Id(option.key) ? 'unmatched' : option.key.startsWith('genesis:') ? 'genesis' : 'matched'
    const label=kind==='matched'?`${cycloneLabel(option.key)} · ${new Set(option.points.map(p=>p.sample)).size}${result.ncep?'/31':''} members`:result.ncep?`${option.points[0]!.nativeMember} / sample ${option.points[0]!.sample} · ${option.points[0]!.sourceKind} · ${option.points[0]!.sourceId}`:kind==='unmatched'?`${option.key} · 未匹配单成员 ${option.points[0]!.sample}`:option.label
    return { ...option, kind, label }
  })
}
export function cycloneCatalog(result: PotentialResult, key: string): Catalog {
  const option = cycloneChoices(result).find(item => item.key === key)
  return { ...result.catalog, points: option?.points ?? [] }
}
export function cycloneMean(result: PotentialResult, key: string): MeanPoint[] {
  const catalog = cycloneCatalog(result, key)
  if (result.ncep && !/^[A-Z]{2}\d{6}$/.test(key)) return [] // Genesis/field L identities are per member, not cross-member storms.
  if (result.wm6 && isUnmatchedWm6Id(key)) return [] // A single unmatched track is not an ensemble mean.
  const detail = result.details[key]
  if (detail) return detail.mean_path.flatMap(point => {
    const converted = wm6TrackPoint(point, key, 0, catalog.initTime)
    return converted ? [{ leadHours: converted.leadHours, lat: converted.lat, lon: converted.lon, wind: converted.wind, count: point.contributing_members_count ?? detail.matched_members ?? 0 }] : []
  })
  if (!catalog.points.length) return []
  const data = ensembleFromPoints(catalog.points, key)
  // Circular longitude mean avoids putting dateline-crossing storms at Greenwich.
  return data.mean.filter(point => point.count >= Math.ceil((result.ncep ? 31 : data.members.length) * .25)).map(mean => {
    const points = catalog.points.filter(point => point.leadHours === mean.leadHours)
    const rad = Math.PI / 180
    return { ...mean, lon: eastLongitude(Math.atan2(points.reduce((sum, point) => sum + Math.sin(point.lon * rad), 0), points.reduce((sum, point) => sum + Math.cos(point.lon * rad), 0)) / rad) }
  })
}
export function cycloneRegion(catalog: Catalog): BasinRegion {
  const reference = catalog.points[0]?.lon ?? 130
  const longitude = (lon: number) => reference + ((lon - reference + 540) % 360 + 360) % 360 - 180
  const lons = catalog.points.map(point => longitude(point.lon)), lats = catalog.points.map(point => point.lat)
  return { id: 'storm', label: '氣旋路徑', west: Math.floor((Math.min(reference, ...lons) - 3) / 5) * 5, east: Math.ceil((Math.max(reference, ...lons) + 3) / 5) * 5, south: Math.max(-90, Math.floor(((lats.length ? Math.min(...lats) : 0) - 3) / 5) * 5), north: Math.min(90, Math.ceil(((lats.length ? Math.max(...lats) : 0) + 3) / 5) * 5) }
}
