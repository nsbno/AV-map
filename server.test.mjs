test('allows large OSM extents to be split into more than thirty bounded requests', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('const OSM_MIN_TILE_SPAN'), source.indexOf('async function nvdbObjects('));
  const context = {};
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.splitBox = splitBox;', context);
  assert.equal(context.splitBox([0, 0, 0.3, 0.3], 0.03, Infinity).length, 100);
  assert.ok(context.splitBox([0, 0, 0.06, 0.06], 0.0299, Infinity).every(box => box[2] - box[0] <= 0.03 && box[3] - box[1] <= 0.03));
  assert.equal(context.splitBox([10.74, 59.91, 10.92, 60], 0.0599, Infinity).length, 8);
  assert.ok(context.splitBox([0, 0, 0.12, 0.12], 0.0599, Infinity).every(box => box[2] - box[0] <= 0.06 && box[3] - box[1] <= 0.06));
  assert.throws(() => context.splitBox([0, 0, 0.3, 0.3], 0.03), /Området er for stort/);
});

test('file mode uses bounded OSM map requests and recursively splits timed-out tiles', async () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const splitAndPool = source.slice(source.indexOf('const OSM_MIN_TILE_SPAN'), source.indexOf('async function nvdbObjects('));
  const loader = source.slice(source.indexOf('async function loadOsmMapFeatures('), source.indexOf('function speedValue('));
  const calls = [];
  const context = {
    URL,
    location: { protocol: 'file:' },
    app: { cache: new Map(), bypassCacheUntil: 0 },
    toast() {},
    parseOsmMapFeatures: () => ({ tram: [], cycleLane: [], cycleway: [], roads: [], junctions: [], signals: [], crossings: [] }),
    loadedOsmTramTrackFeatures: () => [],
    loadedOsmCyclewayFeatures: () => [],
    requestText: async (url, signal, fallbacks) => {
      const request = new URL(url);
      assert.equal(request.hostname, 'api.openstreetmap.org');
      assert.equal(request.pathname, '/api/0.6/map');
      assert.equal(fallbacks?.length || 0, 0);
      assert.equal(request.searchParams.has('poly'), false);
      const box = request.searchParams.get('bbox').split(',').map(Number);
      calls.push(box);
      if (box[2] - box[0] > 0.004 || box[3] - box[1] > 0.004) throw new Error('HTTP 504: query timed out');
      return '<osm />';
    }
  };
  vm.createContext(context);
  vm.runInContext(splitAndPool + loader + '\nglobalThis.loadOsmMapFeatures = loadOsmMapFeatures;', context);
  const result = await context.loadOsmMapFeatures([0, 0, 0.03, 0.03]);
  assert.ok(calls.length > 30);
  assert.equal(result.osmFailedTiles, 0);
  assert.equal(result.osmLoadedBoxes.length, 64);
});

test('clips OSM map results to the exact scope polygon', async () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const splitAndPool = source.slice(source.indexOf('const OSM_MIN_TILE_SPAN'), source.indexOf('async function nvdbObjects('));
  const loader = source.slice(source.indexOf('async function loadOsmMapFeatures('), source.indexOf('function speedValue('));
  const coordinates = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0],];
  const scope = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coordinates] }, properties: {} };
  const intersection = { ...scope, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0]]] } };
  let requestUrl;
  let clipped = false;
  const context = {
    URL, location: { protocol: 'file:' }, app: { cache: new Map(), bypassCacheUntil: 0 },
    turf: { bboxPolygon: () => ({}), intersect: () => intersection },
    toast() {}, clipFeatures: features => { clipped = true; return features; },
    parseOsmMapFeatures: () => ({ tram: [], cycleLane: [], cycleway: [], roads: [], junctions: [], signals: [], crossings: [] }),
    loadedOsmTramTrackFeatures: () => [], loadedOsmCyclewayFeatures: () => [],
    requestText: async url => { requestUrl = url; return '<osm />'; }
  };
  vm.createContext(context);
  vm.runInContext(splitAndPool + loader + '\nglobalThis.loadOsmMapFeatures = loadOsmMapFeatures;', context);
  const result = await context.loadOsmMapFeatures([0, 0, 0.01, 0.01], null, scope);
  const request = new URL(requestUrl);
  assert.equal(request.pathname, '/api/0.6/map');
  assert.equal(request.searchParams.get('bbox'), '0,0,0.01,0.01');
  assert.equal(request.searchParams.has('poly'), false);
  assert.equal(clipped, true);
  assert.equal(result.osmFailedTiles, 0);
});

test('subdivides oversized NVDB width tiles and deduplicates objects', async () => {
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createApp } from './server.mjs';

const planner = '{quaysByBbox(minimumLatitude:59.91,minimumLongitude:10.74,maximumLatitude:59.92,maximumLongitude:10.76){id name}}';
const vehicles = '{vehicles(boundingBox:{minLon:10.74,minLat:59.91,maxLon:10.76,maxLat:59.92},mode:BUS,maxDataAge:"PT2M",includeInvalidLocations:false){vehicleId location{latitude longitude}}}';
const nvdb = '/api/nvdb/objects/105?kartutsnitt=10.74,59.91,10.76,59.92&antall=2000&srid=4326&inkluder=geometri,egenskaper&inkluderAntall=false';

async function start(options, context, onRequest) {
  const server = createApp(options).listen(0, '127.0.0.1');
  if (onRequest) server.on('request', onRequest);
  await new Promise(resolve => server.once('listening', resolve));
  context.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}

function post(url, query, options = {}) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), ...options });
}

function postJSON(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('frontend maps only approved upstream URLs and preserves file mode', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function dataApiURL('), source.indexOf('async function requestJSON('));
  const context = { URL, location: { protocol: 'https:', href: 'https://av.example/' } };
  vm.createContext(context);
  vm.runInContext(code, context);
  for (const [url, expected] of [
    ['https://api.entur.io/journey-planner/v3/graphql', '/api/entur/journey-planner'],
    ['https://api.entur.io/realtime/v2/vehicles/graphql', '/api/entur/vehicles'],
    ['https://nvdbapiles.atlas.vegvesen.no/vegobjekter/api/v4/vegobjekter/105?srid=4326', '/api/nvdb/objects/105?srid=4326'],
    ['https://api.openstreetmap.org/api/0.6/map?bbox=10.74,59.91,10.75,59.92', '/api/osm/map?bbox=10.74,59.91,10.75,59.92'],
    ['https://ws.geonorge.no/adresser/v1/sok?sok=Oslo', '/api/geonorge/addresses?sok=Oslo'],
    ['https://router.project-osrm.org/route/v1/driving/10,59;11,60', '/api/osrm/route/10,59;11,60']
  ]) assert.equal(context.dataApiURL(url), expected);
  assert.throws(() => context.dataApiURL('https://evil.example/data'));
  context.location.protocol = 'file:';
  assert.equal(context.dataApiURL('https://api.entur.io/journey-planner/v3/graphql'), 'https://api.entur.io/journey-planner/v3/graphql');
});

test('sends bounded OSM requests to the proxy in a POST body', async () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('let osmRequestQueue ='), source.indexOf('async function graphql('));
  let request;
  const context = {
    AbortSignal, Date, DOMException, setTimeout, clearTimeout, URL, URLSearchParams, Response,
    location: { protocol: 'https:' },
    dataApiURL: url => {
      const target = new URL(url);
      return '/api/osm/map' + target.search;
    },
    fetch: async (url, options) => { request = { url, options }; return new Response('<osm />'); }
  };
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.requestText = requestText;', context);
  await context.requestText('https://api.openstreetmap.org/api/0.6/map?bbox=10.74,59.91,10.75,59.92');
  assert.equal(request.url, '/api/osm/map');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { bbox: '10.74,59.91,10.75,59.92' });
});

test('stops issuing OSM requests during a 509 cooldown', async () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('let osmRequestQueue ='), source.indexOf('async function graphql('));
  let requests = 0;
  const context = {
    AbortSignal, Date, DOMException, setTimeout, clearTimeout, URL, URLSearchParams, Response,
    location: { protocol: 'file:' },
    dataApiURL: url => url,
    fetch: async () => {
      requests++;
      return new Response('You have downloaded too much data. Please try again in 60 seconds.', {
        status: 509, headers: { 'Retry-After': '60' }
      });
    }
  };
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.requestText = requestText;', context);
  const url = 'https://api.openstreetmap.org/api/0.6/map?bbox=10,59,10.01,59.01';
  await assert.rejects(context.requestText(url), /HTTP 509/);
  await assert.rejects(context.requestText(url), /OpenStreetMap paused requests/);
  assert.equal(requests, 1);
});

test('deduplicates Waymo miles per S2 cell and preserves outcome-specific benchmarks', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function parseWaymoCells('), source.indexOf('function waymoMileageColors('));
  class S2CellId { constructor(id) { this.id = id; } }
  class S2Cell { constructor(id) { this.id = id.id; } toGEOJSON() { return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }; } }
  const context = {};
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.parseWaymoCells = parseWaymoCells;', context);
  const cells = context.parseWaymoCells([
    { state_name: 'Arizona', county_name: 'Maricopa', 'S2 Cell': '9739878636298698752', 'Waymo RO Miles': '120', 'HPMS Yearly Vehicle Miles Traveled': '5000', Outcome: 'police_reported', 'Benchmark Crash Count': '2.5' },
    { state_name: 'Arizona', county_name: 'Maricopa', 'S2 Cell': '9739878636298698752', 'Waymo RO Miles': '120', 'HPMS Yearly Vehicle Miles Traveled': '5000', Outcome: 'fatal', 'Benchmark Crash Count': '0' },
    { state_name: 'California', county_name: 'San Francisco', 'S2 Cell': '9739878636298698752', 'Waymo RO Miles': '900', Outcome: 'fatal', 'Benchmark Crash Count': '1' }
  ], S2CellId, S2Cell);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].properties.waymoMiles, 120);
  assert.deepEqual(cells[0].properties.benchmarkCrashes, { police_reported: 2.5, fatal: 0 });
});

test('classifies OSM complexity as low, normal, or high', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const scoreCode = source.slice(source.indexOf('function roadComplexityScore('), source.indexOf('function complexityTiles('));
  const context = {};
  vm.createContext(context);
  vm.runInContext(scoreCode + '\nglobalThis.roadComplexityScore = roadComplexityScore;', context);
  const narrowUrban = context.roadComplexityScore({ speed: 80, width: 5.2, incline: 9, curvature: 50, junctions: 1, crossings: 1, signals: 0, signalsWithin10m: 0, tramTrackInRoad: true, tunnelLength: 0, roadClass: 'primary', lanes: 4, separated: false });
  const unprotectedCrossing = context.roadComplexityScore({ crossings: 1, signalsWithin10m: 0 });
  const signalizedCrossing = context.roadComplexityScore({ crossings: 1, signalsWithin10m: 1 });
  const removedIndicators = context.roadComplexityScore({ width: 5, incline: 9, curvature: 50, roadClass: 'motorway', lanes: 5 });
  const noEvidence = context.roadComplexityScore({});
  const roadClassOnly = context.roadComplexityScore({ roadClass: 'residential' });
  const unsupportedLocalMetrics = context.roadComplexityScore({ roadClass: 'residential', aadt: 50000, accidents: 9 });
  const longTunnel = context.roadComplexityScore({ tunnelLength: 1800 }, new Set(['tunnel']));
  const junctionDefault = context.roadComplexityScore({ junctions: 2 });
  const junctionDisabled = context.roadComplexityScore({ junctions: 2 }, undefined, { junctions: 0 });
  const junctionDoubled = context.roadComplexityScore({ junctions: 2 }, undefined, { junctions: 2 });
  const junctionDefault = context.roadComplexityScore({ junctions: 2 });
  const junctionDisabled = context.roadComplexityScore({ junctions: 2 }, undefined, { junctions: 0 });
  const junctionDoubled = context.roadComplexityScore({ junctions: 2 }, undefined, { junctions: 2 });
  assert.equal(narrowUrban.category, 'high');
  assert.ok(unprotectedCrossing.score > signalizedCrossing.score);
  assert.equal(removedIndicators.score, noEvidence.score);
  assert.equal(noEvidence.category, 'normal');
  assert.equal(roadClassOnly.category, 'normal');
  assert.equal(unsupportedLocalMetrics.score, roadClassOnly.score);
  assert.equal(junctionDefault.score, 2);
  assert.equal(junctionDisabled.score, 0);
  assert.equal(junctionDoubled.score, 4);
  assert.equal(junctionDefault.score, 2);
  assert.equal(junctionDisabled.score, 0);
  assert.equal(junctionDoubled.score, 4);
  assert.equal(context.roadComplexityScore({ junctions: 1 }).category, 'normal');
  assert.equal(context.roadComplexityScore({ speed: 120 }).score, context.roadComplexityScore({ speed: 0 }).score);
  assert.equal(longTunnel.category, 'high');
  assert.equal(context.roadComplexityScore({ cycleType: 'Sykkelfelt i sykkelveg' }).category, 'low');
  assert.equal(context.roadComplexityScore({ separated: true }).category, 'low');
  assert.match(source, /const COMPLEXITY_COLORS = \{ high: '#b13543', normal: '#d28a2f', low: '#08775e' \}/);
  assert.doesNotMatch(source.slice(source.indexOf('function loadRoadComplexity('), source.indexOf('async function loadStops(')), /nvdbForBox|ROAD_TYPES/);
  assert.doesNotMatch(source.slice(source.indexOf('const COMPLEXITY_FACTORS'), source.indexOf('const SPEED_COLORS')), /accidents/);
  assert.match(source, /key: 'speed', label: 'Fartsgrense · OSM', group: 'neutral'/);
  assert.match(source, /\['increase', 'Øker kompleksiteten'\], \['reduce', 'Reduserer kompleksiteten'\], \['neutral', 'Nøytral påvirkning'\]/);
});

test('aggregates overview cells into the same three complexity categories', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function complexityTiles('), source.indexOf('function rescoreComplexity('));
  const context = {
    activeScope: () => null,
    turf: {
      along: () => ({ geometry: { coordinates: [0.002, 0.001] } }),
      length: feature => feature.properties.length,
      bboxPolygon: () => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: {} })
    },
    COMPLEXITY_COLORS: { high: 'red', normal: 'amber', low: 'green' }
  };
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.complexityTiles = complexityTiles;', context);
  const tiles = context.complexityTiles([
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { score: 0, category: 'normal', structured: false, length: 0.1 } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { score: 1, category: 'normal', structured: false, hasEvidence: true, length: 0.1 } }
  ]);
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0].properties.category, 'normal');
  assert.deepEqual(JSON.parse(JSON.stringify(tiles[0].properties.segments)), { high: 0, normal: 2, low: 0 });
});

test('normalizes OSM speed tags for cross-region use', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function osmSpeedKph('), source.indexOf('function parseOsmMapFeatures('));
  const context = {};
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.osmSpeedKph = osmSpeedKph;', context);
  assert.equal(context.osmSpeedKph({ maxspeed: '25 mph' }), 40.2335);
  assert.equal(context.osmSpeedKph({ maxspeed: 'US:urban' }), null);
});

test('complexity indexes the OSM road and feature datasets', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function complexityIndexes('), source.indexOf('function complexityCandidates('));
  const context = { complexityIndex: features => features };
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.complexityIndexes = complexityIndexes;', context);
  const roads = [{ type: 'Feature' }];
  const indexes = context.complexityIndexes({ roads, tram: [], osmTileCount: 2, osmFailedTiles: 1, osmLoadedBoxes: [[10, 59, 10.01, 59.01]] });
  assert.deepEqual(Object.keys(indexes), ['roads', 'cycleLane', 'cycleway', 'tram', 'junctions', 'crossings', 'signals']);
  assert.equal(indexes.roads, roads);
  assert.deepEqual(indexes.tram, []);
});

test('categorizes OSM complexity speed values separately and preserves unknown tags', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function complexitySpeedCategoryKey('), source.indexOf('function renderComplexitySpeedCategories('));
  const context = {};
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.complexitySpeedCategoryKey = complexitySpeedCategoryKey;', context);
  assert.equal(context.complexitySpeedCategoryKey({ properties: { osm_speed_kph: 30 } }), '30.0');
  assert.equal(context.complexitySpeedCategoryKey({ properties: { osm_speed_kph: 40.2 } }), '40.2');
  assert.equal(context.complexitySpeedCategoryKey({ properties: { osm_speed_kph: null } }), 'unknown');
});

test('scores tram only when an explicit OSM tram track is near the road', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function tramTracksMatchRoad('), source.indexOf('function countComplexityPoints('));
  const context = {
    turf: { along: () => ({}), length: () => 0.1 },
    nearestComplexityFeature: (point, features) => features?.length ? { feature: features[0], distance: features[0].distance } : null
  };
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.tramTracksMatchRoad = tramTracksMatchRoad;', context);
  assert.equal(context.tramTracksMatchRoad({}, [{ distance: 3, properties: { railway: 'tram' } }]), true);
  assert.equal(context.tramTracksMatchRoad({}, []), false);
  assert.equal(context.tramTracksMatchRoad({}, [{ distance: 4.1, properties: { railway: 'tram' } }]), false);
  assert.equal(context.tramTracksMatchRoad({}, [{ distance: 3, properties: { railway: 'rail' } }]), false);
});

test('classifies on-road and separate OSM cycleways without treating bicycle access as a lane', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function osmCyclewayCategories('), source.indexOf('function parseOsmMapFeatures('));
  const context = {};
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.osmCyclewayCategories = osmCyclewayCategories;', context);
  assert.deepEqual(context.osmCyclewayCategories({ highway: 'primary', cycleway: 'lane' }), { lane: true, separate: false });
  assert.deepEqual(context.osmCyclewayCategories({ highway: 'residential', 'cycleway:right': 'shared_lane' }), { lane: true, separate: false });
  assert.deepEqual(context.osmCyclewayCategories({ highway: 'residential', 'cycleway:left': 'track' }), { lane: false, separate: true });
  assert.deepEqual(context.osmCyclewayCategories({ highway: 'cycleway', bicycle: 'designated' }), { lane: false, separate: true });
  assert.deepEqual(context.osmCyclewayCategories({ highway: 'path', bicycle: 'designated', foot: 'designated' }), { lane: false, separate: true });
  assert.deepEqual(context.osmCyclewayCategories({ highway: 'residential', bicycle: 'designated' }), { lane: false, separate: false });
});
 
test('filters loaded map tiles to physical tram-track subclasses', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function loadedOsmTramTrackFeatures('), source.indexOf('function speedValue('));
  const features = [
    { type: 'Feature', id: 21, properties: { class: 'transit', subclass: 'tram' }, geometry: { type: 'MultiLineString', coordinates: [[[10, 59], [10.1, 59.1]]] } },
    { type: 'Feature', id: 22, properties: { class: 'rail', subclass: 'rail' }, geometry: { type: 'LineString', coordinates: [[10, 59], [10.1, 59.1]] } },
    { type: 'Feature', id: 23, properties: { class: 'transit', subclass: 'subway' }, geometry: { type: 'LineString', coordinates: [[10, 59], [10.1, 59.1]] } },
    { type: 'Feature', id: 24, properties: { class: 'transit', subclass: 'light_rail' }, geometry: { type: 'LineString', coordinates: [[10, 59], [10.1, 59.1]] } },
    { type: 'Feature', id: 25, properties: { class: 'path', subclass: 'cycleway' }, geometry: { type: 'LineString', coordinates: [[10, 59], [10.1, 59.1]] } }
  ];
  const context = {
    app: { engine: { map: { querySourceFeatures: () => features } } },
    turf: { bboxPolygon: box => box, booleanIntersects: () => true }
  };
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.loadedOsmTramTrackFeatures = loadedOsmTramTrackFeatures;', context);
  const tracks = context.loadedOsmTramTrackFeatures([10, 59, 11, 60]);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].properties.subclass, 'tram');
});

test('loads separate OSM cycleways but excludes generic paths and road access tags', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function loadedOsmCyclewayFeatures('), source.indexOf('function speedValue('));
  const features = [
    { type: 'Feature', id: 31, properties: { class: 'path', subclass: 'cycleway', bicycle: 'designated' }, geometry: { type: 'MultiLineString', coordinates: [[[10, 59], [10.1, 59.1]]] } },
    { type: 'Feature', id: 32, properties: { class: 'path', subclass: 'path', bicycle: 'designated', foot: 'designated' }, geometry: { type: 'LineString', coordinates: [[10, 59], [10.1, 59.1]] } },
    { type: 'Feature', id: 33, properties: { class: 'path', subclass: 'footway', bicycle: 'yes' }, geometry: { type: 'LineString', coordinates: [[10, 59], [10.1, 59.1]] } },
    { type: 'Feature', id: 34, properties: { class: 'minor', bicycle: 'designated' }, geometry: { type: 'LineString', coordinates: [[10, 59], [10.1, 59.1]] } }
  ];
  const context = {
    app: { engine: { map: { querySourceFeatures: () => features } } },
    turf: { bboxPolygon: box => box, booleanIntersects: () => true }
  };
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.loadedOsmCyclewayFeatures = loadedOsmCyclewayFeatures;', context);
  const paths = context.loadedOsmCyclewayFeatures([10, 59, 11, 60]);
  assert.equal(paths.length, 2);
  assert.deepEqual(paths.map(feature => feature.id), [31, 32]);
  assert.ok(paths.every(feature => feature.properties.cycleType === 'Sykkelfelt i sykkelveg'));
});

test('keeps NVDB elevation profiles separate for multipart road geometries', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function nvdbElevationProfiles('), source.indexOf('function nvdbFeature('));
  const context = { turf: { point: coordinates => coordinates, distance: () => 0.1 } };
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.nvdbElevationProfiles = nvdbElevationProfiles;', context);
  const profiles = context.nvdbElevationProfiles('MULTILINESTRING Z ((59.9 10.7 100,59.901 10.701 110),(59.91 10.71 200,59.911 10.711 205))');
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0][0][1], 100);
  assert.equal(profiles[1][0][0], 0);
  assert.equal(profiles[1][0][1], 200);
});

test('counts signal points and line geometries within ten meters of the full road segment', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function lineToLineDistanceMeters('), source.indexOf('function complexityProperty('));
  const near = { geometry: { type: 'Point' }, properties: { distanceMeters: 5 } };
  const far = { geometry: { type: 'Point' }, properties: { distanceMeters: 11 } };
  const nearLine = { geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { distanceMeters: 6 } };
  const farMultiLine = { geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] }, properties: { distanceMeters: 11 } };
  const context = {
    turf: {
      along: () => ({}), length: () => 0.1, booleanIntersects: () => false,
      flatten: feature => ({ features: feature.geometry.coordinates.map(coordinates => ({ geometry: { type: 'LineString', coordinates }, properties: feature.properties })) }),
      point: coordinates => ({ geometry: { type: 'Point', coordinates } }),
      pointToLineDistance: (point, line) => (line.properties?.distanceMeters ?? point.properties?.distanceMeters ?? 100) / 1000
    },
    complexityCandidates: () => [near, far, nearLine, farMultiLine]
  };
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.countComplexityFeaturesNearLine = countComplexityFeaturesNearLine;', context);
  assert.equal(context.countComplexityFeaturesNearLine({ geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }, {}, 10), 2);
});

test('uses imported Polygon and MultiPolygon geometries directly as data scopes', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function activeScope('), source.indexOf('function dataBox('));
  const polygon = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: {} };
  const multipolygon = { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [] }, properties: {} };
  const context = { app: { scopeId: 'scope', drawings: new Map([['scope', { feature: polygon }]]) }, turf: { buffer: () => { throw new Error('Area must not be buffered'); } } };
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.activeScope = activeScope;', context);
  assert.equal(context.activeScope(), polygon);
  context.app.drawings.set('scope', { feature: multipolygon });
  assert.equal(context.activeScope(), multipolygon);
});

test('does not recompute the complexity proxy during ordinary viewport refreshes', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function refreshViewport('), source.indexOf('async function analyzeRoute('));
  assert.doesNotMatch(code, /loadRoadComplexity/);
});

test('subdivides oversized NVDB width tiles and deduplicates objects', async () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const splitAndPool = source.slice(source.indexOf('function splitBox('), source.indexOf('async function nvdbObjects('));
  const fetchBox = source.slice(source.indexOf('async function nvdbForBox('), source.indexOf('function renderRoadControls('));
  const calls = [];
  let retries = 0;
  const context = {
    nvdbObjects: async (type, box) => {
      calls.push({ type, box });
      if (box[2] - box[0] > 0.030001 || box[3] - box[1] > 0.030001) {
        retries++;
        const error = new Error('page cap'); error.code = 'NVDB_TILE_LIMIT'; throw error;
      }
      return [{ type: 'Feature', properties: { nvdb_id: 7 } }];
    }
  };
  vm.createContext(context);
  vm.runInContext(splitAndPool + fetchBox + '\nglobalThis.nvdbForBox = nvdbForBox;', context);
  const features = await context.nvdbForBox(838, [10, 59, 10.06, 59.06]);
  assert.equal(calls.length, 5);
  assert.equal(retries, 1);
  assert.ok(calls.slice(1).every(({ box }) => box[2] - box[0] <= 0.030001 && box[3] - box[1] <= 0.030001));
  assert.equal(features.length, 1);
  assert.equal(features[0].properties.nvdb_id, 7);
});

test('reports the NVDB type and tile when a bounded retry still exceeds limits', async () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const splitAndPool = source.slice(source.indexOf('function splitBox('), source.indexOf('async function nvdbObjects('));
  const fetchBox = source.slice(source.indexOf('async function nvdbForBox('), source.indexOf('function renderRoadControls('));
  const context = {
    nvdbObjects: async () => { const error = new Error('page cap'); error.code = 'NVDB_TILE_LIMIT'; throw error; }
  };
  vm.createContext(context);
  vm.runInContext(splitAndPool + fetchBox + '\nglobalThis.nvdbForBox = nvdbForBox;', context);
  await assert.rejects(context.nvdbForBox(838, [10, 59, 10.06, 59.06]), /NVDB type 838 · område .*for mye data/);
});

test('serves the app but not backend code or private files', async context => {
  const base = await start({}, context);
  assert.match(await (await fetch(base)).text(), /Selvkj/);
  for (const path of ['/analysis-app.js', '/map-engine.js', '/transit-state.js', '/api/health', '/' + encodeURIComponent('CSV4 - Miles and Benchmark Crashes for Dynamic Benchmark 202009-202606-2022benchmark_v2.csv')]) assert.equal((await fetch(base + path)).status, 200);
  assert.equal((await fetch(base + '/rb_norway-aggregated-gtfs.zip')).status, 404);
  for (const path of ['/server.mjs', '/package.json', '/.env', '/node_modules/express/package.json', '/api/proxy?url=https://evil.example']) assert.equal((await fetch(base + path)).status, 404);
});

test('forwards all supported services with server-owned headers and caching', async context => {
  const calls = [];
  const base = await start({ fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ result: 'ok' }); } }, context);
  assert.equal((await post(base + '/api/entur/journey-planner', planner)).status, 200);
  assert.equal((await post(base + '/api/entur/vehicles', vehicles)).status, 200);
  const first = await fetch(base + nvdb, { headers: { Authorization: 'not-forwarded', 'X-Client': 'not-forwarded' } });
  assert.equal(first.headers.get('x-proxy-cache'), 'MISS');
  const second = await fetch(base + nvdb);
  assert.equal(second.headers.get('x-proxy-cache'), 'HIT');
  assert.equal((await fetch(base + '/api/geonorge/addresses?sok=Oslo&treffPerSide=5')).status, 200);
  assert.equal((await fetch(base + '/api/osrm/route/10.74,59.91;10.76,59.92?overview=full&geometries=geojson&steps=false')).status, 200);
  assert.equal(calls.length, 5);
  assert.equal(calls[0].options.headers['ET-Client-Name'], process.env.ENTUR_CLIENT_NAME || 'vy-av-analysis');
  assert.equal(calls[2].options.headers.Authorization, undefined);
  assert.notEqual(calls[2].options.headers['X-Client'], 'not-forwarded');
  assert.equal(new URL(calls[2].url).searchParams.get('antall'), '800');
  assert.ok(calls.every(call => call.options.redirect === 'error'));
});

test('limits NVDB traffic accidents to the supported ten-year window', async context => {
  const calls = [];
  const base = await start({ fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ objekter: [] }); } }, context);
  const params = new URLSearchParams({ kartutsnitt: '10.74,59.91,10.76,59.92', antall: '800', srid: '4326', inkluder: 'geometri,egenskaper', inkluderAntall: 'false' });
  params.append('egenskap', '5055>=2016-01-01');
  params.append('egenskap', '5055<=2025-12-31');
  assert.equal((await fetch(base + '/api/nvdb/objects/570?' + params)).status, 200);
  assert.deepEqual(new URL(calls[0].url).searchParams.getAll('egenskap'), ['5055>=2016-01-01', '5055<=2025-12-31']);
  assert.equal((await fetch(base + '/api/nvdb/objects/570?kartutsnitt=10.74,59.91,10.76,59.92')).status, 400);
  params.set('egenskap', '5055>=1900-01-01');
  assert.equal((await fetch(base + '/api/nvdb/objects/570?' + params)).status, 400);
});

test('proxies bounded OSM map requests and caches the XML response', async context => {
  const calls = [];
  const xml = '<osm version="0.6"><node id="1" lat="59.91" lon="10.74"/></osm>';
  const base = await start({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(xml, { headers: { 'Content-Type': 'application/xml' } });
  } }, context);
  const tile = '/api/osm/map?bbox=10.74,59.91,10.75,59.92';
  const response = await fetch(base + tile);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/xml/);
  assert.equal(await response.text(), xml);
  assert.equal((await fetch(base + tile)).headers.get('x-proxy-cache'), 'HIT');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).hostname, 'api.openstreetmap.org');
  assert.equal(new URL(calls[0].url).pathname, '/api/0.6/map');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(new URL(calls[0].url).searchParams.get('bbox'), '10.74,59.91,10.75,59.92');
  assert.equal((await fetch(base + '/api/osm/map?bbox=10.74,59.91,10.7999,59.9699')).status, 200);
  assert.equal((await fetch(base + '/api/osm/map?bbox=10.74,59.91,10.81,59.92')).status, 400);
  assert.equal((await postJSON(base + '/api/osm/map', { bbox: '10.74,59.91,10.75,59.92' })).status, 200);
  assert.equal((await fetch(base + '/api/osm/map?bbox=10.74,59.91,10.75,59.92', { method: 'DELETE' })).status, 405);
});

test('preserves OSM 509 cooldown instructions through the proxy', async context => {
  const base = await start({ fetchImpl: async () => new Response('You have downloaded too much data. Please try again in 47 seconds.', {
    status: 509, headers: { 'Retry-After': '47', 'Content-Type': 'text/plain' }
  }) }, context);
  const response = await fetch(base + '/api/osm/map?bbox=10.74,59.91,10.75,59.92');
  assert.equal(response.status, 509);
  assert.equal(response.headers.get('retry-after'), '47');
  assert.match((await response.json()).error, /try again in 47 seconds/i);
});

test('preserves OSM map size errors so the client can split oversized tiles', async context => {
  const base = await start({ fetchImpl: async () => new Response('You requested too many nodes.', { status: 400 }) }, context);
  const response = await fetch(base + '/api/osm/map?bbox=10.74,59.91,10.75,59.92');
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /too many nodes/i);
});

test('parses OSM way geometry and finds shared road intersections', () => {
  const source = readFileSync(new URL('./analysis-app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function osmCyclewayCategories('), source.indexOf('async function loadOsmMapFeatures('));
  class Element {
    constructor(name, attributes = {}, children = []) { this.name = name; this.attributes = attributes; this.children = children; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    getElementsByTagName(name) { return this.children.flatMap(child => child.name === name ? [child] : child.getElementsByTagName(name)); }
  }
  const tag = (k, v) => new Element('tag', { k, v });
  const nd = (ref, lon, lat) => new Element('nd', { ref, lon: String(lon), lat: String(lat) });
  const ways = [
    new Element('way', { id: '1' }, [tag('highway', 'residential'), nd('a', 10, 59), nd('center', 10.001, 59)]),
    new Element('way', { id: '2' }, [tag('highway', 'residential'), nd('center', 10.001, 59), nd('b', 10.001, 59.001)]),
    new Element('way', { id: '3' }, [tag('highway', 'residential'), nd('center', 10.001, 59), nd('c', 10.002, 59)])
  ];
  const context = {
    DOMParser: class { parseFromString() { return { querySelector: () => null, getElementsByTagName: name => name === 'way' ? ways : name === 'node' ? [] : [] }; } },
    turf: { lineString: (coordinates, properties) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties }), point: (coordinates, properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties }) }
  };
  vm.createContext(context);
  vm.runInContext(code + '\nglobalThis.parseOsmMapFeatures = parseOsmMapFeatures;', context);
  const parsed = context.parseOsmMapFeatures('<osm />');
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.roads[0].geometry.coordinates)), [[10, 59], [10.001, 59]]);
  assert.ok(parsed.junctions.some(feature => feature.properties.junction === 'road_intersection' && feature.geometry.coordinates[0] === 10.001));
});

test('loads tunnel loops through the bounded NVDB route', async context => {
  const calls = [];
  const base = await start({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ objekter: [] });
  } }, context);
  const box = '10.74,59.91,10.76,59.92';
  assert.equal((await fetch(base + '/api/nvdb/objects/67?kartutsnitt=' + box + '&antall=800&srid=4326&inkluder=geometri,egenskaper&inkluderAntall=false')).status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /vegobjekter\/67/);
});

test('rejects open-proxy attempts, invalid inputs and wrong HTTP methods', async context => {
  let calls = 0;
  const base = await start({ fetchImpl: async () => { calls++; return Response.json({}); } }, context);
  const invalid = [
    '/api/nvdb/objects/999?kartutsnitt=10,59,11,60',
    '/api/nvdb/objects/953?kartutsnitt=10,59,10.01,59.01',
    '/api/nvdb/objects/105?kartutsnitt=-180,-80,180,80',
    '/api/nvdb/objects/105?kartutsnitt=10,59,11,60&url=https://evil.example',
    '/api/nvdb/objects/105?kartutsnitt=10,59,11,60&srid=25833',
    '/api/nvdb/objects/105?kartutsnitt=10,59,11,60&antall=1&antall=2',
    '/api/geonorge/addresses?sok=x',
    '/api/osrm/route/999,99;11,60',
    '/api/osrm/route/10,59',
    '/api/osrm/route/10,59;11,60?steps=true'
  ];
  for (const path of invalid) assert.equal((await fetch(base + path)).status, 400, path);
  for (const query of ['mutation { removeEverything }', '{__schema{queryType{name}}}', '{lines{id}}', '{quaysByBbox(minimumLatitude:-80,minimumLongitude:-180,maximumLatitude:80,maximumLongitude:180){id}}', '{line(id:"x"){...Details}} fragment Details on Line{id}', '{quay(id:"x"){estimatedCalls(numberOfDepartures:9999){realtime}}}']) {
    assert.equal((await post(base + '/api/entur/journey-planner', query)).status, 400, query);
  }
  assert.equal((await fetch(base + '/api/entur/vehicles')).status, 405);
  assert.equal((await post(base + '/api/nvdb/objects/105', planner)).status, 405);
  assert.equal(calls, 0);
});

test('supports bounded GraphQL variables', async context => {
  const base = await start({ fetchImpl: async () => Response.json({ data: { quay: null } }) }, context);
  const response = await fetch(base + '/api/entur/journey-planner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'query Stop($id: String!){quay(id:$id){id}}', variables: { id: 'NSR:Quay:1' }, operationName: 'Stop' }) });
  assert.equal(response.status, 200);
});

test('blocks cross-origin API requests and bounds request size', async context => {
  const base = await start({}, context);
  assert.equal((await post(base + '/api/entur/journey-planner', planner, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await post(base + '/api/entur/journey-planner', 'x'.repeat(70000))).status, 413);
  const malformed = await fetch(base + '/api/entur/journey-planner', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
  assert.equal(malformed.status, 400);
  assert.equal((await fetch(base + '/api/health')).headers.get('access-control-allow-origin'), null);
});

test('rate limits by client', async context => {
  const base = await start({ rateLimit: 2 }, context);
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.equal((await fetch(base + '/api/health')).status, 200);
  const limited = await fetch(base + '/api/health');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('coalesces concurrent requests and expires cache entries', async context => {
  let time = 1000, calls = 0;
  let release, reportStarted, reportSecond;
  const wait = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reportStarted = resolve; });
  const secondReceived = new Promise(resolve => { reportSecond = resolve; });
  let requests = 0;
  const base = await start({ now: () => time, fetchImpl: async () => { calls++; reportStarted(); await wait; return Response.json({ data: {} }); } }, context,
    request => { if (++requests === 2) request.once('end', reportSecond); });
  const first = post(base + '/api/entur/vehicles', vehicles);
  await started;
  const second = post(base + '/api/entur/vehicles', vehicles);
  await secondReceived;
  release();
  const responses = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.ok(responses.every(response => response.status === 200));
  assert.ok(responses.some(response => response.headers.get('x-proxy-cache') === 'COALESCED'));
  time += 6000;
  await post(base + '/api/entur/vehicles', vehicles);
  assert.equal(calls, 2);
});

test('returns safe upstream errors and does not cache GraphQL errors', async context => {
  let calls = 0;
  const base = await start({ fetchImpl: async url => {
    calls++;
    if (url.includes('geonorge')) return new Response('Bad gateway', { status: 503 });
    if (url.includes('osrm')) return new Response('<html>not JSON</html>');
    return Response.json({ errors: [{ message: 'Temporary failure' }] });
  } }, context);
  assert.equal((await fetch(base + '/api/geonorge/addresses?sok=Oslo')).status, 502);
  assert.equal((await fetch(base + '/api/osrm/route/10,59;11,60')).status, 502);
  await post(base + '/api/entur/vehicles', vehicles);
  await post(base + '/api/entur/vehicles', vehicles);
  assert.equal(calls, 4);
});

test('limits upstream response size and request time', async context => {
  const large = await start({ maxResponseBytes: 10, fetchImpl: async () => Response.json({ data: 'response too large' }) }, context);
  assert.equal((await post(large + '/api/entur/vehicles', vehicles)).status, 502);
  const slow = await start({ timeoutMs: 10, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) }, context);
  assert.equal((await post(slow + '/api/entur/vehicles', vehicles)).status, 504);
});