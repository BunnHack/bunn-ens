import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadWm6, loadWm6Cyclone } from '../src/data/wm6.ts'

const sample = { initialization_time: '2026-10-15T10:00:00Z', forecast_zero: '2026-10-15T06:00:00Z', tropical_cyclones: { EP202026: { tropical_cyclone_id: 'EP202026' } }, total: 1 }
await test('WM-6 client requests latest detailed JSON and parses response', async () => {
  let requested = ''
  const result = await loadWm6({ initialization_time: 'latest', basin: 'EP', include_details: true, format: 'json' }, undefined, async url => { requested = String(url); return Response.json(sample) })
  assert.match(requested, /\/api\/wm6\?/) 
  assert.match(requested, /initialization_time=latest/)
  assert.match(requested, /basin=EP/)
  assert.match(requested, /include_details=true/)
  assert.deepEqual(result, sample)
})
await test('WM-6 client surfaces API errors', async () => {
  await assert.rejects(() => loadWm6({}, undefined, async () => new Response('bad', { status: 502 })), /HTTP 502/)
})
await test('WM-6 detail pins selected run and requests real member tracks', async () => {
  const run = '2026-10-15T10:00:00Z'
  let requested = ''
  const detail = { tropical_cyclone_id: 'WP292026', initialization_time: run, mean_path: [], members_path: [{ member: 0, path: [] }], cones: [] }
  const result = await loadWm6Cyclone('WP292026', { initialization_time: run, include_members: true, include_cones: true }, undefined, async url => { requested = String(url); return Response.json(detail) })
  assert.match(requested, /\/api\/wm6\/WP292026/)
  assert.match(requested, /include_members=true/)
  assert.ok(requested.includes(encodeURIComponent(run)))
  assert.equal(result.members_path.length, 1)
  await assert.rejects(() => loadWm6Cyclone('WP292026', { initialization_time: run, include_members: true }, undefined, async () => Response.json({ ...detail, initialization_time: '2026-10-15T11:00:00Z' })), /initialization/)
})
