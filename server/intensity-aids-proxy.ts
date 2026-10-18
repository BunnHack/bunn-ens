import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleIntensityAids } from '../public/_worker.js'
export async function intensityAidsProxy(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== '/api/intensity-aids') return next()
  const response = await handleIntensityAids(new Request(url, { method: req.method }), { waitUntil: p => { void p.catch(() => {}) } }, url)
  res.statusCode = response.status
  response.headers.forEach((value, name) => res.setHeader(name, value))
  res.end(await response.text())
}
