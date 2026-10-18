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

export async function handleModelTracks(request, ctx, url) {
  if (request.method !== 'GET') return jsonError('GET required', 405);
  if (url.search) return jsonError('Model tracks do not accept query parameters', 400);
  const cache = typeof caches === 'undefined' ? null : caches.default;
  const key = new Request(new URL('/_internal/model-tracks-v1', request.url));
  const hit = cache ? await cache.match(key) : null;
  if (hit) return new Response(hit.body, { headers: responseHeaders() });
  try {
    const upstream = await fetch('https://raw.githubusercontent.com/BunnHack/bunn-ens/model-track-data/index.json', { credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(25000) });
    if (!upstream.ok) throw Error('Public data publication unavailable');
    const source = await boundedText(upstream);
    if (source.length > 2000000) throw Error('Track publication too large');
    const root = JSON.parse(source);
    if (root.schema !== 1 || root.generator !== 'low-centres-v1' || !Number.isFinite(Date.parse(root.checkedAt)) || !Array.isArray(root.tracks) || root.tracks.length > 60 || !Array.isArray(root.models) || root.models.length !== 2) throw Error('Invalid track publication');
    const pick = (obj, fields) => Object.fromEntries(fields.filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]));
    const tracks = root.tracks.map(t => {
      if (!['AIGFS','SD3'].includes(t.model) || !Array.isArray(t.points) || t.points.length > 100 || !Array.isArray(t.fields) || t.fields.length > 100) throw Error('Invalid model or point bounds');
      const row = pick(t, ['model','systemId','name','basin','kind','source','directoryRun','timeOrigin','sourceTimeUnits','method','notes','attribution','license','endReason','retained']);
      row.points = t.points.map(p => pick(p, ['lat','lon','leadHours','validTime','pressureHpa','windMs']));
      row.fields = t.fields.map(f => pick(f, ['url','sha256','bytes','range']));
      if (t.seed) row.seed = pick(t.seed, ['code','name','basin','model','forecastZero','leadHours','validTime','lat','lon']);
      return row;
    });
    const models = root.models.map(m => {
      if (!['AIGFS','SD3'].includes(m.model) || !['available','partial','retained','unavailable'].includes(m.status)) throw Error('Invalid model status');
      return pick(m, ['model','status','run','checkedAt','message']);
    });
    const payload = JSON.stringify({ schema: 1, generator: root.generator, checkedAt: root.checkedAt, models, tracks });
    if (cache) ctx.waitUntil(cache.put(key, new Response(payload, { headers: { ...responseHeaders(), 'cache-control': 'public, max-age=300' } })));
    return new Response(payload, { headers: responseHeaders() });
  } catch {
    return jsonError('AIGFS/SD3 publication unavailable; no substitute tracks supplied', 502);
  }
}

const ZOOM_ID = /^[a-z0-9][a-z0-9-]{0,39}-20\d{2}$/;
function zoomProjection(root, id) {
  const pick = (obj, fields) => Object.fromEntries(fields.filter(k => obj?.[k] !== undefined).map(k => [k, obj[k]]));
  if (!root || root.id !== id || typeof root.active !== 'boolean' || !Array.isArray(root.track) || !root.track.length || root.track.length > 600) throw new Error('Invalid source storm');
  const data = pick(root, ['id','name','title','description','season','type','active','invest','disturbance','centroid','agencies','place','chance','chance2day','chance7day']);
  for (const name of ['id','name','title','description','season','type','agencies','place','chance']) if (data[name] !== undefined && (typeof data[name] !== 'string' || data[name].length > 400)) throw new Error('Invalid source label');
  data.track = root.track.map(p => {
    if (!p || typeof p.date !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(p.date) || !Number.isFinite(Date.parse(p.date)) || new Date(p.date).toISOString().replace('.000Z','Z') !== p.date || !Array.isArray(p.coordinates) || p.coordinates.length !== 2 || typeof p.forecast !== 'boolean') throw new Error('Invalid source fix');
    const [lon,lat] = p.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new Error('Invalid source coordinate');
    for (const [key,min,max] of [['wind',0,250],['pressure',800,1100],['rank',-5,10]]) if (p[key] != null && (!Number.isFinite(p[key]) || p[key] < min || p[key] > max)) throw new Error('Invalid source value');
    for (const key of ['description','basin','code']) if (p[key] !== undefined && (typeof p[key] !== 'string' || p[key].length > 200)) throw new Error('Invalid source fix label');
    return pick(p, ['date','coordinates','wind','pressure','basin','forecast','rank','code','description']);
  });
  return data;
}
export async function handleCurrentStorms(request, ctx, url) {
  if (request.method !== 'GET') return jsonError('GET required', 405);
  if (url.search) return jsonError('Current storms do not accept query parameters', 400);
  const key = new Request(new URL('/_internal/current-storms-v1', request.url));
  const cache = globalThis.caches?.default;
  const cached = cache && await cache.match(key);
  if (cached) return new Response(cached.body, { headers: responseHeaders() });
  const signal = AbortSignal.timeout(25000);
  async function get(path) {
    const response = await fetch('https://zoom.earth/data/' + path, { signal, redirect: 'manual', credentials: 'omit', headers: { accept: 'application/json', referer: 'https://zoom.earth/' } });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Source unavailable'); }
    return JSON.parse(await boundedText(response));
  }
  try {
    const clock = await get('time/');
    if (!Number.isInteger(clock?.time) || clock.time < 1577836800 || clock.time > 4102444800) throw new Error('Invalid source clock');
    const providerTime = new Date(clock.time * 1000).toISOString().replace('.000Z','Z');
    const catalogDate = new Date(Math.floor(clock.time / 21600) * 21600000).toISOString().slice(0,16) + 'Z';
    const list = await get('storms/?' + new URLSearchParams({ date: catalogDate, to: '12' }));
    if (!Array.isArray(list?.storms) || !Array.isArray(list?.disturbances) || list.storms.length + list.disturbances.length > 20) throw new Error('Invalid source catalog');
    const rows = [...list.storms.map(id => ({ id, kind: 'storm' })), ...list.disturbances.map(id => ({ id, kind: 'disturbance' }))];
    if (rows.some(r => typeof r.id !== 'string' || !ZOOM_ID.test(r.id)) || new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Invalid source IDs');
    const entries = [];
    // Three at a time; a single shared deadline bounds the entire clock/catalog/detail transaction.
    for (let i = 0; i < rows.length; i += 3) entries.push(...await Promise.all(rows.slice(i,i+3).map(async r => {
      try { return { ...r, data: zoomProjection(await get('storms/?' + new URLSearchParams({ id: r.id, lang: 'zh' })), r.id), error: '' }; }
      catch { return { ...r, data: null, error: '此来源系统暂时无法验证；不以其他气旋代替。' }; }
    })));
    if (entries.length && !entries.some(e => e.data)) throw new Error('No valid details');
    const payload = JSON.stringify({ schema: 1, source: 'https://zoom.earth/', providerTime, catalogDate, checkedAt: new Date().toISOString().replace(/\.\d{3}Z$/,'Z'), windUnit: 'kt', pressureUnit: 'hPa', entries });
    if (cache && entries.every(e => e.data)) ctx.waitUntil(cache.put(key, new Response(payload, { headers: { ...responseHeaders(), 'cache-control': 'public, max-age=300' } })));
    return new Response(payload, { headers: responseHeaders() });
  } catch { return jsonError('Zoom Earth current storms unavailable; no historical or model substitute supplied', 502); }
}

export async function handleIntensityAids(request, ctx, url) {
  if (request.method !== 'GET') return jsonError('GET required', 405);
  const storm = url.searchParams.get('storm');
  if ([...url.searchParams.keys()].some(k => k !== 'storm') || url.searchParams.getAll('storm').length !== 1 || !/^(AL|EP|CP)(0[1-9]|[1-4]\d)20\d{2}$/.test(storm ?? '')) return jsonError('A public NHC AL/EP/CP cyclone ID is required', 400);
  const source = 'https://ftp.nhc.noaa.gov/atcf/aid_public/a' + storm.toLowerCase() + '.dat.gz';
  const key = new Request(new URL('/_internal/intensity-aids-v1/' + storm, request.url)), cache = globalThis.caches?.default;
  const hit = cache && await cache.match(key);
  if (hit) return new Response(hit.body, { headers: responseHeaders() });
  try {
    const response = await fetch(source, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(25000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Unavailable'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('Empty archive');
    const chunks = []; let total = 0;
    try { while (true) { const {done,value} = await reader.read(); if (done) break; total += value.byteLength; if (total > 4*1024*1024) { await reader.cancel(); throw new Error('Archive too large'); } chunks.push(value); } } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total); let cursor = 0; for (const c of chunks) { bytes.set(c,cursor); cursor += c.byteLength; }
    let stream = new Blob([bytes]).stream();
    if (bytes[0] === 31 && bytes[1] === 139) stream = stream.pipeThrough(new DecompressionStream('gzip'));
    const input = stream.getReader(), decoder = new TextDecoder(); let pending = '', expanded = 0, latestCycle = '', rows = [];
    function line(raw) {
      if (raw.length > 4096) throw new Error('Invalid ATCF row');
      const c = raw.split(',').slice(0,5).map(s=>s.trim());
      if (!c[0]) return;
      if (c[0] !== storm.slice(0,2) || c[1].padStart(2,'0') !== storm.slice(2,4) || !/^\d{10}$/.test(c[2]) || !c[2].startsWith(storm.slice(4))) throw new Error('ATCF identity mismatch');
      if (c[2] > latestCycle) { latestCycle = c[2]; rows = []; }
      if (c[2] === latestCycle) rows.push(raw);
      if (rows.length > 15000) throw new Error('ATCF cycle too large');
    }
    try {
      while (true) { const {done,value} = await input.read(); if (done) break; expanded += value.byteLength; if (expanded > 64*1024*1024) throw new Error('Expanded archive too large'); pending += decoder.decode(value,{stream:true}); let cut; while ((cut=pending.indexOf('\n')) !== -1) { line(pending.slice(0,cut).replace(/\r$/,'')); pending=pending.slice(cut+1); } if (pending.length > 4096) throw new Error('Invalid row'); }
      pending += decoder.decode(); if (pending.trim()) line(pending);
    } finally { await input.cancel().catch(()=>{}); input.releaseLock(); }
    if (!rows.length || !latestCycle) throw new Error('No source cycle');
    const payload = JSON.stringify({ storm, source, latestCycle, checkedAt: new Date().toISOString(), rows: rows.join('\n') });
    if (cache) ctx.waitUntil(cache.put(key,new Response(payload,{headers:{...responseHeaders(),'cache-control':'public, max-age=300'}})));
    return new Response(payload,{headers:responseHeaders()});
  } catch { return jsonError('NHC intensity aids unavailable for this ID; no substitute model curves supplied',502); }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/current-storms') return handleCurrentStorms(request, ctx, url);
    if (url.pathname === '/api/intensity-aids') return handleIntensityAids(request, ctx, url);
    if (url.pathname === '/api/model-tracks') return handleModelTracks(request, ctx, url);
    if (url.pathname === '/api/wmc') return handleWmc(request, env, ctx, url);
    if (url.pathname === '/api/wnc2') return handleWeatherNext(request, ctx, url);
    if (url.pathname === '/api/wm6') return handleWm6(request, env, ctx, url);
    if (url.pathname === '/api/wm6/availability') return handleWm6Availability(request, env, ctx, url);
    if (url.pathname.startsWith('/api/wm6/')) return handleWm6Detail(request, env, ctx, url, decodeURIComponent(url.pathname.slice('/api/wm6/'.length)));
    return env.ASSETS.fetch(request);
  },
};
