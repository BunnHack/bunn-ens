import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { handleWmc } from '../public/_worker.js'
export async function wmcProxy(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== '/api/wmc') return next()
  const response = await handleWmc(new Request(url, { method: req.method }), { WMC_AUTH: process.env.WMC_AUTH }, { waitUntil: promise => { void promise.catch(() => {}) } }, url, async bytes => createHash('md5').update(bytes).digest())
  res.statusCode = response.status
  response.headers.forEach((value, name) => res.setHeader(name, value))
  res.end(await response.text())
}
