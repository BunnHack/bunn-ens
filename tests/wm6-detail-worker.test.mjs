import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../public/_worker.js'
const env = { WM_API_KEY: 'test-key', ASSETS: { fetch: async () => new Response('asset') } }
const detail = JSON.stringify({ tropical_cyclone_id: 'WP292026', initialization_time: '2026-10-15T11:00:00Z', mean_path: [{ forecast_hour: 0 }], members_path: [{ member: 0, path: [{ forecast_hour: 0 }] }], cones: [{ members_total: 128 }] })
async function invoke(t, upstream, pathname, query = '') {
  const calls = []
  const originalCaches = globalThis.caches
  globalThis.caches = { default: { async match() { return undefined }, async put() {} } }
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url: String(url), options }); return upstream(url, options) })
  try { return { response: await worker.fetch(new Request(`https://example.test${pathname}${query ? `?${query}` : ''}`), env, { waitUntil() {} }), calls } }
  finally { globalThis.caches = originalCaches }
}
await test('WM-6 detail proxy forces cone removal while retaining member paths', async t => {
  const { response, calls } = await invoke(t, () => new Response(detail), '/api/wm6/WP292026', 'initialization_time=latest&include_members=true&include_cones=true')
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.members_path.length, 1)
  assert.equal('cones' in payload, false)
  assert.match(calls[0].url, /include_cones=false/)
  assert.match(calls[0].url, /tropical_cyclones\/WP292026\?/) 
  assert.match(calls[0].url, /include_members=true/)
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-key')
})
await test('WM-6 detail proxy validates IDs and parameters', async t => {
  for (const [pathname, query] of [['/api/wm6/not%20valid', ''], ['/api/wm6/WP292026', 'include_members=yes'], ['/api/wm6/WP292026', 'initialization_time=bad']]) assert.equal((await invoke(t, () => new Response(detail), pathname, query)).response.status, 400)
})
