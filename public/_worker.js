const WEATHERNEXT_UPSTREAM = 'https://deepmind.google.com/science/weatherlab/download/cyclones';
const WINDBORNE_UPSTREAM = 'https://api.windbornesystems.com/forecasts/v1/wm-6/tropical_cyclones';
const WINDBORNE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MODELS = new Set(['FNV3P1', 'FNV3P2', 'WNV3', 'OPER']);
const CYCLES = new Set(['00z', '06z', '12z', '18z']);
const BASINS = new Set(['AL', 'EP', 'CP', 'WP', 'NI', 'SI', 'AU', 'SP']);
const MAX_BYTES = 10_000_000;
const CACHE_SECONDS = 300;

function weatherRuns(now, model, cycle, date) {
  if (date) return [{ model, cycle, date }];
  const boundary = Math.floor(now.getTime() / 21600000) * 21600000;
  const result = [];
  for (let index = 0; index < 12; index++) {
    const time = new Date(boundary - index * 21600000);
    const hour = `${String(time.getUTCHours()).padStart(2, '0')}z`;
    if (cycle === 'latest' || cycle === hour) result.push({ model, date: time.toISOString().slice(0, 10), cycle: hour });
  }
  return result;
}

function responseHeaders() {
  return { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };
}

function jsonError(message, status) {
  return Response.json({ error: message }, { status, headers: responseHeaders() });
}

async function boundedText(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty upstream response');
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('Upstream response exceeds size limit'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

function validateWeatherCsv(csv, run) {
  const lines = csv.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('#'));
  const headers = lines[0]?.split(',');
  if (!headers?.includes('maximum_sustained_wind_speed_knots') || !headers.includes('lead_time_hours') || lines.length < 2) throw new Error('Invalid upstream CSV');
  const initIndex = headers.indexOf('init_time');
  const init = (lines[1].split(',')[initIndex] ?? '').trim().replace(/^\"|\"$/g, '').replace('T', ' ').replace(/Z$/, '');
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(init) ? `${init} 00:00:00` : init;
  if (normalized !== `${run.date} ${run.cycle.slice(0, 2)}:00:00`) throw new Error('Upstream initialization mismatch');
}

async function handleWeatherNext(request, ctx, url) {
  if (request.method !== 'GET') return jsonError('GET required', 405);
  const model = url.searchParams.get('model') ?? 'FNV3P1';
  const cycle = url.searchParams.get('cycle') ?? 'latest';
  const date = url.searchParams.get('date');
  const parsed = date ? new Date(`${date}T00:00:00Z`) : null;
  if (!MODELS.has(model) || !(cycle === 'latest' || CYCLES.has(cycle)) || (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || cycle === 'latest'))) return jsonError('Invalid model, cycle or date', 400);
  const now = new Date();
  const cacheUrl = new URL('/_internal/wnc2-cache', request.url);
  cacheUrl.search = new URLSearchParams({ model, cycle, date: date ?? String(Math.floor(now.getTime() / 21600000)) }).toString();
  const cacheKey = new Request(cacheUrl.toString());
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return new Response(cached.body, { headers: responseHeaders() });
  try {
    for (const run of weatherRuns(now, model, cycle, date)) {
      const filename = `${run.model}_${run.date.replace(/-/g, '_')}T${run.cycle.slice(0, 2)}_00_cyclogenesis.csv`;
      const upstream = await fetch(`${WEATHERNEXT_UPSTREAM}/${run.model}/ensemble/cyclogenesis/csv/${filename}`, { signal: AbortSignal.timeout(20000), cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': CACHE_SECONDS, '404': 120, '500-599': 0 } } });
      if (upstream.status === 404) continue;
      if (!upstream.ok) throw new Error(`WeatherNext returned HTTP ${upstream.status}`);
      const csv = await boundedText(upstream);
      validateWeatherCsv(csv, run);
      const payload = JSON.stringify({ csv, run, checkedAt: now.toISOString() });
      ctx.waitUntil(cache.put(cacheKey, new Response(payload, { headers: { ...responseHeaders(), 'cache-control': `public, max-age=${CACHE_SECONDS}` } })));
      return new Response(payload, { headers: responseHeaders() });
    }
    return jsonError('No published WeatherNext run found in the last 72 hours', 502);
  } catch (error) {
    console.error(JSON.stringify({ event: 'wnc2_fetch_failed', message: error instanceof Error ? error.message : 'Unknown error' }));
    return jsonError(error instanceof Error ? error.message : 'Unable to retrieve WeatherNext data', 502);
  }
}

function validInitialization(value) {
  return value === 'latest' || /^\d{10}$/.test(value) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(value);
}

function wm6Query(url) {
  const params = new URLSearchParams();
  const initialization = url.searchParams.get('initialization_time');
  const basin = url.searchParams.get('basin');
  const includeUnofficial = url.searchParams.get('include_unofficial_ids');
  const includeDetails = url.searchParams.get('include_details');
  const format = url.searchParams.get('format') ?? 'json';
  if (initialization) params.set('initialization_time', initialization);
  if (basin) params.set('basin', basin);
  if (includeUnofficial) params.set('include_unofficial_ids', includeUnofficial);
  if (includeDetails) params.set('include_details', includeDetails);
  params.set('format', format);
  return params;
}

async function handleWm6(request, env, ctx, url) {
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'GET required' }), { status: 405, headers: { ...responseHeaders(), allow: 'GET' } });
  if (!env.WM_API_KEY) return jsonError('WM-6 API is not configured', 503);
  const initialization = url.searchParams.get('initialization_time');
  const basin = url.searchParams.get('basin');
  const format = url.searchParams.get('format') ?? 'json';
  const booleanValues = ['true', 'false'];
  for (const key of ['include_unofficial_ids', 'include_details']) {
    const value = url.searchParams.get(key);
    if (value !== null && !booleanValues.includes(value)) return jsonError(`Invalid ${key}; use true or false`, 400);
  }
  if (initialization && !validInitialization(initialization)) return jsonError('Invalid initialization_time', 400);
  if (basin && !BASINS.has(basin)) return jsonError('Invalid basin', 400);
  if (!['json', 'geojson'].includes(format)) return jsonError('Invalid format; use json or geojson', 400);
  const query = wm6Query(url);
  const cacheUrl = new URL('/_internal/wm6-no-cones-v1', request.url);
  cacheUrl.search = query.toString();
  const cacheKey = new Request(cacheUrl.toString());
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return new Response(cached.body, { headers: responseHeaders() });
  try {
    const upstream = await fetch(`${WINDBORNE_UPSTREAM}?${query}`, { headers: { authorization: `Bearer ${env.WM_API_KEY}`, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (!upstream.ok) throw new Error(`WindBorne WM-6 returned HTTP ${upstream.status}`);
    const body = await boundedText(upstream);
    const parsed = JSON.parse(body);
    if (format === 'json' && (!parsed || typeof parsed !== 'object' || !parsed.tropical_cyclones || typeof parsed.total !== 'number')) throw new Error('WindBorne returned an invalid tropical cyclone response');
    if (format === 'geojson' && (parsed?.type !== 'FeatureCollection' || !Array.isArray(parsed.features))) throw new Error('WindBorne returned invalid GeoJSON');
    if (format === 'json') {
      for (const cyclone of Object.values(parsed.tropical_cyclones)) { delete cyclone.cone; delete cyclone.cones; }
    } else parsed.features = parsed.features.filter(feature => feature.properties?.feature_type !== 'cone' && feature.properties?.path_type !== 'cone' && !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type));
    const payload = JSON.stringify(parsed);
    ctx.waitUntil(cache.put(cacheKey, new Response(payload, { headers: { ...responseHeaders(), 'cache-control': `public, max-age=${CACHE_SECONDS}` } })));
    return new Response(payload, { headers: responseHeaders() });
  } catch (error) {
    console.error(JSON.stringify({ event: 'wm6_fetch_failed', message: error instanceof Error ? error.message : 'Unknown error' }));
    return jsonError(error instanceof Error ? error.message : 'Unable to retrieve WM-6 data', 502);
  }
}

function wm6DetailQuery(url) {
  const params = new URLSearchParams();
  const initialization = url.searchParams.get('initialization_time');
  const includeMembers = url.searchParams.get('include_members');
  const includeCones = url.searchParams.get('include_cones');
  if (initialization) params.set('initialization_time', initialization);
  params.set('include_members', includeMembers ?? 'true');
  params.set('include_cones', 'false');
  return params;
}

async function handleWm6Detail(request, env, ctx, url, id) {
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'GET required' }), { status: 405, headers: { ...responseHeaders(), allow: 'GET' } });
  if (!env.WM_API_KEY) return jsonError('WM-6 API is not configured', 503);
  if (!WINDBORNE_ID_PATTERN.test(id)) return jsonError('Invalid tropical cyclone ID', 400);
  const initialization = url.searchParams.get('initialization_time');
  const includeMembers = url.searchParams.get('include_members') ?? 'true';
  const includeCones = url.searchParams.get('include_cones') ?? 'true';
  if (initialization && !validInitialization(initialization)) return jsonError('Invalid initialization_time', 400);
  if (!['true', 'false'].includes(includeMembers) || !['true', 'false'].includes(includeCones)) return jsonError('include_members and include_cones must be true or false', 400);
  const query = wm6DetailQuery(url);
  const cacheUrl = new URL(`/_internal/wm6-detail-no-cones-v1/${id}`, request.url);
  cacheUrl.search = query.toString();
  const cacheKey = new Request(cacheUrl.toString());
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return new Response(cached.body, { headers: responseHeaders() });
  try {
    const upstream = await fetch(`${WINDBORNE_UPSTREAM}/${encodeURIComponent(id)}?${query}`, { headers: { authorization: `Bearer ${env.WM_API_KEY}`, accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
    if (!upstream.ok) throw new Error(`WindBorne WM-6 detail returned HTTP ${upstream.status}`);
    const body = await boundedText(upstream);
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.mean_path) || (includeMembers === 'true' && !Array.isArray(parsed.members_path))) throw new Error('WindBorne returned an invalid cyclone detail response');
    delete parsed.cones;
    delete parsed.cone;
    const payload = JSON.stringify(parsed);
    ctx.waitUntil(cache.put(cacheKey, new Response(payload, { headers: { ...responseHeaders(), 'cache-control': `public, max-age=${CACHE_SECONDS}` } })));
    return new Response(payload, { headers: responseHeaders() });
  } catch (error) {
    console.error(JSON.stringify({ event: 'wm6_detail_failed', id, message: error instanceof Error ? error.message : 'Unknown error' }));
    return jsonError(error instanceof Error ? error.message : 'Unable to retrieve WM-6 cyclone details', 502);
  }
}

async function handleWm6Availability(request, env, ctx, url) {
  if (request.method !== 'GET') return jsonError('GET required', 405);
  if (url.search) return jsonError('Availability does not accept query parameters', 400);
  if (!env.WM_API_KEY) return jsonError('WM-6 API is not configured', 503);
  const key = new Request(new URL('/_internal/wm6-availability-v1', request.url));
  const cached = await caches.default.match(key);
  if (cached) return new Response(cached.body, { headers: responseHeaders() });
  try {
    const upstream = await fetch('https://api.windbornesystems.com/forecasts/v1/wm-6/run_information', { headers: { authorization: `Bearer ${env.WM_API_KEY}`, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (!upstream.ok) throw new Error(`WM-6 availability HTTP ${upstream.status}`);
    const value = JSON.parse(await boundedText(upstream));
    const time = item => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(item) && Number.isFinite(Date.parse(item));
    if (!time(value.initialization_time) || !time(value.forecast_zero) || typeof value.in_progress !== 'boolean' || !Array.isArray(value.available)) throw new Error('Invalid WM-6 availability metadata');
    const hours = [...new Set(value.available.map(item => item.forecast_hour).filter(hour => Number.isInteger(hour) && hour >= 0 && hour <= 312))].sort((a,b) => a-b);
    const payload = JSON.stringify({ initializationTime: value.initialization_time, forecastZero: value.forecast_zero, inProgress: value.in_progress, hours, checkedAt: new Date().toISOString() });
    ctx.waitUntil(caches.default.put(key, new Response(payload, { headers: { ...responseHeaders(), 'cache-control': `public, max-age=${CACHE_SECONDS}` } })));
    return new Response(payload, { headers: responseHeaders() });
  } catch (error) {
    console.error(JSON.stringify({ event: 'wm6_availability_failed', message: error instanceof Error ? error.message : 'Unknown error' }));
    return jsonError('Unable to verify latest WM-6 availability; published charts remain independent', 502);
  }
}

const WMC_MODELS = ['FUXI', 'FENGQING', 'FENGWU', 'PANGU', 'AIFS', 'GRAPHCAST', 'FOURCASTNET'];
const WMC_ROOT = 'http://ew4all.wmc-bj.net/EW4ALL/typh/api/cmes-typhoonOcean/api/tcRealtime/';
// Legacy provider protocol only. Signing material is an encrypted runtime binding, never a client constant.
export async function handleWmc(request, env, ctx, url, digest = bytes => crypto.subtle.digest('MD5', bytes)) {
  if (request.method !== 'GET') return jsonError('Method not allowed', 405);
  const code = url.searchParams.get('code');
  if ([...url.searchParams.keys()].some(key => key !== 'code') || url.searchParams.getAll('code').length > 1 || (code !== null && !/^[12]\d{7}$/.test(code))) return jsonError('Invalid WMC cyclone query', 400);
  let auth;
  try { auth = JSON.parse(env.WMC_AUTH || '{}'); } catch { return jsonError('WMC AI source is not configured', 503); }
  if (!/^[0-9]{1,16}$/.test(String(auth.id ?? '')) || typeof auth.encryption !== 'string' || auth.encryption.length < 16 || auth.encryption.length > 256) return jsonError('WMC AI source is not configured', 503);
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(new URL('/_internal/wmc-ai-v1/' + (code ?? 'active'), request.url));
  const cached = await cache?.match(cacheKey);
  if (cached) return new Response(cached.body, { headers: responseHeaders() });
  let stage = 'signature';
  try {
    const stamp = new Date(Date.now() + 8 * 3600000).toISOString().replace(/\D/g, '').slice(0, 14);
    const text = String(auth.id) + stamp;
    const signature = [...new Uint8Array(await digest(new TextEncoder().encode(text + auth.encryption)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const key = btoa(text + signature);
    const upstreamUrl = new URL(WMC_ROOT + (code ? 'getTyphoonConversionByCode' : 'getActiveTyphoonByFcstType'));
    upstreamUrl.searchParams.set(code ? 'querytyphoonByCode' : 'fcstTypeList', code ?? WMC_MODELS.join(','));
    stage = 'fetch';
    const response = await fetch(upstreamUrl.toString(), { headers: { accept: 'application/json', 'typhoon-access-key': key }, redirect: 'manual', signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error('http_' + response.status);
    stage = 'response_json';
    const value = JSON.parse(await boundedText(response));
    const rows = code ? value.data?.fcstList : value.data;
    if (value.code !== 200 || !Array.isArray(rows) || rows.length > 200) throw new Error('envelope_' + (Number.isInteger(value.code) ? value.code : 'invalid'));
    stage = 'validation';
    const fields = ['datetime', 'validtime', 'fcsthour', 'handletime', 'lat', 'lon', 'pressure', 'windv', 'xuhao', 'tfbh', 'engname', 'fcsttype', 'zone'];
    const entries = rows.filter(row => WMC_MODELS.includes(row.FCSTType) && row.typeCode === 4).map(row => {
      if (code && String(row.xuhao) !== code) throw new Error('cyclone_mismatch');
      const points = row[row.FCSTType];
      if (!Array.isArray(points) || points.length > 2000) throw new Error('invalid_points');
      return { FCSTType: row.FCSTType, xuhao: row.xuhao, cn: String(row.cn ?? '').slice(0, 60), cname: String(row.cname ?? '').slice(0, 60), enname: String(row.enname ?? '').slice(0, 60), time: row.time, points: points.map(point => Object.fromEntries(fields.filter(field => ['string', 'number'].includes(typeof point?.[field]) || point?.[field] === null).map(field => [field, point[field]]))) };
    });
    const payload = JSON.stringify({ entries, cycloneCode: code, checkedAt: new Date().toISOString(), source: upstreamUrl.toString(), transport: 'http' });
    if (cache) ctx.waitUntil(cache.put(cacheKey, new Response(payload, { headers: { ...responseHeaders(), 'cache-control': `public, max-age=${CACHE_SECONDS}` } })));
    return new Response(payload, { headers: responseHeaders() });
  } catch (error) {
    const reason = /^(?:http_\d{3}|envelope_(?:\d{3}|invalid)|cyclone_mismatch|invalid_points)$/.test(error?.message) ? error.message : stage;
    console.error(JSON.stringify({ event: 'wmc_ai_failed', reason }));
    return jsonError(`WMC AI source unavailable (${reason}); no substitute tracks supplied`, 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/wmc') return handleWmc(request, env, ctx, url);
    if (url.pathname === '/api/wnc2') return handleWeatherNext(request, ctx, url);
    if (url.pathname === '/api/wm6') return handleWm6(request, env, ctx, url);
    if (url.pathname === '/api/wm6/availability') return handleWm6Availability(request, env, ctx, url);
    if (url.pathname.startsWith('/api/wm6/')) return handleWm6Detail(request, env, ctx, url, decodeURIComponent(url.pathname.slice('/api/wm6/'.length)));
    return env.ASSETS.fetch(request);
  },
};
