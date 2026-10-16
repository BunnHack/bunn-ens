import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../public/_worker.js'
const env = { WM_API_KEY: 'test-key', ASSETS: { fetch: async () => new Response('asset') } }
const fixture = JSON.stringify({ initialization_time: '2026-10-15T10:00:00Z', forecast_zero: '2026-10-15T06:00:00Z', tropical_cyclones: {}, total: 0 })
async function invoke(t, upstream, query = '', method = 'GET') {
  const calls = []
  const originalCaches = globalThis.caches
  const entries = new Map()
  globalThis.caches = { default: { async match(request) { return entries.get(request.url)?.clone() }, async put(request, response) { entries.set(request.url, response) } } }
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url: String(url), options }); return upstream(url, options) })
  try { return { response: await worker.fetch(new Request(`https://example.test/api/wm6${query ? `?${query}` : ''}`, { method }), env, { waitUntil: promise => promise }), calls } }
  finally { globalThis.caches = originalCaches }
}
await test('WM-6 proxy authenticates upstream, forwards supported options and validates JSON', async t => {
  const { response, calls } = await invoke(t, () => new Response(fixture), 'initialization_time=latest&basin=EP&include_details=true&format=json')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), JSON.parse(fixture))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.headers.authorization, 'Bearer test-key')
  assert.match(calls[0].url, /basin=EP/)
})
await test('WM-6 proxy removes cone data from JSON and GeoJSON', async t => {
  const list = { ...JSON.parse(fixture), tropical_cyclones: { WP292026: { path: [], cone: { members_total: 128 } } } }
  const { response } = await invoke(t, () => Response.json(list))
  assert.equal('cone' in (await response.json()).tropical_cyclones.WP292026, false)
  const features = [
    { properties: { feature_type: 'cone' }, geometry: { type: 'Polygon' } },
    { properties: { feature_type: 'path' }, geometry: { type: 'LineString' } },
    { properties: { feature_type: 'landfall' }, geometry: { type: 'Point' } },
  ]
  const geojson = await invoke(t, () => Response.json({ type: 'FeatureCollection', features }), 'format=geojson&include_details=true')
  assert.deepEqual((await geojson.response.json()).features, features.slice(1))
})
await test('WM-6 proxy validates parameters and rejects non-GET', async t => {
  for (const query of ['basin=XX', 'format=xml', 'include_details=yes', 'initialization_time=bad']) assert.equal((await invoke(t, () => new Response(fixture), query)).response.status, 400)
  assert.equal((await invoke(t, () => new Response(fixture), '', 'POST')).response.status, 405)
})
