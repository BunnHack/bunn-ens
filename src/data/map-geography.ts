import fineMap from './fine-map.json'
import places from './map-places.json'
import { regionLongitude, type BasinRegion } from './basin'

type MapLine = { bounds: number[]; path: string }
// Lossless delta decoding of the quantized 1:50m geographic coordinates.
export function decodeMapLine(path: string): number[][] {
  const points: number[][] = [], previous = [0, 0]
  let cursor = 0
  while (cursor < path.length) {
    for (let axis = 0; axis < 2; axis++) {
      let value = 0, shift = 0, byte = 0
      do { byte = path.charCodeAt(cursor++) - 63; value |= (byte & 31) << shift; shift += 5 } while (byte >= 32 && cursor < path.length)
      previous[axis] = previous[axis]! + (value & 1 ? ~(value >>> 1) : value >>> 1)
    }
    points.push([previous[0]! / 10000, previous[1]! / 10000])
  }
  return points
}
export function geographicPaths(kind: 'land' | 'borders', region: BasinRegion) {
  const paths: string[] = []
  const x = (lon: number) => 62 + (lon - region.west) / (region.east - region.west) * 1110
  const y = (lat: number) => 85 + (region.north - lat) / (region.north - region.south) * 815
  for (const line of fineMap[kind] as MapLine[]) {
    const [west, south, east, north] = line.bounds as [number, number, number, number]
    if (north < region.south || south > region.north) continue
    for (let copy = Math.ceil((region.west - east) / 360); copy <= Math.floor((region.east - west) / 360); copy++) {
      paths.push(decodeMapLine(line.path).map((point, index) => `${index ? 'L' : 'M'}${x(point[0]! + copy * 360).toFixed(2)},${y(point[1]!).toFixed(2)}`).join(' ') + (kind === 'land' ? 'Z' : ''))
    }
  }
  return paths
}
// Display abbreviations, not station identifiers; full city names remain in tooltips.
export const mapPlaces = places
export function visiblePlaces(region: BasinRegion) {
  return mapPlaces.filter(place => {
    const lon = regionLongitude(place.lon, region)
    return lon >= region.west && lon <= region.east && place.lat >= region.south && place.lat <= region.north
  })
}
