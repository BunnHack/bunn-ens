// Same-tab public forecast JSON only. No credentials or private native grids are stored.
type Entry = { promise: Promise<unknown>; controller: AbortController; users: number; pending: boolean; expires: number }
const caches = new WeakMap<typeof fetch, Map<string, Entry>>()
function keyFor(url: string) {
  const value = new URL(url, 'https://forecast.invalid')
  if (value.origin !== 'https://forecast.invalid' || !/^\/api\/(wnc2|wm6|wmc)(?:\/|$)/.test(value.pathname)) throw new Error('Only same-origin public forecast JSON may be cached')
  value.searchParams.sort(); return value.pathname + value.search
}
export function clearRequestCache(fetcher: typeof fetch = fetch, prefix = '') {
  if (!prefix) { caches.delete(fetcher); return }
  const cache = caches.get(fetcher)
  if (cache) for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key)
}
export function forgetRequest(url: string, fetcher: typeof fetch = fetch) { caches.get(fetcher)?.delete(keyFor(url)) }
export function cachedJson<T>(url: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<T> {
  signal?.throwIfAborted()
  let cache = caches.get(fetcher)
  if (!cache) { cache = new Map(); caches.set(fetcher, cache) }
  const now = Date.now(), key = keyFor(url)
  for (const [name, entry] of cache) if (!entry.pending && entry.expires <= now) cache.delete(name)
  let entry = cache.get(key)
  if (!entry) {
    const controller = new AbortController()
    entry = { controller, users: 0, pending: true, expires: 0, promise: Promise.resolve() }
    const created = entry, owner = cache
    created.promise = (async () => {
      try {
        const response = await fetcher(url, { signal: controller.signal })
        if (!response.ok) throw new Error(`Forecast API returned HTTP ${response.status}`)
        const data: unknown = await response.json()
        controller.signal.throwIfAborted()
        created.expires = Date.now() + 300000
        return data
      } catch (error) { if (owner.get(key) === created) owner.delete(key); throw error }
      finally { created.pending = false }
    })()
    cache.set(key, created)
    if (cache.size > 24) for (const [name, old] of cache) { if (!old.pending && name !== key) { cache.delete(name); break } }
  }
  const shared = entry
  return new Promise<T>((resolve, reject) => {
    shared.users++
    let released = false
    const release = () => {
      if (released) return
      released = true; signal?.removeEventListener('abort', abort); shared.users--
      if (!shared.users && shared.pending) { if (cache.get(key) === shared) cache.delete(key); shared.controller.abort() }
    }
    const abort = () => { release(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    shared.promise.then(value => { release(); resolve(value as T) }, error => { release(); reject(error) })
  })
}
