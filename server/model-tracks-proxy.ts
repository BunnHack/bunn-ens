import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleModelTracks } from '../public/_worker.js'
export async function modelTracksProxy(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== '/api/model-tracks') return next()
  const response = await handleModelTracks(new Request(url, { method: req.method }), { waitUntil: promise => { void promise.catch(() => {}) } }, url)
  res.statusCode = response.status
  response.headers.forEach((value, name) => res.setHeader(name, value))
  res.end(await response.text())
}
