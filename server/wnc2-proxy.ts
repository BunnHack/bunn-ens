import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseCatalog, sourceUrl, type Cycle, type Model, type Run } from '../src/data/wnc2.ts'

const CACHE_MS = 5 * 60_000
export function candidateRuns(now: Date, model: Model, cycle: Cycle | 'latest', date?: string): Run[] {
  if (date && cycle !== 'latest') return [{ model, date, cycle }]
  const boundary = Math.floor(now.getTime() / 21_600_000) * 21_600_000
  const runs: Run[] = []
  for (let i = 0; i < 12; i++) {
    const time = new Date(boundary - i * 21_600_000)
    const runCycle = `${time.getUTCHours().toString().padStart(2, '0')}z` as Cycle
    if (cycle === 'latest' || cycle === runCycle) runs.push({ model, date: time.toISOString().slice(0, 10), cycle: runCycle })
  }
  return runs
}
export function createWnc2Proxy(fetcher: typeof fetch = fetch, now: () => Date = () => new Date()) {
  const cache = new Map<string, { csv: string; run: Run; checkedAt: string; expires: number }>()
  const missing = new Map<string, number>()
  const inFlight = new Map<string, Promise<{ csv: string; run: Run; checkedAt: string; expires: number }>>()
  return async function proxy(request: IncomingMessage, response: ServerResponse, next: () => void) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/api/wnc2') { next(); return }
    response.setHeader('Cache-Control', 'no-store')
    const fail = (code: number, message: string) => { response.statusCode = code; response.end(message) }
    if (request.method !== 'GET') { fail(405, 'GET required'); return }
    const model = url.searchParams.get('model') ?? 'FNV3P1'
    const cycle = url.searchParams.get('cycle') ?? 'latest'
    const date = url.searchParams.get('date') ?? undefined
    const parsedDate = date ? new Date(`${date}T00:00:00Z`) : null
    if (!['FNV3P1', 'FNV3P2'].includes(model) || !['latest', '00z', '06z', '12z', '18z'].includes(cycle)) { fail(400, 'Invalid model or cycle'); return }
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate!.getTime()) || parsedDate!.toISOString().slice(0,10) !== date || cycle === 'latest')) { fail(400, 'Invalid date or date/latest combination'); return }
    const clock = now()
    const runs = candidateRuns(clock, model as Model, cycle as Cycle | 'latest', date)
    const key = `${model}:${cycle}:${date ?? Math.floor(clock.getTime()/21_600_000)}`
    const cached = cache.get(key)
    const send = (payload: { csv: string; run: Run; checkedAt: string }) => { response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(payload)) }
    if (cached && cached.expires > clock.getTime()) { send(cached); return }
    const discover = async () => {
      for (const run of runs) {
        const upstreamUrl = sourceUrl(run)
        if ((missing.get(upstreamUrl) ?? 0) > clock.getTime()) continue
        const upstream = await fetcher(upstreamUrl, { signal: AbortSignal.timeout(20000) })
        if (upstream.status === 404) { missing.set(upstreamUrl, clock.getTime() + CACHE_MS); continue }
        if (!upstream.ok) throw new Error(`WeatherNext HTTP ${upstream.status}`)
        const csv = await upstream.text()
        if (csv.length > 10_000_000) throw new Error('CSV too large')
        const catalog = parseCatalog(csv)
        if (catalog.initTime !== `${run.date} ${run.cycle.slice(0,2)}:00:00`) throw new Error('Upstream initialization mismatch')
        const payload = { csv, run, checkedAt: clock.toISOString(), expires: clock.getTime() + CACHE_MS }
        cache.set(key, payload)
        return payload
      }
      throw new Error('No published WeatherNext run found in the last 72 hours')
    }
    try {
      let promise = inFlight.get(key)
      if (!promise) { promise = discover(); inFlight.set(key, promise) }
      send(await promise)
    } catch (error) { fail(502, error instanceof Error ? error.message : 'Unable to retrieve WeatherNext CSV') }
    finally { inFlight.delete(key) }
  }
}
export const wnc2Proxy = createWnc2Proxy()
