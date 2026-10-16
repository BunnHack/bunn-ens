import assert from 'node:assert/strict'
import { test } from 'node:test'
import worker from '../public/_worker.js'

const fixture = 'init_time,lead_time_hours,maximum_sustained_wind_speed_knots\n2026-10-13,0,30\n'
async function withRuntime(t, fetcher, run) {
  const entries = new Map(), pending = [], calls = []
  const original = globalThis.caches
  globalThis.caches = { default: {
    async match(request) { return entries.get(request.url)?.clone() },
    async put(request, response) { entries.set(request.url, response) },
  } }
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return fetcher(url, options) })
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-13T06:37:00Z') })
  const env = { ASSETS: { fetch: async () => new Response('static asset') } }
  const ctx = { waitUntil(promise) { pending.push(promise) } }
  const request = (query = '', method = 'GET', pathname = '/api/wnc2') => worker.fetch(new Request(`https://example.pages.dev${pathname}${query ? '?' + query : ''}`, { method }), env, ctx)
  try { await run({ request, calls, pending }); await Promise.all(pending) }
  finally { if (original === undefined) delete globalThis.caches; else globalThis.caches = original }
}

await test('Pages Worker discovers latest, returns frontend contract and caches five minutes', async t => {
  await withRuntime(t, url => url.includes('T06_00') ? new Response('', { status: 404 }) : new Response(fixture), async ({ request, calls, pending }) => {
    const response = await request('cycle=latest')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const payload = await response.json()
    assert.deepEqual(payload.run, { model: 'FNV3P1', date: '2026-10-13', cycle: '00z' })
    assert.equal(payload.csv, fixture)
    assert.equal(payload.checkedAt, '2026-10-13T06:37:00.000Z')
    assert.equal(calls.length, 2)
    assert.ok(calls.every(call => call.url.startsWith('https://deepmind.google.com/science/weatherlab/download/cyclones/')))
    assert.equal(calls[0].options.cf.cacheTtlByStatus['200-299'], 300)
    await Promise.all(pending)
    assert.equal((await request('cycle=latest')).status, 200)
    assert.equal(calls.length, 2)
  })
})
await test('Pages Worker manual date is exact; invalid requests never reach upstream', async t => {
  await withRuntime(t, () => new Response(fixture), async ({ request, calls }) => {
    assert.equal((await request('cycle=00z&date=2026-10-13')).status, 200)
    assert.equal(calls.length, 1)
    for (const query of ['model=other', 'cycle=09z', 'cycle=latest&date=2026-10-13', 'cycle=00z&date=2026-02-30']) assert.equal((await request(query)).status, 400)
    const post = await request('', 'POST')
    assert.equal(post.status, 405)
    assert.equal(post.headers.get('allow'), null)
    assert.equal(calls.length, 1)
    assert.equal(await (await request('', 'GET', '/images/infrared.png')).text(), 'static asset')
  })
})
await test('Pages Worker never hides permission failures by selecting an older run', async t => {
  await withRuntime(t, () => new Response('Forbidden', { status: 403 }), async ({ request, calls }) => {
    const response = await request()
    assert.equal(response.status, 502)
    assert.match((await response.json()).error, /403/)
    assert.equal(calls.length, 1)
  })
})
await test('Pages Worker rejects initialization mismatch and non-CSV upstream', async t => {
  for (const csv of [fixture.replace('2026-10-13,', '2026-10-12,'), '<html>error</html>']) {
    await withRuntime(t, () => new Response(csv), async ({ request }) => {
      assert.equal((await request('cycle=00z&date=2026-10-13')).status, 502)
    })
    t.mock.restoreAll()
    t.mock.timers.reset()
  }
})
await test('Pages Worker bounds upstream body before parsing', async t => {
  await withRuntime(t, () => new Response('x'.repeat(10_000_001)), async ({ request }) => {
    const response = await request('cycle=00z&date=2026-10-13')
    assert.equal(response.status, 502)
    assert.match((await response.json()).error, /size limit/)
  })
})
