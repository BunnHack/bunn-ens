import { FORECAST_BASE, forecastAssetUrl } from './forecast-models'
export type ForecastImage = { url: string; label: string }
export type PreparedImages = { urls: Map<string, string>; dispose: () => void }
const MAX_BYTES = 64 * 1024 * 1024
export function checkAbort(signal: AbortSignal) { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError') }
export async function publicForecastPng(url: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Blob> {
  const parsed = new URL(url), root = new URL(FORECAST_BASE)
  if (parsed.origin !== root.origin || !parsed.pathname.startsWith(root.pathname) || !/\.png$/.test(parsed.pathname) || [...parsed.searchParams.keys()].some(key => key !== 'publication')) throw new Error('Only published forecast PNG assets may be loaded')
  forecastAssetUrl(parsed.pathname.slice(root.pathname.length))
  checkAbort(signal)
  const response = await fetcher(url, { signal, credentials: 'omit', cache: 'force-cache' })
  if (!response.ok) throw new Error(`圖片預載失敗（HTTP ${response.status}）`)
  if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw new Error('圖片超出大小上限')
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0
  if (!reader) throw new Error('圖片內容不可用')
  try { for (;;) { checkAbort(signal); const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 8 * 1024 * 1024) throw new Error('圖片超出大小上限'); chunks.push(value) } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  if (size < 24 || ![137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value)) throw new Error('圖片不是有效PNG；不開始播放')
  const view = new DataView(bytes.buffer), width = view.getUint32(16), height = view.getUint32(20)
  if (!width || !height || width > 4096 || height > 4096) throw new Error('圖片尺寸不合規')
  checkAbort(signal); return new Blob([bytes], { type: 'image/png' })
}
/** Keep compressed PNG bytes, not dozens of decoded 1820×1300 RGBA buffers. */
export async function preloadForecastImages(items: ForecastImage[], signal: AbortSignal, progress: (done: number, total: number) => void = () => {}, fetcher: typeof fetch = fetch): Promise<PreparedImages> {
  if (!items.length || items.length > 60) throw new Error('沒有合規的播放圖片')
  const urls = new Map<string, string>(), unique = [...new Set(items.map(item => item.url))]; let index = 0, bytes = 0, done = 0
  const local = new AbortController(), abort = () => local.abort(); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  const dispose = () => { for (const url of urls.values()) URL.revokeObjectURL(url); urls.clear() }
  try {
    await Promise.all(Array.from({ length: Math.min(3, unique.length) }, async () => {
      for (;;) { checkAbort(local.signal); const url = unique[index++]; if (!url) return
        const blob = await publicForecastPng(url, local.signal, fetcher); bytes += blob.size
        if (bytes > MAX_BYTES) throw new Error('完整動畫圖片超過64MiB；未啟動播放')
        checkAbort(local.signal); urls.set(url, URL.createObjectURL(blob)); progress(++done, unique.length)
      }
    }))
    checkAbort(signal); return { urls, dispose }
  } catch (error) { local.abort(); dispose(); throw error }
  finally { signal.removeEventListener('abort', abort) }
}
export async function forecastGifBlob(items: ForecastImage[], fps: number, signal: AbortSignal, progress: (done: number, total: number) => void, cached: ReadonlyMap<string,string> = new Map()): Promise<Blob> {
  if (!items.length || items.length > 60 || !Number.isFinite(fps) || fps < 1 || fps > 12) throw new Error('GIF設定無效')
  const module = await import('gifenc'), { GIFEncoder, quantize, applyPalette } = typeof module.GIFEncoder === 'function' ? module : module.default
  const gif = GIFEncoder(), canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('瀏覽器不支援GIF畫布')
  let width = 0, height = 0
  for (let i = 0; i < items.length; i++) {
    checkAbort(signal); const item = items[i]!, existing = cached.get(item.url), url = existing ?? URL.createObjectURL(await publicForecastPng(item.url, signal))
    const image = new Image()
    try {
      await new Promise<void>((resolve, reject) => { const abort = () => { image.src = ''; reject(new DOMException('Cancelled', 'AbortError')) }; signal.addEventListener('abort', abort, { once: true }); image.onload = () => { signal.removeEventListener('abort', abort); resolve() }; image.onerror = () => { signal.removeEventListener('abort', abort); reject(new Error(`無法解碼 ${item.label}`)) }; image.src = url; if (signal.aborted) abort() })
      checkAbort(signal)
      if (!width) { const scale = Math.min(1, 910 / image.naturalWidth, 650 / image.naturalHeight); width = Math.round(image.naturalWidth * scale); height = Math.round(image.naturalHeight * scale); canvas.width = width; canvas.height = height }
      if (!image.naturalWidth || !image.naturalHeight || Math.abs(image.naturalWidth / image.naturalHeight - width / height) > .015) throw new Error('圖片尺寸不一致，不混接GIF')
      context.fillStyle = '#fff'; context.fillRect(0, 0, width, height); context.drawImage(image, 0, 0, width, height)
      const rgba = context.getImageData(0, 0, width, height).data, palette = quantize(rgba, 256, { format: 'rgb444' }), indexed = applyPalette(rgba, palette, 'rgb444')
      gif.writeFrame(indexed, width, height, { palette, delay: Math.round(1000 / fps), repeat: 0, dispose: 1 }); progress(i + 1, items.length)
    } finally { image.onload = null; image.onerror = null; image.src = ''; if (!existing) URL.revokeObjectURL(url) }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  checkAbort(signal); gif.finish(); const bytes = gif.bytes(); return new Blob([new Uint8Array(bytes)], { type: 'image/gif' })
}
