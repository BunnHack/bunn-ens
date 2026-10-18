import type { Catalog, TrackPoint } from './wnc2'

export type MapTheme = 'light' | 'color' | 'dark'
export type BasinRegion = { id: string; label: string; west: number; east: number; south: number; north: number }
export const basinRegions: BasinRegion[] = [
  { id: 'china', label: '中國近海', west: 98, east: 154, south: 5, north: 49 },
  { id: 'wp', label: '西太平洋', west: 100, east: 180, south: 0, north: 60 },
  { id: 'scs', label: '中國南海', west: 105, east: 126, south: 0, north: 26 },
  { id: 'ecs', label: '中國東海', west: 118, east: 135, south: 20, north: 38 },
  { id: 'cp', label: '中北太平洋', west: 180, east: 220, south: 0, north: 45 },
  { id: 'ep', label: '東太平洋', west: 220, east: 280, south: 0, north: 45 },
  { id: 'al', label: '北大西洋', west: 260, east: 360, south: 0, north: 60 },
  { id: 'ni', label: '北印度洋', west: 40, east: 100, south: 0, north: 35 },
  { id: 'si', label: '南印度洋', west: 30, east: 120, south: -50, north: 0 },
  { id: 'sp', label: '南太平洋', west: 160, east: 260, south: -50, north: 0 },
  { id: 'au', label: '澳洲洋區', west: 90, east: 180, south: -50, north: 0 },
]
export const pressureCategories = [
  { label: '≤935 hPa', max: 935, color: '#b40075' },
  { label: '936–955 hPa', max: 955, color: '#ff4c23' },
  { label: '956–978 hPa', max: 978, color: '#ff9f00' },
  { label: '979–988 hPa', max: 988, color: '#c3c600' },
  { label: '989–1000 hPa', max: 1000, color: '#365cff' },
  { label: '>1000 hPa', max: Infinity, color: '#9bc9ef' },
]
export function pressureColor(pressure: number | null) {
  return pressure == null || !Number.isFinite(pressure) || pressure <= 0 ? '#8b929c' : pressureCategories.find(category => pressure <= category.max)!.color
}
export function regionLongitude(longitude: number, region: BasinRegion) {
  const center = (region.west + region.east) / 2
  return center + ((longitude - center + 540) % 360 + 360) % 360 - 180
}
export function pointInRegion(point: TrackPoint, region: BasinRegion) {
  const longitude = regionLongitude(point.lon, region)
  return longitude >= region.west && longitude <= region.east && point.lat >= region.south && point.lat <= region.north
}
export function basinTracks(catalog: Catalog, region: BasinRegion) {
  // Even matched IDs stay separate per sample; local numeric genesis IDs are never merged.
  const groups = new Map<string, TrackPoint[]>()
  for (const point of catalog.points) {
    const key = `${point.sample}:${point.trackId}`
    const group = groups.get(key) ?? []; group.push(point); groups.set(key, group)
  }
  return [...groups].filter(([, points]) => points.some(point => pointInRegion(point, region))).map(([key, points]) => ({ key, points: [...points].sort((a, b) => a.leadHours - b.leadHours) }))
}
export function basinCsv(points: TrackPoint[]) {
  const quoted = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
  const native=points.some(p=>p.sourceId!==undefined)
  return ['init_time,track_id,sample,valid_time,lead_time_hours,lat,lon,maximum_sustained_wind_speed_knots,minimum_sea_level_pressure_hpa'+(native?',original_source_id,native_member,source_kind,field_10m_max_vector_speed_ms_not_sustained_vmax':''), ...points.map(point => [point.initTime, point.trackId, point.sample, point.validTime, point.leadHours, point.lat, point.lon, Number.isFinite(point.wind) ? point.wind : null, point.pressure,...(native?[point.sourceId,point.nativeMember,point.sourceKind,point.fieldWindMs]:[])].map(quoted).join(','))].join('\n')
}
