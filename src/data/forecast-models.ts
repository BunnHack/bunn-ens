export const FORECAST_BASE = 'https://bunnhack.github.io/bunn-ens/forecast-models/'
export const FORECAST_WORKFLOW = 'https://github.com/BunnHack/bunn-ens/actions/workflows/wm6-forecast-charts.yml'
export const forecastProducts = [
  { id: 'precip', group: 'Precip/Moisture', label: '6h Precip / MSLP / Thickness' },
  { id: 'wind', group: 'Lower Dynamics', label: '10m Wind / MSLP' },
  { id: 'upper', group: 'Upper Dynamics', label: '500 hPa Height / Temperature' },
  { id: 'temperature', group: 'Thermodynamics', label: '2m Temperature' },
] as const
export const forecastRegions = [{ id: 'east-asia', label: 'East Asia' }, { id: 'west-pacific', label: 'West Pacific' }, { id: 'north-america', label: 'North America' }] as const
export type ForecastProduct = typeof forecastProducts[number]['id']
export type ForecastRegion = typeof forecastRegions[number]['id']
export type ChartFiles = { png: string; svg: string }
export type ForecastFrame = { hour: number; validTime: string; files: Partial<Record<ForecastRegion, Partial<Record<ForecastProduct, ChartFiles>>>> }
export type ForecastRun = {
  id: string; initializationTime: string; forecastZero: string; generatedAt: string; upstreamInProgress: boolean; mslpCenters: boolean
  upstreamHours: number[]; requestedMaxHour: number; frames: ForecastFrame[]; failures: unknown[]
  animations: Partial<Record<ForecastRegion, Partial<Record<ForecastProduct, string>>>>
  trends: Partial<Record<ForecastRegion, Partial<Record<ForecastProduct, Record<string, string>>>>>
}
export type ForecastManifest = { version: 1; model: 'WM-6'; statistic: 'ensemble_mean'; ensembleSize: 128; resolutionDegrees: .25; runs: ForecastRun[] }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
function timestamp(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) }
function pathMatches(value: unknown, expected: string) { if (value !== expected) throw new Error('圖資路徑不符合固定來源／初始化／時效。') }
export function parseForecastManifest(value: unknown): ForecastManifest {
  if (!object(value) || value.version !== 1 || value.model !== 'WM-6' || value.statistic !== 'ensemble_mean' || value.ensembleSize !== 128 || value.resolutionDegrees !== .25 || !Array.isArray(value.runs) || value.runs.length < 1 || value.runs.length > 2) throw new Error('WM-6 圖資索引格式不正確。')
  const runs: ForecastRun[] = value.runs.map((run: unknown) => {
    if (!object(run) || typeof run.id !== 'string' || !/^\d{8}T\d{4}Z$/.test(run.id) || !timestamp(run.initializationTime) || !timestamp(run.forecastZero) || !timestamp(run.generatedAt) || !Array.isArray(run.frames) || run.frames.length < 1 || run.frames.length > 53 || !Array.isArray(run.upstreamHours) || run.upstreamHours.some((h: unknown) => !Number.isInteger(h) || Number(h) < 0 || Number(h) > 312)) throw new Error('初始化／時效資訊無效。')
    if (run.id !== new Date(run.initializationTime).toISOString().slice(0, 16).replace(/[-:]/g, '') + 'Z') throw new Error('初始化識別碼不一致。')
    const seen = new Set<number>()
    const frames = run.frames.map((frame: unknown): ForecastFrame => {
      if (!object(frame) || !Number.isInteger(frame.hour) || frame.hour < 0 || frame.hour > 312 || frame.hour % 6 !== 0 || seen.has(frame.hour) || !timestamp(frame.validTime) || Date.parse(frame.validTime) !== Date.parse(run.forecastZero) + frame.hour * 3600000 || !object(frame.files)) throw new Error('圖片時效與 forecast_zero 不一致。')
      seen.add(frame.hour)
      const files: ForecastFrame['files'] = {}
      for (const region of forecastRegions) {
        const group = frame.files[region.id]
        if (group === undefined) continue
        if (!object(group)) throw new Error('無效的區域圖資。')
        files[region.id] = {}
        for (const product of forecastProducts) {
          const file = group[product.id]
          if (file === undefined) continue
          if (!object(file)) throw new Error('無效的產品圖資。')
          const prefix = `runs/${run.id}/${region.id}/${product.id}/${String(frame.hour).padStart(3, '0')}`
          pathMatches(file.png, prefix + '.png'); if (file.svg !== prefix + '.svgz') pathMatches(file.svg, prefix + '.svg')
          files[region.id]![product.id] = { png: file.png, svg: file.svg }
        }
      }
      return { hour: frame.hour, validTime: frame.validTime, files }
    }).sort((a: ForecastFrame, b: ForecastFrame) => a.hour - b.hour)
    const animations: ForecastRun['animations'] = {}, trends: ForecastRun['trends'] = {}
    for (const region of forecastRegions) {
      animations[region.id] = {}; trends[region.id] = {}
      for (const product of forecastProducts) {
        const gif = run.animations?.[region.id]?.[product.id]
        if (gif !== undefined) { pathMatches(gif, `runs/${run.id}/${region.id}/${product.id}/forecast.gif`); animations[region.id]![product.id] = gif }
        const series = run.trends?.[region.id]?.[product.id]
        if (series !== undefined) {
          if (!object(series)) throw new Error('無效的趨勢動畫索引。')
          const valid: Record<string, string> = {}
          for (const frame of frames) {
            const gif = series[String(frame.hour)]
            if (gif !== undefined) { pathMatches(gif, `runs/${run.id}/${region.id}/${product.id}/trend-${String(frame.hour).padStart(3, '0')}.gif`); valid[String(frame.hour)] = gif }
          }
          trends[region.id]![product.id] = valid
        }
      }
    }
    return { id: run.id, initializationTime: run.initializationTime, forecastZero: run.forecastZero, generatedAt: run.generatedAt, upstreamInProgress: run.upstreamInProgress === true, mslpCenters: run.mslpCenters === true, upstreamHours: run.upstreamHours, requestedMaxHour: Number(run.requestedMaxHour) || 312, frames, failures: Array.isArray(run.failures) ? run.failures : [], animations, trends }
  })
  if (new Set(runs.map(run => run.id)).size !== runs.length) throw new Error('重複初始化。')
  return { version: 1, model: 'WM-6', statistic: 'ensemble_mean', ensembleSize: 128, resolutionDegrees: .25, runs }
}
export async function loadForecastManifest(signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<ForecastManifest> {
  const response = await fetcher(FORECAST_BASE + 'index.json', { signal, cache: 'no-cache', credentials: 'omit' })
  if (!response.ok) throw new Error(response.status === 404 ? 'GitHub Actions 尚未發布圖資。' : `圖資索引暫時無法讀取（HTTP ${response.status}）。`)
  const text = await response.text()
  if (text.length > 1024 * 1024) throw new Error('圖資索引過大。')
  return parseForecastManifest(JSON.parse(text))
}
export function availableForecastFrames(run: ForecastRun | undefined, region: ForecastRegion, product: ForecastProduct): ForecastFrame[] { return run?.frames.filter(frame => frame.files[region]?.[product]) ?? [] }
export function forecastAssetUrl(path: string): string {
  if (!/^runs\/\d{8}T\d{4}Z\/(?:east-asia|west-pacific|north-america)\/(?:precip|wind|upper|temperature)\/(?:\d{3}\.(?:png|svgz?)|forecast\.gif|trend-\d{3}\.gif)$/.test(path)) throw new Error('不允許的圖資來源。')
  return FORECAST_BASE + path
}
export async function forecastDownloadBlob(response: Response, path: string): Promise<Blob> {
  const blob = await response.blob()
  if (!path.endsWith('.svgz')) return blob
  const magic = new Uint8Array(await blob.slice(0, 2).arrayBuffer())
  let text: string
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('此瀏覽器不支援 SVG 解壓縮，請改用 PNG。')
    text = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text()
  } else text = await blob.text() // Some CDNs already decoded Content-Encoding: gzip.
  if (!/<svg[\s>]/.test(text.slice(0, 2048))) throw new Error('SVG 圖資內容無效，請改用 PNG。')
  return new Blob([text], { type: 'image/svg+xml;charset=utf-8' })
}
export function forecastUtc(value: string) { return value.replace('T', ' ').replace(/(?:\.000)?Z$/, ' UTC') }
