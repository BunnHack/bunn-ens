import fineMap from './fine-map.json'
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
export const mapPlaces = [
  { name: '台北', lat: 25.033, lon: 121.5654 }, { name: '台中', lat: 24.1477, lon: 120.6736 },
  { name: '彰化', lat: 24.075, lon: 120.5439 }, { name: '雲林', lat: 23.7092, lon: 120.4313 },
  { name: '嘉義', lat: 23.4801, lon: 120.4491 }, { name: '苗栗', lat: 24.5602, lon: 120.8214 },
  { name: '花蓮', lat: 23.9872, lon: 121.6015 }, { name: '台東', lat: 22.7554, lon: 121.15 },
  { name: '高雄', lat: 22.6273, lon: 120.3014 }, { name: '香港', lat: 22.3193, lon: 114.1694 },
  { name: '那霸', lat: 26.2124, lon: 127.6809 }, { name: '鹿兒島', lat: 31.5966, lon: 130.5571 },
  { name: '東京', lat: 35.6762, lon: 139.6503 }, { name: '馬尼拉', lat: 14.5995, lon: 120.9842 },
  { name: 'Honolulu', lat: 21.3069, lon: -157.8583 }, { name: 'Miami', lat: 25.7617, lon: -80.1918 },
  { name: 'La Paz', lat: 24.1426, lon: -110.3128 }, { name: 'Darwin', lat: -12.4634, lon: 130.8456 },
]
export function visiblePlaces(region: BasinRegion) {
  return mapPlaces.filter(place => {
    const lon = regionLongitude(place.lon, region)
    return lon >= region.west && lon <= region.east && place.lat >= region.south && place.lat <= region.north
  })
}
