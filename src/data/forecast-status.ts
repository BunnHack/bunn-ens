export function publicationStatus(published: { initializationTime: string; forecastZero: string }, upstream: { initializationTime: string; forecastZero: string }): string {
  const selected = Date.parse(published.initializationTime), latest = Date.parse(upstream.initializationTime)
  if (latest > selected) return '本圖集較舊，等待排程產圖；不宣稱為最新模式。'
  if (latest < selected) return '可用版本查詢落後於所選圖集，暫不能確認最新性。'
  if (Date.parse(published.forecastZero) !== Date.parse(upstream.forecastZero)) return '相同版本的預報基準不一致，暫不能確認最新性。'
  return '所選版本與此次查詢的最新版本一致；不保證即時。'
}
