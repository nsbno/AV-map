import express from 'express';
import { parse, print, valueFromASTUntyped, visit } from 'graphql';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const WAYMO_CSV_FILE = 'CSV4 - Miles and Benchmark Crashes for Dynamic Benchmark 202009-202606-2022benchmark_v2.csv';
const NVDB_TYPES = new Set([67, 105, 89, 174, 37, 838, 69, 43, 42, 977, 540, 570]);
const STATIC_FILES = new Set(['index.html', 'analysis-app.js', 'map-engine.js', 'transit-state.js', WAYMO_CSV_FILE]);

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function requireValue(condition, message) {
  if (!condition) throw new ApiError(400, message);
}

function integer(value, minimum, maximum, name) {
  requireValue(/^\d+$/.test(String(value)), 'Invalid ' + name);
  const number = Number(value);
  requireValue(Number.isSafeInteger(number) && number >= minimum && number <= maximum, 'Invalid ' + name);
  return number;
}

function bounds(values, maxSpan = 1) {
  requireValue(Array.isArray(values) && values.length === 4 && values.every(value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value))), 'Invalid bounding box');
  const [west, south, east, north] = values.map(Number);
  requireValue(west >= -180 && east <= 180 && south >= -85 && north <= 85 && east > west && north > south, 'Invalid bounding box');
  requireValue(east - west <= maxSpan && north - south <= maxSpan, 'Bounding box is too large');
  return [west, south, east, north];
}

function queryParameters(request, allowed) {
  const params = new URL(request.originalUrl, 'http://localhost').searchParams;
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    requireValue(allowed.includes(key) && (values.length === 1 || key === 'egenskap' && values.length === 2), 'Unsupported or repeated query parameter: ' + key);
  }
  return params;
}

function graphqlRequest(body, realtime) {
  requireValue(body && typeof body === 'object' && !Array.isArray(body), 'Expected a JSON object');
  requireValue(Object.keys(body).every(key => ['query', 'variables', 'operationName'].includes(key)), 'Unsupported GraphQL request field');
  requireValue(typeof body.query === 'string' && body.query.length > 0 && body.query.length <= 32000, 'Invalid GraphQL query size');
  requireValue(body.variables === undefined || body.variables === null || (typeof body.variables === 'object' && !Array.isArray(body.variables)), 'Invalid GraphQL variables');
  let document;
  try { document = parse(body.query, { maxTokens: 4000 }); }
  catch { throw new ApiError(400, 'Invalid GraphQL syntax'); }
  requireValue(document.definitions.length === 1, 'Only one GraphQL operation is allowed');
  const operation = document.definitions[0];
  requireValue(operation.kind === 'OperationDefinition' && operation.operation === 'query', 'Only read-only GraphQL queries are allowed');
  requireValue(!body.operationName || body.operationName === operation.name?.value, 'Invalid GraphQL operation name');
  const allowedRoots = realtime ? ['vehicles'] : ['quaysByBbox', 'quay', 'line', 'serviceJourney'];
  requireValue(operation.selectionSet.selections.length <= 4, 'Too many root fields');
  const variables = body.variables || {};
  operation.selectionSet.selections.forEach(field => {
    requireValue(field.kind === 'Field' && allowedRoots.includes(field.name.value), 'Unsupported GraphQL operation');
    const args = Object.fromEntries((field.arguments || []).map(argument => [argument.name.value, valueFromASTUntyped(argument.value, variables)]));
    if (field.name.value === 'vehicles') {
      const box = args.boundingBox;
      requireValue(box && args.mode === 'BUS', 'A bus bounding box is required');
      bounds([box.minLon, box.minLat, box.maxLon, box.maxLat], 2);
      requireValue(args.maxDataAge === 'PT2M', 'Vehicle data age must be PT2M');
      requireValue(args.includeInvalidLocations === false, 'Invalid vehicle locations must be excluded');
    } else if (field.name.value === 'quaysByBbox') {
      bounds([args.minimumLongitude, args.minimumLatitude, args.maximumLongitude, args.maximumLatitude]);
    } else requireValue(typeof args.id === 'string' && args.id.length > 0 && args.id.length <= 256, 'A valid ID is required');
  });
  let fieldCount = 0, depth = 0, aliases = 0;
  visit(document, {
    FragmentSpread() { throw new ApiError(400, 'GraphQL fragments are not supported'); },
    InlineFragment() { throw new ApiError(400, 'GraphQL fragments are not supported'); },
    Field: {
      enter(field) {
        fieldCount++; depth++; if (field.alias) aliases++;
        requireValue(fieldCount <= 180 && depth <= 10 && aliases <= 4, 'GraphQL query is too complex');
        requireValue(!field.name.value.startsWith('__'), 'GraphQL introspection is not supported');
        if (field.name.value === 'estimatedCalls') {
          const args = Object.fromEntries((field.arguments || []).map(argument => [argument.name.value, valueFromASTUntyped(argument.value, variables)]));
          if (args.numberOfDepartures !== undefined) integer(args.numberOfDepartures, 1, 100, 'departure count');
          if (args.timeRange !== undefined) integer(args.timeRange, 1, 86400, 'departure time range');
        }
      },
      leave() { depth--; }
    }
  });
  return { body: { query: print(document), ...(body.variables ? { variables: body.variables } : {}), ...(body.operationName ? { operationName: body.operationName } : {}) },
    ttl: realtime ? 5000 : operation.selectionSet.selections.every(field => field.name.value === 'line') ? 3600000 : 15000 };
}

async function readResponse(response, maxBytes, parseJson = true) {
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(502, 'Upstream returned an empty response');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ApiError(502, 'Upstream response is too large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const buffer = Buffer.concat(chunks);
  let data = buffer.toString('utf8');
  if (parseJson) {
    try { data = JSON.parse(data); }
    catch { throw new ApiError(502, 'Upstream returned invalid JSON'); }
  }
  return { buffer, data };
}

export function createApp({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 20000, rateLimit = 120, maxResponseBytes = 16 * 1024 * 1024, trustProxy = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);
  const cache = new Map(), pending = new Map(), clients = new Map();
  let cacheBytes = 0, activeUpstreams = 0;
  const clientName = process.env.ENTUR_CLIENT_NAME || 'vy-av-analysis';
  const maxCacheBytes = 32 * 1024 * 1024;

  function cachePut(key, buffer, ttl) {
    const previous = cache.get(key);
    if (previous) { cacheBytes -= previous.buffer.length; cache.delete(key); }
    cache.set(key, { buffer, expires: now() + ttl });
    cacheBytes += buffer.length;
    while (cache.size > 128 || cacheBytes > maxCacheBytes) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).buffer.length;
      cache.delete(oldest);
    }
  }

  async function upstream(url, body, ttl, headers, responseType = 'json', bodyContentType = 'application/json') {
    url.searchParams.sort();
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const key = createHash('sha256').update(url.href + '\n' + (payload || '') + '\n' + responseType).digest('hex');
    const saved = cache.get(key);
    if (saved && saved.expires > now()) return { buffer: saved.buffer, cacheStatus: 'HIT' };
    if (saved) { cacheBytes -= saved.buffer.length; cache.delete(key); }
    if (pending.has(key)) return { ...await pending.get(key), cacheStatus: 'COALESCED' };
    if (activeUpstreams >= 8) throw new ApiError(503, 'Data services are busy. Try again shortly.');
    const task = (async () => {
      activeUpstreams++;
      try {
        const response = await fetchImpl(url.href, {
          method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': bodyContentType }), ...headers },
          body: payload, signal: AbortSignal.timeout(timeoutMs), redirect: 'error'
        });
        if (!response.ok) {
          if ([400, 429, 504, 509].includes(response.status) && url.hostname === 'api.openstreetmap.org') {
            const { buffer } = await readResponse(response, maxResponseBytes, false);
            const error = new ApiError(response.status, buffer.toString('utf8').slice(0, 1024));
            const retryAfter = response.headers.get('Retry-After');
            if (/^\d+$/.test(retryAfter || '')) error.retryAfter = retryAfter;
            throw error;
          }
          await response.body?.cancel();
          throw new ApiError(response.status === 429 ? 503 : 502, response.status === 429 ? 'Upstream rate limit reached. Try again later.' : 'Data service returned HTTP ' + response.status);
        }
        const { buffer, data } = await readResponse(response, maxResponseBytes, responseType === 'json');
        if (!data?.errors?.length && ttl > 0) cachePut(key, buffer, ttl);
        return { buffer, cacheStatus: 'MISS' };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new ApiError(504, 'Data service timed out');
        throw new ApiError(502, 'Could not reach data service');
      } finally { activeUpstreams--; }
    })();
    pending.set(key, task);
    try { return await task; }
    finally { pending.delete(key); }
  }

  function proxyRoute(method, path, resolve) {
    const methods = Array.isArray(method) ? method : [method];
    methods.forEach(allowedMethod => app[allowedMethod](path, async (request, response) => {
      const target = resolve(request);
      const result = await upstream(target.url, target.body, target.ttl, target.headers, target.responseType, target.bodyContentType);
      response.set('X-Proxy-Cache', result.cacheStatus).type(target.contentType || 'application/json').send(result.buffer);
    }));
    app.all(path, (request, response) => response.set('Allow', methods.map(value => value.toUpperCase()).join(', ')).status(405).json({ error: 'Method not allowed' }));
  }

  app.use((request, response, next) => {
    response.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    next();
  });
  app.use('/api', (request, response, next) => {
    response.set({ 'Cache-Control': 'no-store', 'X-Request-ID': randomUUID() });
    const origin = request.get('Origin');
    try {
      if (request.get('Sec-Fetch-Site') === 'cross-site' || (origin && new URL(origin).host !== request.get('Host'))) throw new Error('origin');
    } catch { response.status(403).json({ error: 'Cross-origin API requests are not allowed' }); return; }
    const key = request.ip;
    const time = now();
    if (clients.size >= 5000) for (const [address, value] of clients) if (value.expires <= time) clients.delete(address);
    let limit = clients.get(key);
    if (!limit || limit.expires <= time) {
      if (!clients.has(key) && clients.size >= 5000) { response.status(503).json({ error: 'Too many clients. Try again later.' }); return; }
      limit = { count: 0, expires: time + 60000 };
      clients.set(key, limit);
    }
    if (++limit.count > rateLimit) { response.set('Retry-After', String(Math.ceil((limit.expires - time) / 1000))).status(429).json({ error: 'Too many requests. Try again later.' }); return; }
    next();
  });
  app.use('/api', express.json({ limit: '64kb', strict: true }));
  app.get('/api/health', (request, response) => response.json({ status: 'ok' }));

  for (const [path, realtime] of [['/api/entur/journey-planner', false], ['/api/entur/vehicles', true]]) {
    proxyRoute('post', path, request => {
      queryParameters(request, []);
      const query = graphqlRequest(request.body, realtime);
      return { url: new URL(realtime ? 'https://api.entur.io/realtime/v2/vehicles/graphql' : 'https://api.entur.io/journey-planner/v3/graphql'), body: query.body, ttl: query.ttl,
        headers: { 'ET-Client-Name': clientName } };
    });
  }

  proxyRoute('get', '/api/nvdb/objects/:type', request => {
    const type = integer(request.params.type, 1, 10000, 'NVDB object type');
    requireValue(NVDB_TYPES.has(type), 'Unsupported NVDB object type');
    const params = queryParameters(request, ['kartutsnitt', 'antall', 'inkluder', 'srid', 'inkluderAntall', 'start', 'egenskap']);
    const accidentFilters = ['5055>=2016-01-01', '5055<=2025-12-31'];
    if (type === 570) requireValue(params.getAll('egenskap').length === 2 && accidentFilters.every(filter => params.getAll('egenskap').includes(filter)), 'Traffic accidents require the supported 2016-2025 date range');
    else requireValue(!params.has('egenskap'), 'NVDB property filters are not supported for this object type');
    const box = bounds((params.get('kartutsnitt') || '').split(','));
    requireValue(!params.has('srid') || params.get('srid') === '4326', 'Only WGS84 is supported');
    requireValue(!params.has('inkluder') || params.get('inkluder') === 'geometri,egenskaper', 'Unsupported NVDB properties');
    requireValue(!params.has('inkluderAntall') || params.get('inkluderAntall') === 'false', 'Counting NVDB objects is not supported');
    const url = new URL('https://nvdbapiles.atlas.vegvesen.no/vegobjekter/api/v4/vegobjekter/' + type);
    url.search = new URLSearchParams({ kartutsnitt: box.join(','), antall: String(Math.min(800, integer(params.get('antall') || '800', 1, 2000, 'page size'))), inkluder: 'geometri,egenskaper', srid: '4326', inkluderAntall: 'false' }).toString();
    accidentFilters.forEach(filter => { if (type === 570) url.searchParams.append('egenskap', filter); });
    if (params.has('start')) {
      const start = params.get('start');
      requireValue(start.length > 0 && start.length <= 512 && !/[\x00-\x1f]/.test(start), 'Invalid pagination marker');
      url.searchParams.set('start', start);
    }
    return { url, ttl: 300000, headers: { 'X-Client': clientName } };
  });

  proxyRoute(['get', 'post'], '/api/osm/map', request => {
    let input;
    if (request.method === 'GET') {
      const params = queryParameters(request, ['bbox']);
      input = Object.fromEntries(params);
    } else {
      queryParameters(request, []);
      input = request.body;
      requireValue(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).every(key => key === 'bbox'), 'Invalid OSM request');
    }
    const box = bounds(String(input?.bbox || '').split(','), 0.06);
    const url = new URL('https://api.openstreetmap.org/api/0.6/map');
    url.searchParams.set('bbox', box.join(','));
    return { url, ttl: 86400000, responseType: 'text', contentType: 'application/xml', headers: { Accept: 'application/xml', 'User-Agent': 'Vy-AV-Analysis/1.0' } };
  });

  proxyRoute('get', '/api/geonorge/addresses', request => {
    const params = queryParameters(request, ['sok', 'treffPerSide']);
    const search = (params.get('sok') || '').trim();
    requireValue(search.length >= 3 && search.length <= 200, 'Address search must contain 3 to 200 characters');
    const url = new URL('https://ws.geonorge.no/adresser/v1/sok');
    url.search = new URLSearchParams({ sok: search, treffPerSide: String(integer(params.get('treffPerSide') || '5', 1, 10, 'result count')) }).toString();
    return { url, ttl: 3600000 };
  });

  proxyRoute('get', '/api/osrm/route/:coordinates', request => {
    const params = queryParameters(request, ['overview', 'geometries', 'steps']);
    requireValue(!params.has('overview') || params.get('overview') === 'full', 'Unsupported route overview');
    requireValue(!params.has('geometries') || params.get('geometries') === 'geojson', 'Only GeoJSON routes are supported');
    requireValue(!params.has('steps') || params.get('steps') === 'false', 'Route steps are not supported');
    const pairs = request.params.coordinates.split(';');
    requireValue(pairs.length >= 2 && pairs.length <= 25, 'Routes require 2 to 25 waypoints');
    const coordinates = pairs.map(pair => {
      const values = pair.split(',');
      requireValue(values.length === 2 && values.every(value => /^-?\d+(?:\.\d+)?$/.test(value)), 'Invalid route coordinates');
      const [longitude, latitude] = values.map(Number);
      requireValue(Math.abs(longitude) <= 180 && Math.abs(latitude) <= 85, 'Invalid route coordinates');
      return [longitude, latitude];
    });
    requireValue(Math.max(...coordinates.map(point => point[0])) - Math.min(...coordinates.map(point => point[0])) <= 5 && Math.max(...coordinates.map(point => point[1])) - Math.min(...coordinates.map(point => point[1])) <= 5, 'Route region is too large');
    const url = new URL('https://router.project-osrm.org/route/v1/driving/' + coordinates.map(point => point.join(',')).join(';'));
    url.search = new URLSearchParams({ overview: 'full', geometries: 'geojson', steps: 'false' }).toString();
    return { url, ttl: 900000 };
  });

  app.use('/api', (request, response) => response.status(404).json({ error: 'Unknown API endpoint' }));
  app.get('/', (request, response) => response.sendFile(join(ROOT, 'index.html')));
  for (const file of STATIC_FILES) app.get('/' + file, (request, response) => response.sendFile(join(ROOT, file)));
  app.get('/waymo-data.csv', (request, response) => response.sendFile(join(ROOT, WAYMO_CSV_FILE)));
  app.use((request, response) => response.status(404).type('text/plain').send('Not found'));
  app.use((error, request, response, next) => {
    if (response.headersSent) { next(error); return; }
    const status = error instanceof ApiError ? error.status : error.type === 'entity.too.large' ? 413 : error.status === 400 ? 400 : 500;
    const message = error instanceof ApiError ? error.message : status === 413 ? 'Request body is too large' : status === 400 ? 'Invalid request' : 'Internal server error';
    if (status === 500) console.error('API error', response.getHeader('X-Request-ID'), error.name);
    if (error.retryAfter) response.set('Retry-After', error.retryAfter);
    response.status(status).json({ error: message });
  });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = integer(process.env.PORT || '3000', 1, 65535, 'PORT');
  const host = process.env.HOST || '127.0.0.1';
  const trustProxy = process.env.TRUST_PROXY === '1' ? 1 : false;
  const app = createApp({ trustProxy });
  const server = app.listen(port, host, () => console.log('AV analysis: http://' + (host === '0.0.0.0' ? 'localhost' : host) + ':' + port));
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('error', error => { console.error('Server could not start:', error.code); process.exitCode = 1; });
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}