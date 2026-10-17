import type { TrackPoint } from './wnc2'

// These are paired observations at one point, not a pressure-to-wind conversion.
export function windPressureAudit(points: TrackPoint[]) {
  let minimumPressure: TrackPoint | null = null
  let maximumWind: TrackPoint | null = null
  let missingWind = 0, missingPressure = 0
  for (const point of points) {
    if (Number.isFinite(point.wind) && point.wind >= 0) {
      if (!maximumWind || point.wind > maximumWind.wind) maximumWind = point
    } else missingWind++
    if (point.pressure != null && Number.isFinite(point.pressure) && point.pressure > 0) {
      if (!minimumPressure || point.pressure < minimumPressure.pressure!) minimumPressure = point
    } else missingPressure++
  }
  return { minimumPressure, maximumWind, missingWind, missingPressure }
}
