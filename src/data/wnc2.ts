export type Cycle = '00z' | '06z' | '12z' | '18z'
export type Model = 'FNV3P1' | 'FNV3P2'
export type TrackPoint = { sample: number; trackId: string; initTime: string; validTime: string; leadHours: number; lat: number; lon: number; wind: number; pressure: number | null }
export type EnsembleMember = { sample: number; points: TrackPoint[]; maxWind: number }
export type MeanPoint = { leadHours: number; lat: number; lon: number; wind: number; count: number }
export type EnsembleData = { members: EnsembleMember[]; mean: MeanPoint[]; initTime: string; trackId: string }
export type Run = { model: Model; date: string; cycle: Cycle }
export type Catalog = { points: TrackPoint[]; initTime: string; totalSamples: number; rawMaxLead: number }
export type DataResult = { catalog: Catalog; run: Run; source: 'remote' | 'snapshot'; checkedAt: string; warning?: string }
export type LoadRequest = { model: Model; cycle: Cycle | 'latest'; date?: string }
export const MAX_LEAD_HOURS = 312
export const REFRESH_MS = 5 * 60_000
export const TRACK_ID = 'WP272026'
export const SNAPSHOT_RUN: Run = { model: 'FNV3P1', date: '2026-10-13', cycle: '00z' }
export const SNAPSHOT_URL = '/data/FNV3P1_2026_10_13T00_00_cyclogenesis.csv'
export function sourceUrl(run: Run) {
  return `https://deepmind.google.com/science/weatherlab/download/cyclones/${run.model}/ensemble/cyclogenesis/csv/${run.model}_${run.date.replace(/-/g, '_')}T${run.cycle.slice(0, 2)}_00_cyclogenesis.csv`
}
export function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index++ }
      else quoted = !quoted
    } else if (char === ',' && !quoted) { fields.push(value.trim()); value = '' }
    else value += char
  }
  if (quoted) throw new Error('Malformed CSV quoted field')
  fields.push(value.trim())
  return fields
}
const numeric = (value: string | undefined) => value?.trim() ? Number(value) : NaN
export const eastLongitude = (longitude: number) => ((longitude % 360) + 360) % 360
export function normalizeInit(value: string) {
  const normalized = value.trim().replace('T', ' ').replace(/Z$/, '')
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return `${normalized} 00:00:00`
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized) && Number.isFinite(Date.parse(normalized.replace(' ', 'T') + 'Z'))) return normalized
  throw new Error('Invalid initialization time')
}
export function parseCatalog(csv: string): Catalog {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'))
  if (lines.length < 2) throw new Error('CSV contains no forecast rows')
  const headers = parseCsvLine(lines[0]!)
  const required = ['init_time', 'track_id', 'sample', 'valid_time', 'lead_time_hours', 'lat', 'lon', 'maximum_sustained_wind_speed_knots']
  for (const field of required) if (!headers.includes(field)) throw new Error(`CSV missing ${field}`)
  const index = Object.fromEntries(headers.map((header, i) => [header, i]))
  const points: TrackPoint[] = []
  const samples = new Set<number>()
  let initTime = ''
  let rawMaxLead = 0
  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line)
    const get = (key: string) => fields[index[key]!]
    const sample = numeric(get('sample')), lat = numeric(get('lat')), lon = numeric(get('lon'))
    const leadHours = numeric(get('lead_time_hours')), wind = numeric(get('maximum_sustained_wind_speed_knots'))
    if (![sample, lat, lon, leadHours, wind].every(Number.isFinite) || !Number.isInteger(sample) || sample < 0 || Math.abs(lat) > 90 || Math.abs(lon) > 360 || leadHours < 0 || wind < 0) continue
    if (!get('init_time') || !get('valid_time') || !get('track_id')) continue
    const rowInit = normalizeInit(get('init_time')!)
    if (initTime && initTime !== rowInit) throw new Error('CSV contains mixed initialization times')
    initTime = rowInit
    const pressure = numeric(get('minimum_sea_level_pressure_hpa'))
    samples.add(sample)
    rawMaxLead = Math.max(rawMaxLead, leadHours)
    // All drawing, statistics and detection operate within the requested 13-day horizon.
    if (leadHours > MAX_LEAD_HOURS) continue
    points.push({ sample, trackId: get('track_id')!, initTime, validTime: get('valid_time')!, leadHours, lat, lon: eastLongitude(lon), wind, pressure: Number.isFinite(pressure) ? pressure : null })
  }
  if (!points.length) throw new Error('CSV contains no valid forecast points within 0–312h')
  return { points, initTime, totalSamples: samples.size, rawMaxLead }
}
export function ensembleFromPoints(points: TrackPoint[], trackId: string): EnsembleData {
  if (!points.length) throw new Error(`No valid tracks for ${trackId}`)
  const groups = new Map<number, TrackPoint[]>()
  for (const point of points) {
    const group = groups.get(point.sample) ?? []
    group.push(point); groups.set(point.sample, group)
  }
  const members = [...groups].sort(([a], [b]) => a - b).map(([sample, group]) => {
    const unique = [...new Map(group.map(point => [point.leadHours, point])).values()].sort((a, b) => a.leadHours - b.leadHours)
    return { sample, points: unique, maxWind: Math.max(...unique.map(point => point.wind)) }
  })
  const byLead = new Map<number, TrackPoint[]>()
  for (const member of members) for (const point of member.points) {
    const group = byLead.get(point.leadHours) ?? []
    group.push(point); byLead.set(point.leadHours, group)
  }
  const mean = [...byLead].sort(([a], [b]) => a - b).map(([leadHours, group]) => ({
    leadHours, count: group.length,
    lat: group.reduce((sum, point) => sum + point.lat, 0) / group.length,
    lon: group.reduce((sum, point) => sum + point.lon, 0) / group.length,
    wind: group.reduce((sum, point) => sum + point.wind, 0) / group.length,
  }))
  return { members, mean, initTime: points[0]!.initTime, trackId }
}
export function parseEnsembleCsv(csv: string, trackId = TRACK_ID) {
  return ensembleFromPoints(parseCatalog(csv).points.filter(point => point.trackId === trackId), trackId)
}
export type TrackOption = { key: string; label: string; points: TrackPoint[] }
export function trackOptions(catalog: Catalog): TrackOption[] {
  const groups = new Map<string, TrackPoint[]>()
  for (const point of catalog.points) {
    // Numeric genesis IDs are local to each sample, not global storm identities.
    const key = /^\d+$/.test(point.trackId) ? `genesis:${point.sample}:${point.trackId}` : point.trackId
    const group = groups.get(key) ?? []; group.push(point); groups.set(key, group)
  }
  return [...groups].map(([key, points]) => ({ key, points,
    label: key.startsWith('genesis:') ? `Member ${points[0]!.sample + 1} · genesis ID ${points[0]!.trackId} · +${Math.min(...points.map(point => point.leadHours))}h` : `${key} · ${new Set(points.map(point => point.sample)).size} members`,
  })).sort((a, b) => Number(a.key.startsWith('genesis:')) - Number(b.key.startsWith('genesis:')) || a.key.localeCompare(b.key))
}
function distanceKm(a: TrackPoint, b: TrackPoint) {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)))
}
export type Reidentified = { sample: number; id: string; endLead: number; startLead: number; lat: number; lon: number; distanceKm: number; points: TrackPoint[] }
export function analyze96W(catalog: Catalog) {
  const options = trackOptions(catalog)
  const official = options.find(option => /^WP96\d{4}/.test(option.key))
  if (!official) return null
  const members = ensembleFromPoints(official.points, official.key).members
  const reidentified: Reidentified[] = []
  for (const member of members) {
    const end = member.points[member.points.length - 1]!
    if (end.leadHours > 24) continue
    const candidates = options.filter(option => option.key.startsWith(`genesis:${member.sample}:`)).map(option => {
      const start = [...option.points].sort((a, b) => a.leadHours - b.leadHours)[0]!
      return { option, start, distance: distanceKm(end, start) }
    }).filter(({ start, distance }) => start.leadHours > end.leadHours && start.leadHours <= 24 && start.leadHours - end.leadHours <= 24 && distance <= 500)
      .sort((a, b) => a.distance - b.distance)
    const candidate = candidates[0]
    if (candidate) reidentified.push({ sample: member.sample, id: candidate.start.trackId, endLead: end.leadHours, startLead: candidate.start.leadHours, lat: candidate.start.lat, lon: candidate.start.lon, distanceKm: candidate.distance, points: candidate.option.points })
  }
  const laterGenesis = options.filter(option => option.key.startsWith('genesis:')).map(option => ({ option, start: [...option.points].sort((a, b) => a.leadHours - b.leadHours)[0]! }))
    .filter(({ start }) => start.leadHours >= 168 && start.lat >= 0 && start.lat <= 25 && start.lon >= 130 && start.lon <= 185)
  return { officialId: official.key, total: members.length, continuing: members.filter(member => member.points[member.points.length - 1]!.leadHours > 24).length, reidentified, laterGenesis }
}
export const categories = [
  { label: 'Category 5', min: 137, color: '#ef50ef' }, { label: 'Category 4', min: 113, color: '#800000' },
  { label: 'Category 3', min: 96, color: '#ff0000' }, { label: 'Category 2', min: 83, color: '#ff8000' },
  { label: 'Category 1', min: 64, color: '#f4d500' }, { label: 'Tropical Storm', min: 34, color: '#00aaff' },
  { label: 'Depression', min: 25, color: '#009e00' }, { label: 'Disturbance', min: 0, color: '#00e617' },
] as const
export const windCategory = (wind: number | null | undefined) => wind == null || !Number.isFinite(wind) || wind < 0 ? undefined : categories.find(category => wind >= category.min)
export const windColor = (wind: number) => windCategory(wind)?.color ?? '#00e617'
export async function loadEnsemble(request: LoadRequest, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<DataResult> {
  let remoteError = ''
  try {
    const query = new URLSearchParams({ model: request.model, cycle: request.cycle })
    if (request.date) query.set('date', request.date)
    const response = await fetcher(`/api/wnc2?${query}`, { signal })
    if (!response.ok) throw new Error(`Remote source returned HTTP ${response.status}`)
    const payload = await response.json() as { csv: string; run: Run; checkedAt: string }
    if (!payload.run || payload.run.model !== request.model || !['00z','06z','12z','18z'].includes(payload.run.cycle)) throw new Error('Invalid remote run metadata')
    if (request.cycle !== 'latest' && (payload.run.cycle !== request.cycle || (request.date && payload.run.date !== request.date))) throw new Error('Remote run does not match selected cycle/date')
    const catalog = parseCatalog(payload.csv)
    if (catalog.initTime !== `${payload.run.date} ${payload.run.cycle.slice(0, 2)}:00:00`) throw new Error('Remote initialization does not match metadata')
    return { catalog, run: payload.run, checkedAt: payload.checkedAt, source: 'remote' }
  } catch (error) {
    if (signal?.aborted) throw error
    remoteError = error instanceof Error ? error.message : 'Remote request failed'
  }
  if (request.model !== SNAPSHOT_RUN.model || (request.cycle !== 'latest' && (request.cycle !== SNAPSHOT_RUN.cycle || request.date !== SNAPSHOT_RUN.date))) throw new Error(`${remoteError}. No local snapshot is available for this run.`)
  const response = await fetcher(SNAPSHOT_URL, { signal })
  if (!response.ok) throw new Error(`Remote request failed; snapshot returned HTTP ${response.status}`)
  const catalog = parseCatalog(await response.text())
  if (catalog.initTime !== '2026-10-13 00:00:00') throw new Error('Snapshot initialization mismatch')
  return { catalog, run: SNAPSHOT_RUN, source: 'snapshot', checkedAt: new Date().toISOString(), warning: `${remoteError}. Using the 2026-10-13 00Z snapshot; this is NOT confirmation of the latest run.` }
}
