import { cachedJson, forgetRequest } from './request-cache'
export type Wm6Availability = { initializationTime: string; forecastZero: string; inProgress: boolean; hours: number[]; checkedAt: string }
export async function loadWm6Availability(signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Wm6Availability> {
  const path = '/api/wm6/availability', value = await cachedJson<Partial<Wm6Availability>>(path, signal, fetcher)
  const time = (item: unknown) => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(item) && Number.isFinite(Date.parse(item))
  if (!time(value.initializationTime) || !time(value.forecastZero) || !time(value.checkedAt) || typeof value.inProgress !== 'boolean' || !Array.isArray(value.hours) || value.hours.some(hour => !Number.isInteger(hour) || hour < 0 || hour > 312)) {
    forgetRequest(path, fetcher); throw new Error('上游可用版本資訊無效，不能確認是否最新。')
  }
  return value as Wm6Availability
}
