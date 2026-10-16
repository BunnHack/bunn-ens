import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { compileFile } from './compile.mjs'
const { candidateRuns, createWnc2Proxy } = await import(await compileFile('server/wnc2-proxy.ts'))
const csv = await readFile(new URL('../public/data/FNV3P1_2026_10_13T00_00_cyclogenesis.csv', import.meta.url), 'utf8')
async function request(proxy, url, method = 'GET') {
  const response = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value }, end(body) { this.body = body } }
  await proxy({ url, method }, response, () => { response.statusCode = 404 })
  return response
}
await test('Discovery rounds UTC to six-hour slots and crosses day/year boundaries', () => {
  const runs = candidateRuns(new Date('2027-01-01T01:00:00Z'), 'FNV3P1', 'latest')
  assert.deepEqual(runs.slice(0, 3), [
    { model: 'FNV3P1', date: '2027-01-01', cycle: '00z' },
    { model: 'FNV3P1', date: '2026-12-31', cycle: '18z' },
    { model: 'FNV3P1', date: '2026-12-31', cycle: '12z' },
  ])
  assert.equal(runs.length, 12)
  assert.ok(candidateRuns(new Date('2026-10-13T06:37:00Z'), 'FNV3P1', '00z').every(run => run.cycle === '00z'))
})
await test('Latest discovers published 00z after missing 06z, caches then checks again', async () => {
  let now = new Date('2026-10-13T06:37:00Z')
  const calls = []
  const proxy = createWnc2Proxy(async url => {
    calls.push(url)
    return url.includes('T06_00') ? new Response('Missing', { status: 404 }) : new Response(csv)
  }, () => now)
  const first = await request(proxy, '/api/wnc2?model=FNV3P1&cycle=latest')
  assert.equal(first.statusCode, 200)
  assert.deepEqual(JSON.parse(first.body).run, { model: 'FNV3P1', date: '2026-10-13', cycle: '00z' })
  assert.equal(calls.length, 2)
  await request(proxy, '/api/wnc2?model=FNV3P1&cycle=latest')
  assert.equal(calls.length, 2)
  now = new Date('2026-10-13T06:43:00Z')
  await request(proxy, '/api/wnc2?model=FNV3P1&cycle=latest')
  assert.equal(calls.length, 4)
})
await test('Manual run is exact; unknown model/date and non-GET rejected', async () => {
  const calls = []
  const proxy = createWnc2Proxy(async url => { calls.push(url); return new Response(csv) })
  assert.equal((await request(proxy, '/api/wnc2?model=FNV3P1&cycle=00z&date=2026-10-13')).statusCode, 200)
  assert.equal(calls.length, 1)
  for (const query of ['model=other', 'cycle=09z', 'cycle=00z&date=2026-99-99', 'date=2026-10-13&cycle=latest']) {
    assert.equal((await request(proxy, '/api/wnc2?' + query)).statusCode, 400)
  }
  assert.equal((await request(proxy, '/api/wnc2', 'POST')).statusCode, 405)
})
await test('Network/permission errors do not falsely confirm an older run as latest', async () => {
  let calls = 0
  const proxy = createWnc2Proxy(async () => { calls++; return new Response('Forbidden', { status: 403 }) })
  assert.equal((await request(proxy, '/api/wnc2?cycle=latest')).statusCode, 502)
  assert.equal(calls, 1)
})
