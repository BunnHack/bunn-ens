import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { compileFile } from './compile.mjs'
const modulePath = await compileFile('src/data/wnc2.ts')
const { parseEnsembleCsv, parseCatalog, analyze96W, trackOptions, parseCsvLine, loadEnsemble, windColor, sourceUrl } = await import(modulePath)
const csv = await readFile(new URL('../public/data/FNV3P1_2026_10_13T00_00_cyclogenesis.csv', import.meta.url), 'utf8')
const oldCsv = await readFile(new URL('../public/data/FNV3P2_2026_10_12T06_00_cyclogenesis.csv', import.meta.url), 'utf8')
const run = { model: 'FNV3P1', date: '2026-10-13', cycle: '00z' }
const payload = () => Response.json({ csv, run, checkedAt: '2026-10-13T06:37:00Z' })

await test('Official CSV normalizes midnight dates and strictly clips at 312h', () => {
  const catalog = parseCatalog(csv)
  assert.equal(catalog.initTime, '2026-10-13 00:00:00')
  assert.equal(catalog.totalSamples, 50)
  assert.equal(catalog.rawMaxLead, 360)
  assert.equal(Math.max(...catalog.points.map(point => point.leadHours)), 312)
  assert.ok(catalog.points.every(point => point.leadHours >= 0 && point.leadHours <= 312))
  const ensemble = parseEnsembleCsv(csv, 'WP962026(4)')
  assert.equal(ensemble.members.length, 50)
  assert.equal(ensemble.members[0].points[0].lat, 9.3)
})
await test('96W has 36 continuing and 14 non-overlapping re-identification candidates', () => {
  const analysis = analyze96W(parseCatalog(csv))
  assert.equal(analysis.officialId, 'WP962026(4)')
  assert.equal(analysis.total, 50)
  assert.equal(analysis.continuing, 36)
  assert.equal(analysis.reidentified.length, 14)
  assert.deepEqual(analysis.reidentified.map(point => point.sample), [2,4,6,10,12,19,20,22,28,30,34,36,38,44])
  assert.ok(analysis.reidentified.every(point => point.startLead > point.endLead && point.startLead <= 24 && point.distanceKm < 500))
  assert.equal(analysis.laterGenesis.length, 29)
  assert.equal(analysis.reidentified.find(point => point.sample === 10).startLead, 24)
})
await test('Numeric IDs are scoped by member and never automatically mixed into 96W', () => {
  const catalog = parseCatalog(csv)
  const options = trackOptions(catalog)
  const group = options.find(option => option.key === 'genesis:2:1')
  assert.ok(group.points.every(point => point.sample === 2 && point.trackId === '1'))
  assert.ok(options.find(option => option.key === 'genesis:14:0'))
  assert.ok(options.find(option => option.key === 'WP962026(4)').points.every(point => point.trackId === 'WP962026(4)'))
})
await test('Original WP272026 reference remains parsable', () => {
  const data = parseEnsembleCsv(oldCsv)
  assert.equal(data.members.length, 50)
  assert.equal(data.members[0].maxWind, 93)
  assert.equal(data.members[8].maxWind, 98.5)
  const at24 = data.mean.find(point => point.leadHours === 24)
  assert.ok(Math.abs(at24.lat - 35.485) < .001)
})
await test('CSV validation and wind boundaries', () => {
  assert.deepEqual(parseCsvLine('a,"b,c","d""e"'), ['a', 'b,c', 'd"e'])
  assert.throws(() => parseCatalog('<html>Error</html>'), /no forecast rows/)
  assert.throws(() => parseCatalog('wrong,header\n1,2'), /missing/)
  assert.throws(() => parseEnsembleCsv(csv, 'missing-system'), /No valid tracks/)
  for (const [wind, color] of [[0,'#00e617'],[25,'#009e00'],[34,'#00aaff'],[64,'#f4d500'],[83,'#ff8000'],[96,'#ff0000'],[113,'#800000'],[137,'#ef50ef']]) assert.equal(windColor(wind), color)
})
await test('Latest run load verifies metadata and actual source link', async () => {
  const result = await loadEnsemble({ model: 'FNV3P1', cycle: 'latest' }, undefined, async url => {
    assert.equal(url, '/api/wnc2?model=FNV3P1&cycle=latest')
    return payload()
  })
  assert.equal(result.source, 'remote')
  assert.equal(result.catalog.totalSamples, 50)
  assert.ok(sourceUrl(result.run).endsWith('FNV3P1_2026_10_13T00_00_cyclogenesis.csv'))
  await assert.rejects(() => loadEnsemble({ model: 'FNV3P1', date: '2026-10-13', cycle: '12z' }, undefined, async () => payload()), /does not match/)
})
await test('Offline latest fallback explicitly denies freshness and other runs cannot reuse it', async () => {
  const result = await loadEnsemble({ model: 'FNV3P1', cycle: 'latest' }, undefined, async url => url.startsWith('/api/') ? new Response('Error', { status: 502 }) : new Response(csv))
  assert.equal(result.source, 'snapshot')
  assert.match(result.warning, /NOT confirmation of the latest run/)
  await assert.rejects(() => loadEnsemble({ model: 'FNV3P1', date: '2026-10-13', cycle: '06z' }, undefined, async () => new Response('Missing', { status: 404 })), /No local snapshot/)
  await assert.rejects(() => loadEnsemble({ model: 'FNV3P2', cycle: 'latest' }, undefined, async () => new Response('Missing', { status: 404 })), /No local snapshot/)
})
await test('Aborted remote requests do not trigger fallback', async () => {
  const controller = new AbortController(); controller.abort()
  let calls = 0
  await assert.rejects(() => loadEnsemble({ model: 'FNV3P1', cycle: 'latest' }, controller.signal, async () => { calls++; throw new DOMException('Aborted', 'AbortError') }), /abort/i)
  assert.equal(calls, 0)
})
