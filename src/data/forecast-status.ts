export function publicationStatus(published: { initializationTime: string; forecastZero: string }, upstream: { initializationTime: string; forecastZero: string }): string {
  const selected = Date.parse(published.initializationTime), latest = Date.parse(upstream.initializationTime), base = Date.parse(published.forecastZero), upstreamBase = Date.parse(upstream.forecastZero)
  if (latest === selected && base !== upstreamBase) return '相同版本的預報基準不一致，暫不能確認最新性。'
  if (upstreamBase > base) return '本圖集基準較舊，等待新預報基準產圖；不宣稱為最新模式。'
  if (upstreamBase < base || latest < selected) return '可用版本查詢落後於所選圖集，暫不能確認最新性。'
  if (latest > selected) return '同一預報基準，保留已產圖的固定供應商版本，不因小時版本重產。版本仍不同，未宣稱其數值相同或本圖是最新版本。'
  return '所選版本與此次查詢的最新版本一致；不保證即時。'
}
