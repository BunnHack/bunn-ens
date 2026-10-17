import type { Catalog } from './wnc2'
import { cycloneChoices, isUnmatchedWm6Id, type PotentialResult } from './potential'

export const rangePresets = [
  { id: 'short', label: '颱風襲擊潛勢', start: 0, end: 120 },
  { id: 'extended', label: '中遠期襲擊潛勢', start: 120, end: 312 },
] as const
export function windowCatalog(catalog: Catalog, start: number, end: number): Catalog {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 312 || start > end) throw new Error('Invalid forecast window')
  return { ...catalog, points: catalog.points.filter(point => point.leadHours >= start && point.leadHours <= end) }
}
export function potentialDenominator(result: PotentialResult, storm = 'all'): number {
  if (storm !== 'all' && cycloneChoices(result).find(option => option.key === storm)?.kind !== 'matched') throw new Error('單成員生成候選沒有跨成員氣旋身分，不能當成單一風暴系集機率。')
  if (storm === 'all' && result.wm6 && result.warning) throw new Error('此批路徑載入不完整，暫不計算全系統比例；請先重新載入。')
  if (storm === 'all' && result.wm6 && !result.wm6.includedUnofficial) throw new Error('全系統比例必須包含未匹配路徑，不能只用已命名氣旋。')
  let denominator: number | undefined
  if (!result.wm6) denominator = result.catalog.totalSamples
  else if (storm !== 'all') denominator = result.details[storm]?.ens_size
  else {
    const sizes = new Set(Object.entries(result.details).filter(([id]) => !isUnmatchedWm6Id(id)).map(([, value]) => value.ens_size).filter((size): size is number => Number.isInteger(size) && size! > 1))
    if (sizes.size === 1) denominator = [...sizes][0]
  }
  if (!Number.isInteger(denominator) || denominator! <= 1) throw new Error('缺少一致的供應商 ens_size／完整系集分母，不以有路徑的成員數代替。')
  return denominator!
}
export function windowValidTimes(result: PotentialResult, start: number, end: number) {
  const raw = result.wm6 ? result.wm6.forecastZero : result.catalog.initTime
  if (!raw) throw new Error('Missing forecast time anchor')
  const base = Date.parse(raw.replace(' ', 'T') + (/Z$|[+-]\d\d:\d\d$/.test(raw) ? '' : 'Z'))
  if (!Number.isFinite(base)) throw new Error('Invalid forecast time anchor')
  return [start, end].map(hour => new Date(base + hour * 3600000).toISOString())
}
