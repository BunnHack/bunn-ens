import { contours } from 'd3-contour'
import type { Catalog, TrackPoint } from './wnc2'
import { regionLongitude, type BasinRegion } from './basin'
import { visiblePlaces } from './map-geography'

type Vector = [number, number, number]
type Position = { lat: number; lon: number }
type Arc = { a: Vector; b: Vector; normal: Vector; angle: number; start: Position; lengthKm: number }
type Member = { sample: number; arcs: Arc[] }
export type ProbabilityField = { region: BasinRegion; radiusKm: number; maxLead: number; denominator: number; trackedMembers: number; step: number; columns: number; rows: number; values: number[]; contours: Array<{ level: number; rings: number[][][] }>; cities: Array<{ name: string; hits: number; percent: number; lat: number; lon: number }> }
const R = 6371.0088, rad = Math.PI / 180
const clamp = (v: number) => Math.max(-1, Math.min(1, v))
const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const vector = (p: Position): Vector => [Math.cos(p.lat * rad) * Math.cos(p.lon * rad), Math.cos(p.lat * rad) * Math.sin(p.lon * rad), Math.sin(p.lat * rad)]
function arc(from: Position, to: Position): Arc {
  const a = vector(from), b = vector(to), n = cross(a, b), size = Math.hypot(...n)
  const angle = size > 1e-12 ? Math.acos(clamp(dot(a, b))) : 0
  return { a, b, angle, normal: size > 1e-12 ? n.map(v => v / size) as Vector : [0, 0, 0], start: from, lengthKm: angle * R }
}
function interpolate(from: Position, to: Position, fraction: number): Position {
  const a = vector(from), b = vector(to), angle = Math.acos(clamp(dot(a, b)))
  if (angle < 1e-10) return from
  const p = a.map((v, i) => (v * Math.sin((1 - fraction) * angle) + b[i]! * Math.sin(fraction * angle)) / Math.sin(angle)) as Vector
  return { lat: Math.atan2(p[2], Math.hypot(p[0], p[1])) / rad, lon: Math.atan2(p[1], p[0]) / rad }
}
function distance(q: Vector, segment: Arc) {
  if (segment.angle < 1e-10) return Math.acos(clamp(dot(q, segment.a))) * R
  const along = Math.atan2(dot(cross(segment.a, q), segment.normal), dot(segment.a, q))
  if (along >= 0 && along <= segment.angle) return Math.asin(Math.min(1, Math.abs(dot(q, segment.normal)))) * R
  return Math.acos(clamp(Math.max(dot(q, segment.a), dot(q, segment.b)))) * R
}
function membersFor(catalog: Catalog, maxLead: number): Member[] {
  if (new Set(catalog.points.map(point => point.trackId)).size > 1) throw new Error('機率計算必須先選擇單一已匹配氣旋，不合併其他系統。')
  const groups = new Map<number, TrackPoint[]>()
  for (const point of catalog.points) {
    if (point.leadHours < 0 || point.leadHours > 312 || ![point.lat, point.lon].every(Number.isFinite)) continue
    const group = groups.get(point.sample) ?? []; group.push(point); groups.set(point.sample, group)
  }
  return [...groups].map(([sample, raw]) => {
    const points = [...raw].sort((a, b) => a.leadHours - b.leadHours)
    const arcs = points.filter(p => p.leadHours <= maxLead).map(p => arc(p, p))
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1]!, to = points[i]!, gap = to.leadHours - from.leadHours
      if (from.leadHours >= maxLead || gap <= 0 || gap > 12) continue
      const angle = Math.acos(clamp(dot(vector(from), vector(to))))
      if (angle >= Math.PI - 1e-6) continue // Antipodal/ambiguous arcs are never invented.
      const fraction = Math.min(1, (maxLead - from.leadHours) / gap), divisions = Math.max(1, Math.ceil(angle * R * fraction / 60))
      for (let part = 0; part < divisions; part++) arcs.push(arc(interpolate(from, to, fraction * part / divisions), interpolate(from, to, fraction * (part + 1) / divisions)))
    }
    return { sample, arcs }
  }).filter(member => member.arcs.length)
}
export function passageAt(catalog: Catalog, position: Position, denominator: number, radiusKm = 120, maxLead = 312) {
  const members = membersFor(catalog, Math.max(0, Math.min(312, maxLead)))
  if (!Number.isInteger(denominator) || denominator < members.length || denominator <= 1) throw new Error('需要完整系集分母；單成員路徑不能當作氣旋襲擊機率。')
  const q = vector(position), hits = members.filter(member => member.arcs.some(segment => distance(q, segment) <= radiusKm + 1e-6)).length
  return { hits, percent: hits / denominator * 100 }
}
export function passageField(catalog: Catalog, region: BasinRegion, denominator: number, radiusKm = 120, maxLead = 312): ProbabilityField {
  if (!Number.isFinite(radiusKm) || radiusKm < 30 || radiusKm > 500 || !Number.isFinite(maxLead)) throw new Error('Invalid probability radius/window')
  maxLead = Math.max(0, Math.min(312, maxLead))
  const members = membersFor(catalog, maxLead)
  if (!Number.isInteger(denominator) || denominator < members.length || denominator <= 1) throw new Error('需要完整系集分母；單成員路徑不能當作氣旋襲擊機率。')
  const spanX = region.east - region.west, spanY = region.north - region.south
  if (!(spanX > 0 && spanX <= 360 && spanY > 0 && spanY <= 180)) throw new Error('Invalid probability region')
  const step = Math.max(.15, spanX / 220, spanY / 180), columns = Math.ceil(spanX / step), rows = Math.ceil(spanY / step)
  const dx = spanX / columns, dy = spanY / rows, counts = new Uint16Array(columns * rows), visited = new Int32Array(counts.length)
  const grid = Array.from({ length: counts.length }, (_, index) => vector({ lon: region.west + (index % columns + .5) * dx, lat: region.north - (Math.floor(index / columns) + .5) * dy }))
  members.forEach((member, memberIndex) => {
    for (const segment of member.arcs) {
      const latPad = (radiusKm + segment.lengthKm + 1) / R / rad
      const maxLat = Math.min(89.99, Math.abs(segment.start.lat) + latPad)
      const lonPad = Math.min(180, latPad / Math.max(.001, Math.cos(maxLat * rad)))
      const lon = regionLongitude(segment.start.lon, region)
      const top = Math.max(0, Math.floor((region.north - segment.start.lat - latPad) / dy)), bottom = Math.min(rows - 1, Math.ceil((region.north - segment.start.lat + latPad) / dy))
      for (const copy of [-360, 0, 360]) {
        const left = Math.max(0, Math.floor((lon + copy - lonPad - region.west) / dx)), right = Math.min(columns - 1, Math.ceil((lon + copy + lonPad - region.west) / dx))
        for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) {
          const index = row * columns + col
          if (visited[index] === memberIndex + 1) continue
          if (distance(grid[index]!, segment) <= radiusKm + 1e-6) { visited[index] = memberIndex + 1; counts[index] = counts[index]! + 1 }
        }
      }
    }
  })
  const values = Array.from(counts, count => count / denominator * 100)
  const bands = contours().size([columns, rows]).thresholds([5, 25, 50, 75, 100])(values).map(band => ({ level: band.value, rings: band.coordinates.flatMap(polygon => polygon.map(ring => ring.map(point => [region.west + point[0]! * dx, region.north - point[1]! * dy]))) }))
  const cities = visiblePlaces(region).map(place => {
    const q = vector(place), hits = members.filter(member => member.arcs.some(segment => distance(q, segment) <= radiusKm + 1e-6)).length
    return { ...place, hits, percent: hits / denominator * 100 }
  }).filter(place => place.hits > 0).sort((a, b) => b.hits - a.hits).slice(0, 7)
  return { region, radiusKm, maxLead, denominator, trackedMembers: members.length, step, columns, rows, values, contours: bands, cities }
}
export function focusedProbabilityRegion(field: ProbabilityField): BasinRegion {
  const points = field.contours.find(band => band.level === 5)?.rings.flat() ?? []
  if (!points.length) return field.region
  const lons = points.map(point => point[0]!), lats = points.map(point => point[1]!)
  return { ...field.region, west: Math.max(field.region.west, Math.floor((Math.min(...lons) - 2) / 2.5) * 2.5), east: Math.min(field.region.east, Math.ceil((Math.max(...lons) + 2) / 2.5) * 2.5), south: Math.max(field.region.south, Math.floor((Math.min(...lats) - 2) / 2.5) * 2.5), north: Math.min(field.region.north, Math.ceil((Math.max(...lats) + 2) / 2.5) * 2.5) }
}
