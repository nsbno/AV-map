const byId = id => document.getElementById(id);
const ROAD_TYPES = {
  speed: { id: 105, name: 'Fartsgrenser', color: '#468c58' },
  signal: { id: 89, name: 'Lyskryss', color: '#b23a48' },
  crossing: { id: 174, name: 'Gangfelt', color: '#147d92' },
  junction: { id: 37, name: 'Vegkryss og rundkjøringer', color: '#7d59a0' },
  width: { id: 838, name: 'Vegbredde, beregnet', color: '#bb681e' },
  tunnel: { id: 69, name: 'Tunnelportaler', color: '#555f63' },
  parking: { id: 43, name: 'Parkeringsområder', color: '#a27422' },
  interchange: { id: 42, name: 'Kollektivknutepunkter', color: '#8d4779' },
  direction: { id: 977, name: 'Kjøreretningsregulering', color: '#386538' },
  traffic: { id: 540, name: 'Trafikkmengde · ÅDT', color: '#9b7130' },
  accidents: { id: 570, name: 'Trafikkulykker · snitt per år', color: '#b13543' }
};
const ACCIDENT_PERIOD = { start: '2016-01-01', end: '2025-12-31', years: 10 };
const COMPLEXITY_COLORS = { high: '#b13543', normal: '#d28a2f', low: '#08775e' };
const COMPLEXITY_FACTORS = [
  { key: 'speed', label: 'Fartsgrense · OSM', group: 'neutral' },
  { key: 'junctions', label: 'Vegkryss · OSM', group: 'increase' },
  { key: 'crossings', label: 'Gangfelt · OSM', group: 'increase' },
  { key: 'tram', label: 'Trikkespor i vegbanen · OSM', group: 'increase' },
  { key: 'tunnel', label: 'Tunnel · OSM', group: 'increase' },
  { key: 'cycleLane', label: 'Sykkelfelt i kjørebanen · OSM', group: 'increase' },
  { key: 'signals', label: 'Lyskryss · OSM', group: 'reduce' },
  { key: 'structured', label: 'Adskilt veg', group: 'reduce' },
  { key: 'cycleway', label: 'Egen sykkelvei · OSM', group: 'reduce' }
];
const COMPLEXITY_FACTOR_COLORS = {
  speed: '#718087', junctions: '#c4553c', crossings: '#d2783a', tram: '#832c46', tunnel: '#3d1725',
  cycleLane: '#c48a2d', signals: '#08775e', structured: '#1b8873', cycleway: '#36a18b'
};
const SPEED_COLORS = { 30: '#338f57', 40: '#7e9f23', 50: '#b19b13', 60: '#d27d26', 70: '#cf5927', 80: '#be3445', 90: '#923043', 100: '#72283a', 110: '#541e30' };
const WAYMO_CSV_FILE = 'CSV4 - Miles and Benchmark Crashes for Dynamic Benchmark 202009-202606-2022benchmark_v2.csv';
function loadComplexityWeights() {
  try {
    const weights = JSON.parse(localStorage.getItem('av-complexity-weights') || '{}');
    return weights && typeof weights === 'object' && !Array.isArray(weights) ? weights : {};
  } catch { return {}; }
}
const app = {
  ready: false, engine: null, drawings: new Map(), selectedId: null, scopeId: null, scopeKey: null, waypointMode: false, waypoints: [],
  routeToken: 0, routing: false, roads: new Map(), enabledRoads: new Set(), cache: new Map(), requests: new Map(),
  live: { stops: false, vehicles: false }, complexityEnabled: false, complexityFactors: new Set(), complexityPriority: null, complexityFeatures: [], complexityDatasets: null, complexitySnapshotKey: null, complexitySummary: '', speedCategories: new Set(), speedCategoryOptions: new Set(), speedCategorySelectionInitialized: false, complexitySpeedCategories: new Set(), complexitySpeedCategoryOptions: new Set(), complexitySpeedCategorySelectionInitialized: false, stops: [], lines: new Map(), vehicles: [], lineToken: 0, waymoCells: [], waymoCoverage: null, waymoVisible: false, waymoCellDetailsVisible: false, waymoS2Promise: null, waymoCellsButton: null, waymoOsmRequest: null
};
app.store = new AvLocalStore();
app.motion = new AvTransitMotion();
globalThis.avApp = app;
app.complexityWeights = loadComplexityWeights();
let toastTimer;
let viewportTimer;
let waymoOsmTimer;

function icons() { if (globalThis.lucide) lucide.createIcons(); }

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function iconButton(name, label, callback) {
  const button = element('button', undefined, 'icon');
  button.title = label;
  button.setAttribute('aria-label', label);
  const icon = document.createElement('i');
  icon.dataset.lucide = name;
  button.append(icon);
  button.onclick = callback;
  return button;
}

function toast(message) {
  byId('toast').textContent = message;
  byId('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => byId('toast').classList.remove('show'), 4500);
}

function setStatus(id, text) { byId(id).textContent = text; }

function setTab(tab) {
  if (tab === 'analysis') byId('drawings').scrollIntoView({ block: 'nearest' });
}

function stopRequest(key) {
  app.requests.get(key)?.abort();
  app.requests.delete(key);
}

function dataApiURL(url) {
  const target = new URL(url, location.href);
  if (location.protocol === 'file:') return target.href;
  let path;
  if (target.origin === 'https://api.entur.io' && target.pathname === '/journey-planner/v3/graphql') path = '/api/entur/journey-planner';
  else if (target.origin === 'https://api.entur.io' && target.pathname === '/realtime/v2/vehicles/graphql') path = '/api/entur/vehicles';
  else if (target.origin === 'https://nvdbapiles.atlas.vegvesen.no' && /^\/vegobjekter\/api\/v4\/vegobjekter\/\d+$/.test(target.pathname)) path = '/api/nvdb/objects/' + target.pathname.split('/').at(-1);
  else if (target.origin === 'https://api.openstreetmap.org' && target.pathname === '/api/0.6/map') path = '/api/osm/map';
  else if (target.origin === 'https://ws.geonorge.no' && target.pathname === '/adresser/v1/sok') path = '/api/geonorge/addresses';
  else if (target.origin === 'https://router.project-osrm.org' && target.pathname.startsWith('/route/v1/driving/')) path = '/api/osrm/route/' + target.pathname.slice('/route/v1/driving/'.length);
  else throw new Error('Datatjenesten er ikke tillatt gjennom backend.');
  return path + target.search;
}

async function requestJSON(url, options = {}, signal) {
  const headers = new Headers(options.headers);
  if (location.protocol !== 'file:') { headers.delete('ET-Client-Name'); headers.delete('X-Client'); }
  const response = await fetch(dataApiURL(url), { ...options, headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
  if (!response.ok) {
    const details = await response.json().catch(() => null);
    throw new Error(details?.error || 'HTTP ' + response.status);
  }
  return response.json();
}

let osmRequestQueue = Promise.resolve();
let osmNextRequestAt = 0;
let osmCooldownUntil = 0;

function waitForOsm(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Avbrutt', 'AbortError'));
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(signal.reason || new DOMException('Avbrutt', 'AbortError')); };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function requestText(url, signal) {
  const previous = osmRequestQueue;
  let release;
  osmRequestQueue = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    if (Date.now() < osmCooldownUntil) {
      const remainingSeconds = Math.ceil((osmCooldownUntil - Date.now()) / 1000);
      throw new Error('HTTP 509: OpenStreetMap paused requests. Try again in ' + remainingSeconds + ' seconds.');
    }
    await waitForOsm(Math.max(0, osmNextRequestAt - Date.now()), signal);
    try {
      const target = new URL(url);
      const isOsmProxy = target.origin === 'https://api.openstreetmap.org'
        && target.pathname === '/api/0.6/map' && location.protocol !== 'file:';
      const headers = { Accept: 'application/xml' };
      const options = { headers };
      if (isOsmProxy) {
        headers['Content-Type'] = 'application/json';
        options.method = 'POST';
        options.body = JSON.stringify({ bbox: target.searchParams.get('bbox') });
      }
      const apiURL = isOsmProxy ? dataApiURL(target.origin + target.pathname) : dataApiURL(url);
      const requestTimeout = 10000;
      const response = await fetch(apiURL, {
        ...options,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)]) : AbortSignal.timeout(requestTimeout)
      });
      if (!response.ok) {
        const details = await response.text().catch(() => '');
        if ([429, 509].includes(response.status)) {
          const retryHeader = Number(response.headers.get('Retry-After'));
          const retryBody = Number(details.match(/try again in (\d+)\s*seconds?/i)?.[1]);
          const cooldownSeconds = retryHeader > 0 ? retryHeader : retryBody > 0 ? retryBody : 60;
          osmCooldownUntil = Math.max(osmCooldownUntil, Date.now() + cooldownSeconds * 1000);
        }
        throw new Error('HTTP ' + response.status + (details ? ': ' + details.slice(0, 180) : ''));
      }
      return await response.text();
    } finally {
      osmNextRequestAt = Date.now() + 500;
    }
  } finally { release(); }
}

async function graphql(query, signal, realtime = false) {
  const data = await requestJSON(realtime ? 'https://api.entur.io/realtime/v2/vehicles/graphql' : 'https://api.entur.io/journey-planner/v3/graphql', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'ET-Client-Name': 'vy-av-analysis', Accept: 'application/json' }, body: JSON.stringify({ query })
  }, signal);
  if (data.errors?.length) throw new Error(data.errors.map(error => error.message).join('; '));
  return data.data;
}

async function storedData(key, maxAge, load, signal) {
  const cached = Date.now() < app.bypassCacheUntil ? null : await app.store.get(key, maxAge);
  if (signal?.aborted) throw new DOMException('Avbrutt', 'AbortError');
  if (cached !== null) return cached;
  const value = await load();
  if (signal?.aborted) throw new DOMException('Avbrutt', 'AbortError');
  await app.store.set(key, value);
  return value;
}

function viewportBox() {
  const bounds = app.engine.map.getBounds();
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
}

function activeScope() {
  const item = app.drawings.get(app.scopeId);
  if (!item) return null;
  return ['Polygon', 'MultiPolygon'].includes(item.feature.geometry.type) ? item.feature : turf.buffer(item.feature, 0.05);
}

function dataBox() {
  const scope = activeScope();
  return scope ? turf.bbox(scope) : viewportBox();
}

function insideScope(coordinates, scope = activeScope()) {
  return !scope || turf.booleanPointInPolygon(turf.point(coordinates), scope);
}

function clipFeatures(features, scope = activeScope()) {
  if (!scope) return features;
  return features.flatMap(feature => turf.flatten(feature).features.flatMap(part => {
    if (!turf.booleanIntersects(part, scope)) return [];
    if (part.geometry.type === 'Point') return insideScope(part.geometry.coordinates, scope) ? [part] : [];
    if (part.geometry.type === 'Polygon') {
      const intersection = turf.intersect(part, scope);
      return intersection ? [{ ...intersection, properties: { ...feature.properties } }] : [];
    }
    if (part.geometry.type === 'LineString') {
      const split = turf.lineSplit(part, scope).features;
      return (split.length ? split : [part]).filter(line => insideScope(turf.along(line, turf.length(line) / 2).geometry.coordinates, scope))
        .map(line => ({ ...line, properties: { ...feature.properties } }));
    }
    return [];
  }));
}

function syncDataScope() {
  const scope = activeScope();
  if (scope) app.engine.setGeoJSON('data-scope', [scope], '#12826c');
  else app.engine.clear('data-scope');
  ['stops', 'vehicles', 'departures', 'line', 'road-complexity', ...Object.keys(ROAD_TYPES).map(type => 'road:' + type)].forEach(stopRequest);
  app.lineToken++;
  app.stops = []; app.vehicles = []; app.lines.clear();
  app.motion.update([]);
  app.vehicleSignature = null;
  app.vehicleSnapshotKey = null;
  app.roads.clear();
  app.complexityFeatures = []; app.complexityDatasets = null; app.complexitySnapshotKey = null; app.complexitySummary = '';
  app.engine.setVehicleModels([]);
  ['stops', 'vehicles', 'vehicle-points', 'transit-line', 'road-complexity', 'road-accidents-grid', 'road-accidents-points', ...COMPLEXITY_FACTORS.map(({ key }) => 'complexity-factor-' + key), ...Object.keys(ROAD_TYPES).filter(type => type !== 'accidents').map(type => 'road-' + type)].forEach(id => {
    if (app.engine.map.getSource(id)) app.engine.map.getSource(id).setData({ type: 'FeatureCollection', features: [] });
    app.engine.visible(id, false);
  });
  app.engine.visible('road-complexity', false);
  setStatus('roadComplexityStatus', app.complexityEnabled ? 'Oppdater område' : 'av');
  app.drawings.forEach(item => {
    if (app.engine.map.getSource('route-speed-' + item.id)) app.engine.setGeoJSON('route-speed-' + item.id, clipFeatures((item.highlights || []).filter(feature => (item.visibleSpeeds || []).includes(String(feature.properties.speed)))));
  });
  if (app.engine.activePopup) app.engine.activePopup.remove();
  byId('inspector').hidden = true;
  renderEnturLines();
  app.lastViewportKey = null;
  refreshViewport();
}

function boxArea(box) { return turf.area(turf.bboxPolygon(box)) / 1000000; }

function nvdbGeometry(wkt) {
  if (!wkt) return null;
  const clean = wkt.replace(/^SRID=\d+;/i, '').trim();
  const type = clean.split(/[ (]/)[0].toUpperCase();
  const coordinates = group => (group.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s+-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:\s+-?\d+(?:\.\d+)?)?/g) || []).map(pair => {
    const values = pair.trim().split(/\s+/).map(Number);
    return values[0] > 50 && values[1] < 40 ? [values[1], values[0]] : values.slice(0, 2);
  });
  if (type === 'POINT') return { type: 'Point', coordinates: coordinates(clean)[0] };
  if (type === 'LINESTRING') return { type: 'LineString', coordinates: coordinates(clean) };
  const groups = clean.match(/\([^()]+\)/g) || [];
  if (type === 'MULTILINESTRING') return { type: 'MultiLineString', coordinates: groups.map(coordinates) };
  if (type === 'POLYGON') return { type: 'Polygon', coordinates: groups.map(coordinates) };
  return null;
}

function nvdbElevationProfiles(wkt) {
  if (!wkt || !/LINESTRING\s+Z\b/i.test(wkt.trim())) return [];
  const clean = wkt.trim();
  const type = clean.split(/[ (]/)[0].toUpperCase();
  const groups = type === 'MULTILINESTRING' ? clean.match(/\([^()]+\)/g) || [] : [clean.slice(clean.indexOf('(') + 1, clean.lastIndexOf(')'))];
  return groups.map(group => {
    const coordinates = (group.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s+-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\s+-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) || []).map(tuple => {
      const values = tuple.trim().split(/\s+/).map(Number);
      return { point: values[0] > 50 && values[1] < 40 ? [values[1], values[0]] : values.slice(0, 2), elevation: values[2] };
    });
    let distanceKm = 0;
    return coordinates.flatMap((entry, index) => {
      if (index) distanceKm += turf.distance(turf.point(coordinates[index - 1].point), turf.point(entry.point));
      return Number.isFinite(entry.elevation) ? [[distanceKm, entry.elevation]] : [];
    });
  });
}

function nvdbFeature(object, includeElevation = false) {
  const geometry = nvdbGeometry(object.geometri?.wkt);
  if (!geometry) return null;
  const properties = { nvdb_id: object.id };
  (object.egenskaper || []).forEach(property => { properties[property.navn] = property.verdi ?? property.enumverdi ?? property.enum_id; });
  if (includeElevation) properties._elevationProfiles = nvdbElevationProfiles(object.geometri?.wkt);
  return { type: 'Feature', geometry, properties };
}

function loadedOsmTramTrackFeatures(box) {
  const bounds = turf.bboxPolygon(box), features = new Map();
  app.engine.map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' })
    .filter(feature => feature.properties.class === 'transit' && feature.properties.subclass === 'tram'
      && ['LineString', 'MultiLineString'].includes(feature.geometry.type))
    .filter(feature => turf.booleanIntersects(feature, bounds))
    .forEach(feature => features.set(feature.id || JSON.stringify(feature.geometry.coordinates), {
      type: 'Feature', id: feature.id, geometry: feature.geometry,
      properties: { ...feature.properties, osm_id: feature.id, railway: 'tram' }
    }));
  return [...features.values()];
}

function loadedOsmCyclewayFeatures(box) {
  const bounds = turf.bboxPolygon(box), features = new Map();
  app.engine.map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' })
    .filter(feature => feature.properties.class === 'path'
      && (feature.properties.subclass === 'cycleway'
        || feature.properties.subclass === 'path' && feature.properties.bicycle === 'designated')
      && ['LineString', 'MultiLineString'].includes(feature.geometry.type))
    .filter(feature => turf.booleanIntersects(feature, bounds))
    .forEach(feature => features.set(feature.id || JSON.stringify(feature.geometry.coordinates), {
      type: 'Feature', id: feature.id, geometry: feature.geometry,
      properties: { ...feature.properties, osm_id: feature.id, cycleType: 'Sykkelfelt i sykkelveg', source: 'OSM' }
    }));
  return [...features.values()];
}

function osmCyclewayCategories(tags) {
  if (tags.bicycle === 'no' || tags.access === 'no') return { lane: false, separate: false };
  const values = [tags.cycleway, tags['cycleway:left'], tags['cycleway:right'], tags['cycleway:both'], tags['cycleway:forward'], tags['cycleway:backward'], ...(tags['cycleway:lanes'] || '').split('|')]
    .map(value => String(value || '').toLocaleLowerCase('en'));
  return {
    lane: values.some(value => ['lane', 'shared_lane'].includes(value)),
    separate: tags.highway === 'cycleway' || tags.highway === 'path' && tags.bicycle === 'designated' || values.includes('track')
  };
}

function osmSpeedKph(tags) {
  const values = [tags.maxspeed, tags['maxspeed:forward'], tags['maxspeed:backward']].map(value => {
    const match = String(value || '').trim().match(/^(\d+(?:[.,]\d+)?)\s*(mph|km\/h|kph)?$/i);
    if (!match) return null;
    const speed = Number(match[1].replace(',', '.'));
    return Number.isFinite(speed) ? speed * (/^mph$/i.test(match[2] || '') ? 1.60934 : 1) : null;
  }).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function parseOsmMapFeatures(xml) {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('Ugyldig OSM XML.');
  const remark = document.getElementsByTagName('remark')[0]?.textContent.trim();
  if (remark) throw new Error('OSM: ' + remark.slice(0, 180));
  const nodes = new Map([...document.getElementsByTagName('node')].map(node => [node.getAttribute('id'), {
    coordinates: [Number(node.getAttribute('lon')), Number(node.getAttribute('lat'))],
    tags: Object.fromEntries([...node.getElementsByTagName('tag')].map(tag => [tag.getAttribute('k'), tag.getAttribute('v')]))
  }]));
  const nodeCoordinates = new Map([...nodes].map(([id, node]) => [id, node.coordinates]));
  const output = { tram: [], cycleLane: [], cycleway: [], roads: [], junctions: [], signals: [], crossings: [] };
  const roadNodes = new Map();
  const roadClasses = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'road', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
  const addRoadNeighbor = (nodeId, neighborId) => {
    if (!roadNodes.has(nodeId)) roadNodes.set(nodeId, new Set());
    roadNodes.get(nodeId).add(neighborId);
  };
  [...document.getElementsByTagName('way')].forEach(way => {
    const tags = Object.fromEntries([...way.getElementsByTagName('tag')].map(tag => [tag.getAttribute('k'), tag.getAttribute('v')]));
    const nds = [...way.getElementsByTagName('nd')];
    const refs = nds.map(node => node.getAttribute('ref'));
    const coordinates = nds.map(node => {
      const ref = node.getAttribute('ref');
      const coordinates = nodeCoordinates.get(ref) || (node.hasAttribute('lon') && node.hasAttribute('lat')
        ? [Number(node.getAttribute('lon')), Number(node.getAttribute('lat'))] : null);
      if (coordinates) nodeCoordinates.set(ref, coordinates);
      return coordinates;
    }).filter(Boolean);
    if (coordinates.length < 2) return;
    const id = way.getAttribute('id');
    if (tags.railway === 'tram') output.tram.push(turf.lineString(coordinates, { osm_id: id, railway: 'tram', source: 'OSM' }));
    if (roadClasses.has(tags.highway)) {
      const tunnel = tags.tunnel && !['no', 'false', '0'].includes(tags.tunnel) ? tags.tunnel : null;
      const roadTags = Object.fromEntries(Object.entries(tags).filter(([key]) =>
        !['width:carriageway', 'width', 'est_width', 'incline'].includes(key) && !key.startsWith('lanes')
      ));
      output.roads.push(turf.lineString(coordinates, {
        ...roadTags, osm_id: id, roadClass: tags.highway, osm_speed_kph: osmSpeedKph(tags),
        osm_tunnel: tunnel, source: 'OSM'
      }));
      refs.forEach((ref, index) => {
        if (index > 0) addRoadNeighbor(ref, refs[index - 1]);
        if (index < refs.length - 1) addRoadNeighbor(ref, refs[index + 1]);
      });
      if (['roundabout', 'circular'].includes(tags.junction)) {
        const midpoint = turf.along(turf.lineString(coordinates), turf.length(turf.lineString(coordinates)) / 2);
        output.junctions.push(turf.point(midpoint.geometry.coordinates, { osm_id: id, junction: tags.junction, source: 'OSM' }));
      }
    }
    const categories = osmCyclewayCategories(tags);
    const common = { osm_id: id, source: 'OSM', highway: tags.highway, bicycle: tags.bicycle, cycleway: tags.cycleway };
    if (categories.lane) output.cycleLane.push(turf.lineString(coordinates, { ...common, cycleType: 'Sykkelfelt i bilveg', Type: 'Sykkelfelt i bilveg' }));
    if (categories.separate) output.cycleway.push(turf.lineString(coordinates, { ...common, cycleType: 'Sykkelfelt i sykkelveg', Type: 'Sykkelfelt i sykkelveg' }));
    if (tags.footway === 'crossing' || tags.cycleway === 'crossing') output.crossings.push(turf.lineString(coordinates, { osm_id: id, crossing: 'way', source: 'OSM' }));
  });
  nodeCoordinates.forEach((coordinates, id) => {
    const tags = nodes.get(id)?.tags || {};
    const crossingType = tags.crossing || tags['crossing:both'] || tags['crossing:left'] || tags['crossing:right'];
    const signalizedCrossing = crossingType === 'traffic_signals' || tags['crossing:signals'] === 'yes';
    if (tags.highway === 'traffic_signals' || signalizedCrossing) output.signals.push(turf.point(coordinates, { osm_id: id, highway: tags.highway, crossing: crossingType, source: 'OSM' }));
    if (tags.highway === 'crossing' || tags.footway === 'crossing' || crossingType && crossingType !== 'no') output.crossings.push(turf.point(coordinates, { osm_id: id, crossing: crossingType || 'crossing', signalized: signalizedCrossing, source: 'OSM' }));
    if (tags.highway === 'mini_roundabout') output.junctions.push(turf.point(coordinates, { osm_id: id, junction: 'mini_roundabout', source: 'OSM' }));
    if ((roadNodes.get(id)?.size || 0) >= 3) output.junctions.push(turf.point(coordinates, { osm_id: id, junction: 'road_intersection', source: 'OSM' }));
  });
  return output;
}

async function loadOsmMapFeatures(box, signal, scope = null, onProgress = null) {
  const features = { tram: new Map(), cycleLane: new Map(), cycleway: new Map(), roads: new Map(), junctions: new Map(), signals: new Map(), crossings: new Map() };
  let failedTiles = 0;
  let firstError = null;
  let cooldownSeconds = 0;
  const loadedBoxes = [], failedBoxes = [];
  let tiles;
  try { tiles = splitBox(box, 0.0599, Number.POSITIVE_INFINITY); }
  catch {
    toast('OSM: området er for stort for detaljuttak; bruker tilgjengelige karttiles.');
    const tram = loadedOsmTramTrackFeatures(box), cycleway = loadedOsmCyclewayFeatures(box);
    return {
      tram: scope ? clipFeatures(tram, scope) : tram, cycleLane: [],
      cycleway: scope ? clipFeatures(cycleway, scope) : cycleway,
      roads: [], junctions: [], signals: [], crossings: [], osmTileCount: 0, osmFailedTiles: 1
    };
  }
  const fetchTile = async (tile, depth = 0) => {
    const tileScope = scope ? turf.intersect(scope, turf.bboxPolygon(tile)) : null;
    if (scope && !tileScope) return null;
    const cacheKey = 'osm-map:' + (scope ? JSON.stringify(scope.geometry) + ':' : '') + tile.map(value => value.toFixed(5)).join(',');
    const cached = app.cache.get(cacheKey);
    if (cached?.failed && Date.now() - cached.at < 300000) { failedTiles++; failedBoxes.push(tile); firstError ||= cached.error || 'Tidligere OSM-flisfeil'; return null; }
    if (cached && Date.now() >= (app.bypassCacheUntil || 0) && Date.now() - cached.at < 86400000) { loadedBoxes.push(tile); return cached.features; }
    const saved = Date.now() >= (app.bypassCacheUntil || 0) ? await app.store.get(cacheKey, 86400000) : null;
    if (signal?.aborted) throw new DOMException('Avbrutt', 'AbortError');
    if (saved) {
      app.cache.set(cacheKey, { at: Date.now(), features: saved });
      loadedBoxes.push(tile);
      return saved;
    }
    try {
      const url = new URL('https://api.openstreetmap.org/api/0.6/map');
      url.searchParams.set('bbox', tile.join(','));
      const parsed = parseOsmMapFeatures(await requestText(url.href, signal));
      if (scope) Object.keys(parsed).forEach(key => { parsed[key] = clipFeatures(parsed[key], scope); });
      app.cache.set(cacheKey, { at: Date.now(), features: parsed });
      await app.store.set(cacheKey, parsed);
      loadedBoxes.push(tile);
      return parsed;
    } catch (error) {
      if (signal?.aborted) throw error;
      const tileSpan = Math.max(tile[2] - tile[0], tile[3] - tile[1]);
      if (tileSpan > OSM_MIN_TILE_SPAN && /HTTP (400|504)|timed?\s*out|timeout/i.test(error.message) && /too many nodes|timed?\s*out|timeout/i.test(error.message)) {
        const subtiles = splitBox(tile, tileSpan / 2, Number.POSITIVE_INFINITY);
        if (subtiles.length > 1) {
          onProgress?.(completedTiles, tiles.length, { splitting: true });
          const children = await pool(subtiles, 1, subtile => fetchTile(subtile, depth + 1));
          return Object.fromEntries(Object.keys(features).map(key => {
            const unique = new Map();
            children.filter(Boolean).flatMap(child => child[key] || []).forEach(feature => unique.set(String(feature.properties.osm_id), feature));
            return [key, [...unique.values()]];
          }));
        }
      }
      failedTiles++;
      failedBoxes.push(tile);
      firstError ||= error.message;
      if (/HTTP (429|509)/.test(error.message)) {
        cooldownSeconds = Math.max(cooldownSeconds, Math.ceil((osmCooldownUntil - Date.now()) / 1000));
        onProgress?.(completedTiles, tiles.length, { cooldownSeconds });
      } else app.cache.set(cacheKey, { at: Date.now(), failed: true, features: null, error: error.message });
      return null;
    }
  };
  let completedTiles = 0;
  onProgress?.(completedTiles, tiles.length);
  const tileResults = await pool(tiles, 2, async tile => {
    const result = await fetchTile(tile);
    completedTiles++;
    onProgress?.(completedTiles, tiles.length, cooldownSeconds ? { cooldownSeconds } : null);
    return result;
  });
  for (const result of tileResults) {
    if (!result) continue;
    for (const key of Object.keys(features)) result[key].forEach(feature => features[key].set(String(feature.properties.osm_id), feature));
  }
  const output = Object.fromEntries(Object.entries(features).map(([key, values]) => [key, [...values.values()]]));
  output.osmTileCount = loadedBoxes.length + failedBoxes.length;
  output.osmFailedTiles = failedTiles;
  output.osmCooldownSeconds = cooldownSeconds;
  output.osmLoadedBoxes = loadedBoxes;
  output.osmFailedBoxes = failedBoxes;
  const tileFallback = { tram: loadedOsmTramTrackFeatures(box), cycleway: loadedOsmCyclewayFeatures(box) };
  for (const key of ['tram', 'cycleway']) {
    const unique = new Map(output[key].map(feature => [String(feature.properties.osm_id || feature.id || JSON.stringify(feature.geometry.coordinates)), feature]));
    const fallbackFeatures = scope ? clipFeatures(tileFallback[key], scope) : tileFallback[key];
    fallbackFeatures.forEach(feature => unique.set(String(feature.properties.osm_id || feature.id || JSON.stringify(feature.geometry.coordinates)), feature));
    output[key] = [...unique.values()];
  }
  if (failedTiles) toast('OSM: ' + failedTiles + ' av ' + tiles.length + ' fliser kunne ikke leses; første feil: ' + firstError + '. Bruker karttiles der mulig.');
  return output;
}

function speedValue(properties) {
  const entry = Object.entries(properties).find(([name]) => /fartsgrense/i.test(name));
  const speed = Number(entry?.[1]);
  return speed > 0 && speed <= 130 ? speed : 0;
}

const OSM_MIN_TILE_SPAN = 0.00025;

function splitBox(box, maxSpan = 0.06, maxTiles = 30) {
  const columns = Math.max(1, Math.ceil(Math.max(0, box[2] - box[0] - 1e-10) / maxSpan));
  const rows = Math.max(1, Math.ceil(Math.max(0, box[3] - box[1] - 1e-10) / maxSpan));
  if (columns * rows > maxTiles) throw new Error('Området er for stort. Zoom inn eller bruk en kortere rute.');
  const boxes = [];
  for (let column = 0; column < columns; column++) {
    for (let row = 0; row < rows; row++) {
      boxes.push([box[0] + column * (box[2] - box[0]) / columns, box[1] + row * (box[3] - box[1]) / rows,
        box[0] + (column + 1) * (box[2] - box[0]) / columns, box[1] + (row + 1) * (box[3] - box[1]) / rows]);
    }
  }
  return boxes;
}

async function pool(items, limit, task) {
  let next = 0;
  const output = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; output[index] = await task(items[index], index); }
  }));
  return output;
}

async function nvdbObjects(type, box, signal, includeElevation = false) {
  const cacheKey = 'nvdb:' + type + (includeElevation ? ':elevation-v2' : '') + ':' + box.map(value => value.toFixed(5)).join(',');
  const cached = app.cache.get(cacheKey);
  if (cached && Date.now() >= (app.bypassCacheUntil || 0) && Date.now() - cached.at < 86400000) return cached.features;
  const saved = Date.now() < app.bypassCacheUntil ? null : await app.store.get(cacheKey, 86400000);
  if (signal?.aborted) throw new DOMException('Avbrutt', 'AbortError');
  if (saved) { app.cache.set(cacheKey, { at: Date.now(), features: saved }); return saved; }
  const query = new URLSearchParams({ kartutsnitt: box.join(','), antall: '2000', inkluder: 'geometri,egenskaper', srid: '4326', inkluderAntall: 'false' });
  if (type === 570) {
    query.append('egenskap', '5055>=' + ACCIDENT_PERIOD.start);
    query.append('egenskap', '5055<=' + ACCIDENT_PERIOD.end);
  }
  let url = 'https://nvdbapiles.atlas.vegvesen.no/vegobjekter/api/v4/vegobjekter/' + type + '?' + query;
  const endpoint = url;
  const objects = new Map();
  const starts = new Set();
  for (let page = 0; url; page++) {
    if (page >= 12) {
      const error = new Error('sidegrensen ble nådd');
      error.code = 'NVDB_TILE_LIMIT';
      throw error;
    }
    const result = await requestJSON(url, { headers: { Accept: 'application/json', 'X-Client': 'Vy-AV-Analysis' } }, signal);
    const batch = result.objekter || [];
    if (!batch.length) break;
    batch.forEach(object => objects.set(object.id, object));
    if (objects.size > 18000) {
      const error = new Error('objektgrensen ble nådd');
      error.code = 'NVDB_TILE_LIMIT';
      throw error;
    }
    const start = result.metadata?.neste?.start;
    if (!start) break;
    if (starts.has(start)) throw new Error('NVDB gjentok samme side. Prøv igjen.');
    starts.add(start);
    const next = new URL(endpoint);
    next.searchParams.set('start', start);
    url = next.href;
  }
  const features = [...objects.values()].map(object => nvdbFeature(object, includeElevation)).filter(Boolean);
  app.cache.set(cacheKey, { at: Date.now(), features });
  await app.store.set(cacheKey, features);
  if (app.cache.size > 100) app.cache.delete(app.cache.keys().next().value);
  return features;
}

async function nvdbForBox(type, box, signal, includeElevation = false) {
  const maxSplitDepth = type === 838 ? 2 : 0;
  const formatBox = tile => tile.map(value => value.toFixed(5)).join(',');
  const fetchTile = async (tile, depth = 0) => {
    try {
      return await nvdbObjects(type, tile, signal, includeElevation);
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      if (error.code !== 'NVDB_TILE_LIMIT' || depth >= maxSplitDepth) {
        throw new Error('NVDB type ' + type + ' · område ' + formatBox(tile) + ': ' + (error.code === 'NVDB_TILE_LIMIT'
          ? 'for mye data. Velg et mindre område.' : error.message));
      }
      const subtiles = splitBox(tile, 0.03 / 2 ** depth);
      if (subtiles.length <= 1) throw new Error('NVDB type ' + type + ' · område ' + formatBox(tile) + ': for mye data. Velg et mindre område.');
      return (await pool(subtiles, 1, subtile => fetchTile(subtile, depth + 1))).flat();
    }
  };
  let tiles;
  try { tiles = splitBox(box); }
  catch (error) { throw new Error('NVDB type ' + type + ': ' + error.message); }
  const results = await pool(tiles, 3, tile => fetchTile(tile));
  const unique = new Map();
  results.flat().forEach(feature => unique.set(feature.properties.nvdb_id, feature));
  return [...unique.values()];
}

function renderRoadControls() {
  Object.entries(ROAD_TYPES).forEach(([key, definition]) => {
    const label = element('label', undefined, 'layer');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.road = key;
    input.onchange = () => {
      if (key === 'speed') byId('speedCategories').hidden = !input.checked;
      if (input.checked) { app.enabledRoads.add(key); loadRoad(key); }
      else {
        app.enabledRoads.delete(key); stopRequest('road:' + key);
        if (key === 'accidents') ['road-accidents-grid', 'road-accidents-points'].forEach(id => app.engine.visible(id, false));
        else app.engine.visible('road-' + key, false);
        setStatus('roadStatus-' + key, 'av');
      }
    };
    const swatch = element('span', undefined, 'swatch');
    swatch.style.background = definition.color;
    const status = element('span', 'av', 'count');
    status.id = 'roadStatus-' + key;
    label.append(input, swatch, element('span', definition.name, 'layername'), status);
    byId('roadLayers').append(label);
    if (key === 'speed') {
      const categories = element('div', undefined, 'speed-categories');
      categories.id = 'speedCategories'; categories.hidden = true;
      const list = element('div'); list.id = 'speedCategoryOptions';
      categories.append(list);
      byId('roadLayers').append(categories);
    }
  });
}

function speedCategoryKey(feature) {
  const speed = speedValue(feature.properties);
  return speed > 0 ? String(speed) : 'unknown';
}

function renderSpeedOverlay() {
  const features = (app.roads.get('speed') || []).filter(feature => app.speedCategories.has(speedCategoryKey(feature)));
  app.engine.setGeoJSON('road-speed', features, ROAD_TYPES.speed.color);
  app.engine.visible('road-speed', app.enabledRoads.has('speed'));
  if (app.enabledRoads.has('speed')) setStatus('roadStatus-speed', features.length.toLocaleString('nb-NO') + ' / ' + (app.roads.get('speed') || []).length.toLocaleString('nb-NO'));
}

function renderSpeedCategoryControls(features) {
  const counts = new Map();
  features.forEach(feature => {
    const key = speedCategoryKey(feature);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const categories = new Set(counts.keys());
  if (!app.speedCategorySelectionInitialized) {
    app.speedCategories = new Set(categories);
    app.speedCategorySelectionInitialized = true;
  } else {
    categories.forEach(key => { if (!app.speedCategoryOptions.has(key)) app.speedCategories.add(key); });
    app.speedCategories = new Set([...app.speedCategories].filter(key => categories.has(key)));
  }
  app.speedCategoryOptions = categories;
  const list = byId('speedCategoryOptions');
  list.replaceChildren();
  [...categories].sort((first, second) => first === 'unknown' ? 1 : second === 'unknown' ? -1 : Number(first) - Number(second)).forEach(key => {
    const speed = Number(key), label = element('label', undefined, 'layer');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = app.speedCategories.has(key);
    input.onchange = () => {
      if (input.checked) app.speedCategories.add(key);
      else app.speedCategories.delete(key);
      renderSpeedOverlay();
    };
    const swatch = element('span', undefined, 'swatch');
    swatch.style.background = Number.isFinite(speed) ? SPEED_COLORS[speed] || '#78857e' : '#78857e';
    label.append(input, swatch, element('span', key === 'unknown' ? 'Ukjent' : speed + ' km/t', 'layername'), element('span', counts.get(key).toLocaleString('nb-NO'), 'count'));
    list.append(label);
  });
}

function complexitySpeedCategoryKey(feature) {
  const speed = feature.properties.osm_speed_kph;
  return Number.isFinite(speed) ? speed.toFixed(1) : 'unknown';
}

function renderComplexitySpeedCategories(features) {
  const counts = new Map();
  features.forEach(feature => {
    const key = complexitySpeedCategoryKey(feature);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const categories = new Set(counts.keys());
  if (!app.complexitySpeedCategorySelectionInitialized) {
    app.complexitySpeedCategories = new Set(categories);
    app.complexitySpeedCategorySelectionInitialized = true;
  } else {
    categories.forEach(key => { if (!app.complexitySpeedCategoryOptions.has(key)) app.complexitySpeedCategories.add(key); });
    app.complexitySpeedCategories = new Set([...app.complexitySpeedCategories].filter(key => categories.has(key)));
  }
  app.complexitySpeedCategoryOptions = categories;
  const list = byId('complexitySpeedCategoryOptions');
  if (!list) return;
  list.replaceChildren();
  [...categories].sort((first, second) => first === 'unknown' ? 1 : second === 'unknown' ? -1 : Number(first) - Number(second)).forEach(key => {
    const speed = Number(key), label = element('label', undefined, 'layer');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = app.complexitySpeedCategories.has(key);
    input.onchange = () => {
      if (input.checked) app.complexitySpeedCategories.add(key);
      else app.complexitySpeedCategories.delete(key);
      renderComplexityFactorOverlays();
    };
    const swatch = element('span', undefined, 'swatch');
    swatch.style.background = Number.isFinite(speed) ? SPEED_COLORS[Math.round(speed)] || '#718087' : '#718087';
    const name = key === 'unknown' ? 'Ukjent' : Number(speed.toFixed(1)).toLocaleString('nb-NO', { maximumFractionDigits: 1 }) + ' km/t';
    label.append(input, swatch, element('span', name, 'layername'), element('span', counts.get(key).toLocaleString('nb-NO'), 'count'));
    list.append(label);
  });
}

function renderComplexityControls() {
  for (const [group, title] of [['increase', 'Øker kompleksiteten'], ['reduce', 'Reduserer kompleksiteten'], ['neutral', 'Nøytral påvirkning']]) {
    const section = element('div', undefined, 'complexity-factor-group');
    section.append(element('div', title, 'complexity-group-title'));
    COMPLEXITY_FACTORS.filter(factor => factor.group === group).forEach(({ key, label: name }) => {
      const label = element('label', undefined, 'layer');
      const input = document.createElement('input');
      input.type = 'checkbox'; input.checked = app.complexityFactors.has(key); input.dataset.complexityFactor = key;
      input.onchange = () => {
        if (input.checked) { app.complexityFactors.add(key); app.complexityPriority = key; }
        else {
          app.complexityFactors.delete(key);
          if (app.complexityPriority === key) app.complexityPriority = [...app.complexityFactors].at(-1) || null;
        }
        if (key === 'speed') {
          const categories = byId('complexitySpeedCategories');
          categories.hidden = !input.checked;
          if (input.checked) renderComplexitySpeedCategories(app.complexityDatasets?.roads || []);
        }
        renderComplexityFactorOverlays();
      };
      const swatch = element('span', undefined, 'swatch');
      swatch.style.background = COMPLEXITY_FACTOR_COLORS[key];
      label.append(input, swatch, element('span', name, 'layername'));
      const control = element('div', undefined, 'complexity-factor-control');
      control.append(label);
      if (group !== 'neutral') {
        const weightRow = element('label', undefined, 'complexity-weight');
        const slider = document.createElement('input');
        slider.type = 'range'; slider.min = '0'; slider.max = '200'; slider.step = '10';
        slider.value = String(Math.round(Math.max(0, Math.min(2, app.complexityWeights[key] ?? 1)) * 100));
        slider.setAttribute('aria-label', name + ' · påvirkning på kompleksitet');
        const weightValue = element('output', slider.value + '%', 'count');
        slider.oninput = () => {
          app.complexityWeights[key] = Number(slider.value) / 100;
          weightValue.value = slider.value + '%';
          weightValue.textContent = slider.value + '%';
          try { localStorage.setItem('av-complexity-weights', JSON.stringify(app.complexityWeights)); } catch {}
          if (app.complexityFeatures.length) renderComplexitySnapshot();
        };
        weightRow.append(element('span', 'Vekt'), slider, weightValue);
        control.append(weightRow);
      }
      section.append(control);
      if (key === 'speed') {
        const categories = element('div', undefined, 'speed-categories');
        categories.id = 'complexitySpeedCategories'; categories.hidden = !input.checked;
        const list = element('div'); list.id = 'complexitySpeedCategoryOptions';
        categories.append(list); section.append(categories);
        if (input.checked) renderComplexitySpeedCategories(app.complexityDatasets?.roads || []);
      }
    });
    byId('complexityFactorList').append(section);
  }
}

async function loadRoad(key) {
  if (!app.ready || !app.enabledRoads.has(key)) return;
  stopRequest('road:' + key);
  const box = dataBox();
  const minimumZoom = key === 'accidents' ? 11 : 13;
  if ((!activeScope() && app.engine.map.getZoom() < minimumZoom) || boxArea(box) > 90) {
    if (key === 'accidents') ['road-accidents-grid', 'road-accidents-points'].forEach(id => app.engine.visible(id, false));
    else app.engine.visible('road-' + key, false);
    setStatus('roadStatus-' + key, 'Zoom inn'); return;
  }
  const controller = new AbortController();
  app.requests.set('road:' + key, controller);
  setStatus('roadStatus-' + key, 'Henter …');
  try {
    const features = clipFeatures(await nvdbForBox(ROAD_TYPES[key].id, box, controller.signal));
    if (controller.signal.aborted || !app.enabledRoads.has(key)) return;
    if (key === 'accidents') {
      const accidents = features.filter(feature => feature.geometry.type === 'Point' && feature.properties.Ulykkesdato >= ACCIDENT_PERIOD.start && feature.properties.Ulykkesdato <= ACCIDENT_PERIOD.end);
      const cells = accidentGrid(accidents);
      app.engine.setGeoJSON('road-accidents-grid', cells, ROAD_TYPES[key].color, 'accident-grid');
      app.engine.setGeoJSON('road-accidents-points', accidents, ROAD_TYPES[key].color, 'accident-points');
      app.engine.visible('road-accidents-grid', true);
      app.engine.visible('road-accidents-points', true);
      app.engine.onFeature('road-accidents-grid', (feature, coordinates) => showProperties('Ulykkesfrekvens · 500 m rute', {
        'Ulykker 2016-2025': feature.properties.accidents,
        'Snitt per år': Number(feature.properties.annualAverage).toFixed(1)
      }, coordinates));
      app.engine.onFeature('road-accidents-points', (feature, coordinates) => {
        const properties = feature.properties;
        showProperties('Trafikkulykke', {
          'Dato': properties.Ulykkesdato,
          'Alvorlighetsgrad': properties.Alvorlighetsgrad,
          'Ulykkestype': properties['Ulykkestype (Ny)'] || properties.Ulykkeskode,
          'Fartsgrense': properties.Fartsgrense ? properties.Fartsgrense + ' km/t' : null,
          'Føreforhold': properties.Føreforhold
        }, coordinates);
      });
      setStatus('roadStatus-' + key, accidents.length.toLocaleString('nb-NO') + ' · ' + (accidents.length / ACCIDENT_PERIOD.years).toLocaleString('nb-NO', { maximumFractionDigits: 1 }) + '/år');
      return;
    }
    app.roads.set(key, features);
    if (key === 'speed') {
      features.forEach(feature => { feature.properties.color = SPEED_COLORS[speedValue(feature.properties)] || '#78857e'; });
      renderSpeedCategoryControls(features);
      renderSpeedOverlay();
    } else {
      app.engine.setGeoJSON('road-' + key, features, ROAD_TYPES[key].color);
      app.engine.visible('road-' + key, true);
    }
    app.engine.onFeature('road-' + key, (feature, coordinates) => showProperties(ROAD_TYPES[key].name, feature.properties, coordinates));
    if (key !== 'speed') setStatus('roadStatus-' + key, features.length.toLocaleString('nb-NO'));
  } catch (error) {
    if (!controller.signal.aborted) {
      if (key === 'accidents') ['road-accidents-grid', 'road-accidents-points'].forEach(id => app.engine.visible(id, false));
      else app.engine.visible('road-' + key, false);
      setStatus('roadStatus-' + key, 'Feil'); toast(ROAD_TYPES[key].name + ': ' + error.message);
    }
  }
}

function accidentGrid(accidents) {
  if (!accidents.length) return [];
  const bounds = turf.bbox(turf.featureCollection(accidents));
  const cells = turf.squareGrid(bounds, 0.5, { units: 'kilometers' }).features;
  return cells.flatMap(cell => {
    const count = accidents.reduce((total, point) => total + Number(turf.booleanPointInPolygon(point, cell)), 0);
    if (!count) return [];
    cell.properties = { accidents: count, annualAverage: count / ACCIDENT_PERIOD.years };
    return [cell];
  });
}

function roadComplexityScore(metrics, factors = new Set(['junctions', 'signals', 'crossings', 'tram', 'tunnel', 'cycleLane', 'cycleway', 'structured']), weights = {}) {
  const enabled = key => factors.has(key);
  const factorWeight = key => Math.max(0, Math.min(2, Number.isFinite(weights[key]) ? weights[key] : 1));
  const junctions = enabled('junctions') ? metrics.junctions : 0;
  const crossings = enabled('crossings') ? metrics.crossings : 0;
  const signals = enabled('signals') ? metrics.signals : 0;
  const tram = enabled('tram') && metrics.tramTrackInRoad;
  const tunnelLength = enabled('tunnel') ? metrics.tunnelLength || 0 : 0;
  const cycleType = enabled('cycleLane') || enabled('cycleway') ? metrics.cycleType : null;
  const separated = enabled('structured') && metrics.separated;
  const structuredWeight = enabled('structured') ? factorWeight('structured') : 0;
  let score = 0;
  const reasons = [];
  const addImpact = (key, contribution, reason) => {
    const impact = contribution * factorWeight(key);
    if (!impact) return;
    score += impact;
    reasons.push(reason);
  };
  const signalWithin10m = enabled('signals') && metrics.signalsWithin10m > 0;
  const structuredForCategory = separated && structuredWeight >= 1;
  if (junctions) addImpact('junctions', Math.min(3, junctions), 'Vegkryss/rundkjøring · OSM');
  if (crossings && !signalWithin10m) addImpact('crossings', Math.min(4, crossings * 2), 'Gangfelt uten lyssignal i nærheten');
  if (signalWithin10m) addImpact('signals', -1, 'Lyssignal innen 10 m · OSM');
  if (enabled('cycleway') && cycleType === 'Sykkelfelt i sykkelveg') addImpact('cycleway', -3, 'Sykkelfelt i sykkelveg');
  else if (enabled('cycleLane') && cycleType === 'Sykkelfelt i bilveg') addImpact('cycleLane', 1, 'Sykkelfelt i bilveg/delt vegrom');
  if (tram) addImpact('tram', 5, 'Trikkespor i vegbanen · OSM');
  if (tunnelLength >= 1000) addImpact('tunnel', 10, 'Lang tunnel · OSM-estimat');
  else if (tunnelLength >= 500) addImpact('tunnel', 7, 'Tunnel (500 m+) · OSM-estimat');
  else if (tunnelLength >= 200) addImpact('tunnel', 4, 'Tunnel (200 m+) · OSM-estimat');
  if (separated) addImpact('structured', -1, 'Parallelle, adskilte vegløp · OSM-geometri');
  const category = score >= 6 ? 'high' : score <= -3 || structuredForCategory ? 'low' : 'normal';
  return { score, category, structured: structuredForCategory, tunnelLength, reasons };
}

function complexityTiles(features) {
  const cells = new Map(), longitudeStep = 0.004, latitudeStep = 0.002;
  features.forEach(feature => {
    const midpoint = turf.along(feature, turf.length(feature) / 2);
    const [longitude, latitude] = midpoint.geometry.coordinates;
    const column = Math.floor(longitude / longitudeStep), row = Math.floor(latitude / latitudeStep);
    const key = column + ':' + row;
    if (!cells.has(key)) cells.set(key, { column, row, score: 0, length: 0, structured: 0, count: 0, categories: { high: 0, normal: 0, low: 0 } });
    const cell = cells.get(key), length = turf.length(feature);
    cell.score += feature.properties.score * length;
    cell.length += length;
    cell.count++;
    cell.categories[feature.properties.category]++;
    if (feature.properties.structured) cell.structured += length;
  });
  const clip = activeScope();
  return [...cells.values()].flatMap(cell => {
    const score = cell.score / Math.max(cell.length, 0.000001);
    const category = score >= 6 ? 'high' : score <= -3 || cell.structured / cell.length >= 0.6 ? 'low' : 'normal';
    const bounds = [cell.column * longitudeStep, cell.row * latitudeStep, (cell.column + 1) * longitudeStep, (cell.row + 1) * latitudeStep];
    const square = turf.bboxPolygon(bounds);
    const geometry = clip ? turf.intersect(square, clip) : square;
    if (!geometry) return [];
    return [{ ...geometry, properties: { kind: 'tile', category, color: COMPLEXITY_COLORS[category], score: Number(score.toFixed(1)), count: cell.count, segments: cell.categories } }];
  });
}

function rescoreComplexity(features) {
  return features.map(feature => {
    const result = roadComplexityScore(feature.properties._metrics, undefined, app.complexityWeights);
    return { ...feature, properties: { ...feature.properties, color: COMPLEXITY_COLORS[result.category], category: result.category, score: result.score, structured: result.structured, tunnelLength: result.tunnelLength, reasons: result.reasons.join(', ') } };
  });
}

function complexityFactorFeatures(key) {
  const data = app.complexityDatasets || {}, scope = activeScope();
  const inside = features => features.filter(feature => !scope || turf.booleanIntersects(feature, scope));
  const roads = data.roads || [];
  if (key === 'speed') return inside(roads.filter(feature => app.complexitySpeedCategories.has(complexitySpeedCategoryKey(feature))));
  if (key === 'junctions') return inside(data.junctions || []);
  if (key === 'signals') return inside(data.signals || []);
  if (key === 'crossings') return inside(data.crossings || []);
  if (key === 'tunnel') return inside(roads.filter(feature => feature.properties.osm_tunnel));
  if (key === 'tram') return inside(data.tram || []);
  if (key === 'cycleLane') return inside(data.cycleLane || []);
  if (key === 'cycleway') return inside(data.cycleway || []);
  if (key === 'structured') return (app.complexityFeatures || []).filter(feature => feature.properties.separated)
    .filter(feature => !scope || turf.booleanIntersects(feature, scope));
  return [];
}

function renderComplexityFactorOverlays() {
  let visibleOverlayFeatures = 0;
  COMPLEXITY_FACTORS.forEach(({ key }) => {
    const id = 'complexity-factor-' + key, color = COMPLEXITY_FACTOR_COLORS[key];
    const features = app.complexityEnabled && app.complexityFactors.has(key)
      ? complexityFactorFeatures(key).map(feature => ({ ...feature, properties: { ...feature.properties, color } })) : [];
    app.engine.setGeoJSON(id, features, color);
    app.engine.visible(id, features.length > 0);
    visibleOverlayFeatures += features.length;
    app.engine.onFeature(id, (feature, coordinates) => {
      const details = Object.fromEntries(Object.entries(feature.properties).filter(([name]) => name !== 'color' && !name.startsWith('_')).slice(0, 10));
      showProperties(COMPLEXITY_FACTORS.find(factor => factor.key === key)?.label || key, details, coordinates);
    });
  });
  if (app.complexityPriority) {
    const id = 'complexity-factor-' + app.complexityPriority;
    ['-area', '-line', '-point'].forEach(suffix => { if (app.engine.map.getLayer(id + suffix)) app.engine.map.moveLayer(id + suffix); });
  }
  const dimComposite = app.complexityEnabled && visibleOverlayFeatures > 0;
  const fillOpacity = dimComposite ? 0.12 : 0.46;
  const lineOpacity = dimComposite ? 0.24 : 0.92;
  if (app.engine.map.getLayer('road-complexity-area')) app.engine.map.setPaintProperty('road-complexity-area', 'fill-opacity', fillOpacity);
  if (app.engine.map.getLayer('road-complexity-line')) app.engine.map.setPaintProperty('road-complexity-line', 'line-opacity', lineOpacity);
}

function renderComplexitySnapshot() {
  if (!app.complexityFeatures.length) return;
  const features = rescoreComplexity(app.complexityFeatures);
  const detailMode = app.engine.map.getZoom() >= 14.2;
  app.complexityDetailMode = detailMode;
  renderComplexitySpeedCategories(app.complexityDatasets?.roads || []);
  app.engine.setGeoJSON('road-complexity', detailMode ? features : complexityTiles(features), '#718087', 'complexity');
  app.engine.visible('road-complexity', app.complexityEnabled);
  renderComplexityFactorOverlays();
  const counts = features.reduce((summary, feature) => { summary[feature.properties.category]++; return summary; }, { high: 0, normal: 0, low: 0 });
  app.complexitySummary = features.length.toLocaleString('nb-NO') + ' OSM-delstrekk · ' + counts.low + ' lav · ' + counts.normal + ' vanlig · ' + counts.high + ' høy'
    + (app.complexityDatasets?.osmFailedTiles ? ' · delvis OSM' : '');
  updateComplexitySnapshotStatus();
}

function showProperties(title, properties, coordinates) {
  const content = element('div');
  content.append(element('strong', title));
  Object.entries(properties).filter(([key, value]) => key !== 'color' && !key.startsWith('_') && value !== undefined && value !== null && value !== '').forEach(([key, value]) => {
    const row = element('div', undefined, 'popup-row');
    row.append(element('span', key), element('span', String(value)));
    content.append(row);
  });
  app.engine.popup(coordinates, content);
}

function complexityIndex(features) {
  const cellSize = 0.005, cells = new Map();
  features.flatMap(feature => turf.flatten(feature).features).forEach(feature => {
    const bounds = turf.bbox(feature);
    for (let column = Math.floor(bounds[0] / cellSize); column <= Math.floor(bounds[2] / cellSize); column++) {
      for (let row = Math.floor(bounds[1] / cellSize); row <= Math.floor(bounds[3] / cellSize); row++) {
        const key = column + ':' + row;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(feature);
      }
    }
  });
  return { cellSize, cells };
}

function complexityIndexes(datasets) {
  const keys = ['roads', 'cycleLane', 'cycleway', 'tram', 'junctions', 'crossings', 'signals'];
  return Object.fromEntries(keys.map(key => [key, complexityIndex(datasets[key] || [])]));
}

function complexityCandidates(point, index) {
  const [longitude, latitude] = point.geometry.coordinates;
  const column = Math.floor(longitude / index.cellSize), row = Math.floor(latitude / index.cellSize), candidates = new Set();
  for (let x = column - 1; x <= column + 1; x++) for (let y = row - 1; y <= row + 1; y++) {
    (index.cells.get(x + ':' + y) || []).forEach(feature => candidates.add(feature));
  }
  return [...candidates];
}

function complexityDistance(point, feature) {
  if (feature.geometry.type === 'Point') return turf.distance(point, feature) * 1000;
  if (feature.geometry.type === 'LineString') return turf.pointToLineDistance(point, feature) * 1000;
  return Infinity;
}

function nearestComplexityFeature(point, index, maxMeters) {
  let nearest = null, distance = maxMeters;
  complexityCandidates(point, index).forEach(feature => {
    const next = complexityDistance(point, feature);
    if (next <= distance) { nearest = feature; distance = next; }
  });
  return nearest ? { feature: nearest, distance } : null;
}

function tramTracksMatchRoad(line, index) {
  const midpoint = turf.along(line, turf.length(line) / 2);
  const physicalTrack = nearestComplexityFeature(midpoint, index, 8);
  return Boolean(physicalTrack && physicalTrack.distance <= 4 && physicalTrack.feature.properties.railway === 'tram');
}

function countComplexityPoints(point, index, radiusMeters) {
  return complexityCandidates(point, index).reduce((count, feature) => count + Number(complexityDistance(point, feature) <= radiusMeters), 0);
}

function lineToLineDistanceMeters(first, second) {
  if (turf.booleanIntersects(first, second)) return 0;
  const distances = [
    ...first.geometry.coordinates.map(coordinates => turf.pointToLineDistance(turf.point(coordinates), second)),
    ...second.geometry.coordinates.map(coordinates => turf.pointToLineDistance(turf.point(coordinates), first))
  ];
  return Math.min(...distances) * 1000;
}

function complexityLineParts(feature) {
  if (feature.geometry.type === 'LineString') return [feature];
  if (feature.geometry.type === 'MultiLineString') return turf.flatten(feature).features;
  return [];
}

function countComplexityFeaturesNearLine(line, index, radiusMeters) {
  const midpoint = turf.along(line, turf.length(line) / 2);
  return complexityCandidates(midpoint, index).reduce((count, feature) => {
    const distance = feature.geometry.type === 'Point'
      ? turf.pointToLineDistance(feature, line) * 1000
      : Math.min(...complexityLineParts(feature).map(part => lineToLineDistanceMeters(line, part)));
    return count + Number(distance <= radiusMeters);
  }, 0);
}

function complexityProperty(properties, names) {
  const expected = names.map(name => name.toLocaleLowerCase('nb-NO'));
  const entry = Object.entries(properties).find(([name]) => expected.includes(name.toLocaleLowerCase('nb-NO')));
  const value = Number(entry?.[1]);
  return Number.isFinite(value) && entry?.[1] !== '' ? value : null;
}

function complexityGrade(profile, startKm, endKm) {
  if (!Array.isArray(profile) || profile.length < 2) return null;
  const elevationAt = distance => {
    if (distance <= profile[0][0]) return profile[0][1];
    for (let index = 1; index < profile.length; index++) {
      if (profile[index][0] >= distance) {
        const before = profile[index - 1], after = profile[index];
        const fraction = (distance - before[0]) / Math.max(0.000001, after[0] - before[0]);
        return before[1] + (after[1] - before[1]) * fraction;
      }
    }
    return profile.at(-1)[1];
  };
  const steps = Math.max(1, Math.ceil((endKm - startKm) / 0.05));
  let maximum = 0, previousDistance = startKm, previousElevation = elevationAt(startKm);
  for (let step = 1; step <= steps; step++) {
    const distance = startKm + (endKm - startKm) * step / steps;
    const elevation = elevationAt(distance);
    maximum = Math.max(maximum, Math.abs(elevation - previousElevation) / Math.max(1, (distance - previousDistance) * 1000) * 100);
    previousDistance = distance; previousElevation = elevation;
  }
  return maximum;
}

function scoreRoadComplexity(roadFeatures, datasets) {
  const lines = roadFeatures.flatMap(feature => feature.geometry.type === 'LineString'
    ? [feature]
    : feature.geometry.type === 'MultiLineString'
      ? feature.geometry.coordinates.map(coordinates => turf.lineString(coordinates, feature.properties)) : []);
  const indexes = complexityIndexes(datasets), output = [], scope = activeScope();
  const roadBearing = feature => {
    const coordinates = feature.geometry.coordinates;
    return turf.bearing(turf.point(coordinates[0]), turf.point(coordinates.at(-1)));
  };
  const hasParallelCarriageway = (segment, road) => {
    if (road.properties.oneway !== 'yes') return false;
    const midpoint = turf.along(segment, turf.length(segment) / 2), bearing = roadBearing(road);
    return complexityCandidates(midpoint, indexes.roads).some(candidate => {
      if (candidate.properties.osm_id === road.properties.osm_id || candidate.properties.oneway !== 'yes') return false;
      if (candidate.properties.roadClass !== road.properties.roadClass) return false;
      const distance = lineToLineDistanceMeters(segment, candidate);
      if (distance < 4 || distance > 30) return false;
      const difference = Math.abs(((roadBearing(candidate) - bearing + 540) % 360) - 180);
      return Math.min(difference, 180 - difference) <= 20;
    });
  };
  lines.forEach(line => {
    const lineLength = turf.length(line);
    const tunnelLength = line.properties.osm_tunnel ? lineLength * 1000 : 0;
    for (let startKm = 0; startKm < lineLength; startKm += 0.1) {
      const segment = turf.lineSliceAlong(line, startKm, Math.min(lineLength, startKm + 0.1));
      if (segment.geometry.coordinates.length < 2) continue;
      const segmentLength = turf.length(segment), midpoint = turf.along(segment, segmentLength / 2);
      if (scope && !insideScope(midpoint.geometry.coordinates, scope)) continue;
      const cycleLaneMatch = nearestComplexityFeature(midpoint, indexes.cycleLane, 12);
      const separateCyclewayMatch = nearestComplexityFeature(midpoint, indexes.cycleway, 12);
      const cycleType = separateCyclewayMatch && (!cycleLaneMatch || separateCyclewayMatch.distance < cycleLaneMatch.distance)
        ? 'Sykkelfelt i sykkelveg' : cycleLaneMatch?.feature.properties.cycleType || null;
      const tramTrackInRoad = tramTracksMatchRoad(segment, indexes.tram);
      const junctions = countComplexityPoints(midpoint, indexes.junctions, 60);
      const crossings = countComplexityPoints(midpoint, indexes.crossings, 70);
      const signals = countComplexityPoints(midpoint, indexes.signals, 70);
      const signalsWithin10m = countComplexityFeaturesNearLine(segment, indexes.signals, 10);
      const speed = line.properties.osm_speed_kph;
      const separated = hasParallelCarriageway(segment, line);
      const metrics = { speed, junctions, crossings, signals, signalsWithin10m, tramTrackInRoad, tunnelLength, cycleType, separated };
      const result = roadComplexityScore(metrics);
      output.push(turf.lineString(segment.geometry.coordinates, {
        osm_id: line.properties.osm_id, color: COMPLEXITY_COLORS[result.category], category: result.category, score: result.score,
        speed, junctions, crossings, signals, signalsWithin10m, tramTrackInRoad, tunnelLength, cycleType, separated,
        reasons: result.reasons.join(', '), _metrics: metrics
      }));
    }
  });
  return output;
}

async function loadRoadComplexity(force = false) {
  if (!app.ready) return;
  stopRequest('road-complexity');
  const box = dataBox();
  if (!activeScope() && app.engine.map.getZoom() < 13) {
    setStatus('roadComplexityStatus', 'Zoom inn / mindre område'); return;
  }
  if (force) { app.cache.clear(); app.bypassCacheUntil = Date.now() + 10000; }
  const controller = new AbortController();
  const refresh = byId('roadComplexityRefresh');
  refresh.disabled = true;
  app.requests.set('road-complexity', controller);
  setStatus('roadComplexityStatus', 'Henter data …');
  try {
    const data = await loadOsmMapFeatures(box, controller.signal, activeScope(), (completed, total, detail) => {
      setStatus('roadComplexityStatus', detail?.cooldownSeconds
        ? 'OSM-pause · prøv igjen om ' + detail.cooldownSeconds + ' s'
        : detail?.splitting ? 'Deler tett OSM-flis · ' + completed + '/' + total
          : 'OSM-fliser ' + completed + '/' + total);
    });
    if (controller.signal.aborted) return;
    app.complexityDatasets = data;
    app.complexityFeatures = scoreRoadComplexity(data.roads || [], data);
    renderComplexitySnapshot();
    app.engine.onFeature('road-complexity', (feature, coordinates) => {
      const properties = feature.properties;
      const labels = { high: 'Høy kompleksitet', normal: 'Vanlig kompleksitet', low: 'Lav kompleksitet' };
      if (properties.kind === 'tile') {
        app.engine.fit(feature);
        const segments = typeof properties.segments === 'string' ? JSON.parse(properties.segments) : properties.segments;
        showProperties('Kompleksitet · områdeflate', {
          Vurdering: labels[properties.category],
          'Vektet proxy-score': properties.score,
          'Vegsegmenter': properties.count,
          'Lav kompleksitet': segments.low,
          'Vanlig kompleksitet': segments.normal,
          'Høy kompleksitet': segments.high,
        }, coordinates);
        return;
      }
      showProperties('Vegsegment · kompleksitet', {
        Vurdering: labels[properties.category],
        'Proxy-score': properties.score,
        'Kilde': 'OpenStreetMap',
        'Fartsgrense': properties.speed ? properties.speed.toFixed(0) + ' km/t' : 'Ikke kartlagt',
        'Kryss / rundkjøringer': properties.junctions,
        'Gangfelt': properties.crossings,
        'Lyssignal innen 10 m': properties.signalsWithin10m > 0 ? 'Ja' : 'Ikke registrert i OSM',
        'Trikkespor i vegbanen': properties.tramTrackInRoad ? 'Kartlagt' : 'Ikke kartlagt her',
        'Tunnel': properties.tunnelLength ? Math.round(properties.tunnelLength).toLocaleString('nb-NO') + ' m way-lengde · OSM-estimat' : 'Ikke kartlagt her',
        'Sykkeltilrettelegging': properties.cycleType || 'Ikke registrert',
        'Parallelle vegløp': properties.separated ? 'Påvist i OSM-geometri' : 'Ikke påvist',
        'Trafikkmengde / ulykker': 'Ikke sammenlignbart tilgjengelig i OSM'
      }, coordinates);
    });
    if (data.osmCooldownSeconds) {
      app.complexitySummary = (app.complexitySummary || 'Ingen OSM-data') + ' · OSM-pause ' + data.osmCooldownSeconds + ' s';
    }
    app.complexitySnapshotKey = box.map(value => value.toFixed(4)).join(',');
    setStatus('roadComplexityStatus', app.complexitySummary || 'Ingen OSM-data');
  } catch (error) {
    if (!controller.signal.aborted) { setStatus('roadComplexityStatus', 'Feil'); toast('Vegkompleksitet: ' + error.message); }
  } finally {
    const cooldownRemaining = Math.max(0, osmCooldownUntil - Date.now());
    refresh.disabled = cooldownRemaining > 0;
    if (cooldownRemaining) setTimeout(() => {
      if (Date.now() >= osmCooldownUntil) refresh.disabled = false;
    }, cooldownRemaining);
  }
}

function updateComplexitySnapshotStatus() {
  if (!app.complexityEnabled || !app.complexitySnapshotKey) return;
  const currentKey = dataBox().map(value => value.toFixed(4)).join(',');
  setStatus('roadComplexityStatus', app.complexitySummary + (currentKey === app.complexitySnapshotKey ? '' : ' · annet utsnitt, oppdater'));
}

async function loadStops(force = false) {
  stopRequest('stops');
  if (!app.ready || !app.live.stops) return;
  const box = dataBox();
  if ((!activeScope() && app.engine.map.getZoom() < 12) || boxArea(box) > 150) { app.engine.visible('stops', false); setStatus('stopsStatus', 'Zoom inn'); return; }
  const controller = new AbortController();
  app.requests.set('stops', controller);
  setStatus('stopsStatus', 'Henter …');
  const key = 'stops:' + box.map(value => value.toFixed(4)).join(',');
  try {
    let stops = !force && app.cache.get(key);
    if (!stops || Date.now() - stops.at > 21600000) {
      const query = `{quaysByBbox(minimumLatitude:${box[1]},minimumLongitude:${box[0]},maximumLatitude:${box[3]},maximumLongitude:${box[2]},filterByInUse:true){id name latitude longitude}}`;
      const data = await storedData(key, 21600000, () => graphql(query, controller.signal), controller.signal);
      stops = { at: Date.now(), features: data.quaysByBbox };
      app.cache.set(key, stops);
    }
    if (controller.signal.aborted || !app.live.stops) return;
    app.stops = stops.features.filter(stop => Number.isFinite(stop.longitude) && Number.isFinite(stop.latitude) && insideScope([stop.longitude, stop.latitude]));
    app.engine.setGeoJSON('stops', app.stops.filter(stop => Number.isFinite(stop.longitude) && Number.isFinite(stop.latitude)).map(stop => turf.point([stop.longitude, stop.latitude], { id: stop.id, name: stop.name })), '#147da0');
    app.engine.visible('stops', true);
    app.engine.onFeature('stops', feature => showStop(feature.properties.id));
    setStatus('stopsStatus', app.stops.length.toLocaleString('nb-NO'));
    updateLiveTimestamp();
  } catch (error) {
    if (!controller.signal.aborted) { app.engine.visible('stops', false); setStatus('stopsStatus', 'Feil'); toast('Entur holdeplasser: ' + error.message); }
  }
}

function updateLiveTimestamp() { byId('liveTimestamp').textContent = 'Siste svar ' + new Date().toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

async function showStop(id) {
  stopRequest('departures');
  const controller = new AbortController();
  app.requests.set('departures', controller);
  byId('inspector').hidden = false;
  byId('inspectTitle').textContent = 'Avganger';
  byId('inspectContent').replaceChildren(element('p', 'Henter avganger fra Entur …', 'note'));
  try {
    const query = `{quay(id:${JSON.stringify(id)}){id name estimatedCalls(timeRange:7200,numberOfDepartures:16,includeCancelledTrips:false){realtime expectedDepartureTime destinationDisplay{frontText}serviceJourney{id journeyPattern{line{id publicCode name transportMode}}}}}}`;
    const data = await storedData('departures:' + id, 120000, () => graphql(query, controller.signal), controller.signal);
    if (controller.signal.aborted) return;
    byId('inspectTitle').textContent = data.quay?.name || 'Holdeplass';
    byId('inspectContent').replaceChildren();
    const calls = data.quay?.estimatedCalls || [];
    if (!calls.length) byId('inspectContent').append(element('p', 'Ingen avganger de neste to timene.', 'note'));
    calls.forEach(call => {
      const line = call.serviceJourney.journeyPattern.line;
      app.lines.set(line.id, line);
      const row = element('div', undefined, 'departure');
      const badge = element('button', line.publicCode || '—', 'linebadge');
      badge.title = 'Vis trasé for ' + line.name;
      badge.onclick = () => showEnturLine(line.id);
      const description = element('div');
      description.append(element('div', call.destinationDisplay?.frontText || line.name), element('div', call.realtime ? 'Sanntidsprognose' : 'Planlagt avgang', 'note'));
      const time = element('time', new Date(call.expectedDepartureTime).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' }));
      time.dateTime = call.expectedDepartureTime;
      row.append(badge, description, time);
      byId('inspectContent').append(row);
    });
    renderEnturLines();
  } catch (error) { if (!controller.signal.aborted) byId('inspectContent').replaceChildren(element('p', 'Kunne ikke hente avganger: ' + error.message, 'note')); }
}

function renderEnturLines() {
  const container = byId('enturLines');
  if (!container) return;
  container.replaceChildren();
  [...app.lines.values()].sort((first, second) => String(first.publicCode).localeCompare(String(second.publicCode), 'nb', { numeric: true })).forEach(line => {
    const button = element('button', (line.publicCode || '') + ' · ' + line.name, 'full');
    button.style.textAlign = 'left';
    button.onclick = () => showEnturLine(line.id);
    byId('enturLines').append(button);
  });
}

async function showEnturLine(id) {
  stopRequest('line');
  const controller = new AbortController();
  app.requests.set('line', controller);
  const token = ++app.lineToken;
  byId('inspector').hidden = false;
  byId('inspectTitle').textContent = 'Linjetrasé';
  byId('inspectContent').replaceChildren(element('p', 'Henter linjetrasé …', 'note'));
  try {
    const query = `{line(id:${JSON.stringify(id)}){id publicCode name transportMode journeyPatterns{id pointsOnLink{points}}}}`;
    const data = await storedData('line:' + id, 86400000, () => graphql(query, controller.signal), controller.signal);
    if (controller.signal.aborted || token !== app.lineToken) return;
    const features = (data.line?.journeyPatterns || []).filter(pattern => pattern.pointsOnLink?.points).map(pattern => turf.lineString(polyline.decode(pattern.pointsOnLink.points).map(point => [point[1], point[0]]), { patternId: pattern.id }));
    if (!features.length) throw new Error('Entur har ingen linjegeometri for denne linjen.');
    const visible = clipFeatures(features);
    app.engine.setGeoJSON('transit-line', visible, '#147da0');
    if (visible.length) app.engine.fit({ type: 'FeatureCollection', features: visible });
    byId('inspectTitle').textContent = data.line.publicCode + ' · ' + data.line.name;
    byId('inspectContent').replaceChildren(element('p', activeScope() ? visible.length + ' rutedeler innenfor dataområdet.' : features.length + ' ruteformer fra Entur. Velg ruteform for å legge den til som rutekandidat.', 'note'));
    visible.forEach((feature, index) => {
      const button = element('button', 'Analyser ruteform ' + (index + 1), 'full');
      button.onclick = () => { addDrawing(feature, 'Entur ' + data.line.publicCode + ' · form ' + (index + 1), 'Entur planlagt linjegeometri'); setTab('analysis'); };
      byId('inspectContent').append(button);
    });
  } catch (error) { if (!controller.signal.aborted) byId('inspectContent').replaceChildren(element('p', error.message, 'note')); }
}

function vehicleFootprint(vehicle) {
  const center = turf.point([vehicle.location.longitude, vehicle.location.latitude]);
  const bearing = Number(vehicle.bearing) || 0;
  const front = turf.destination(center, 0.006, bearing);
  const back = turf.destination(center, 0.006, bearing + 180);
  const corners = [turf.destination(front, 0.0014, bearing - 90), turf.destination(front, 0.0014, bearing + 90), turf.destination(back, 0.0014, bearing + 90), turf.destination(back, 0.0014, bearing - 90)].map(point => point.geometry.coordinates);
  corners.push(corners[0]);
  return turf.polygon([corners], { vehicleId: vehicle.vehicleId, line: vehicle.line?.lineName || vehicle.line?.lineRef || '', updated: vehicle.lastUpdated, destination: vehicle.destinationName || '' });
}

function renderVehicleEstimates(now = Date.now()) {
  if (!app.ready || !app.live.vehicles || !app.motion.tracks.size) return;
  const box = dataBox();
  const vehicles = app.motion.sample(now).filter(vehicle => {
    const { longitude, latitude } = vehicle.location;
    return longitude >= box[0] && longitude <= box[2] && latitude >= box[1] && latitude <= box[3] && insideScope([longitude, latitude]);
  });
  app.vehicles = vehicles;
  const signature = JSON.stringify(vehicles.map(vehicle => [vehicle.vehicleId, vehicle.location.longitude.toFixed(8), vehicle.location.latitude.toFixed(8), vehicle.positionKind, vehicle.bearing]));
  if (signature !== app.vehicleSignature) {
    app.vehicleSignature = signature;
    app.engine.setGeoJSON('vehicles', vehicles.map(vehicleFootprint), '#08775e', 'vehicles');
    if (app.engine.setVehicleModels(vehicles)) {
      app.engine.map.setPaintProperty('vehicles-body', 'fill-extrusion-height', 0.12);
      app.engine.map.setPaintProperty('vehicles-body', 'fill-extrusion-base', 0);
      app.engine.map.setPaintProperty('vehicles-body', 'fill-extrusion-opacity', 0.18);
    }
    app.engine.setGeoJSON('vehicle-points', vehicles.map(vehicle => turf.point([vehicle.location.longitude, vehicle.location.latitude], { vehicleId: vehicle.vehicleId, positionKind: vehicle.positionKind })), '#08775e');
    app.engine.map.setLayerZoomRange('vehicle-points-point', 0, 16);
    app.engine.visible('vehicles', true); app.engine.visible('vehicle-points', true);
    const inspect = feature => {
      const vehicle = app.vehicles.find(item => item.vehicleId === feature.properties.vehicleId);
      if (vehicle) showProperties('Buss · ' + (vehicle.line?.lineName || vehicle.line?.lineRef || vehicle.vehicleId), {
        Kjøretøy: vehicle.vehicleId, Destinasjon: vehicle.destinationName || 'Ukjent',
        'GPS-observasjon': new Date(vehicle.lastUpdated).toLocaleTimeString('nb-NO'),
        Posisjon: vehicle.positionKind === 'estimated' ? 'ESTIMERT, ikke en ny GPS-observasjon' : vehicle.positionKind === 'stale' ? 'UTDATERT · framskriving stoppet' : 'Lagret GPS-observasjon',
        Beregning: vehicle.estimationMethod, Modell: 'Illustrativ 12 m standardbuss'
      }, [vehicle.location.longitude, vehicle.location.latitude]);
    };
    app.engine.onFeature('vehicles', inspect); app.engine.onFeature('vehicle-points', inspect);
  }
  const estimated = vehicles.filter(vehicle => vehicle.positionKind === 'estimated').length;
  const stale = vehicles.filter(vehicle => vehicle.positionKind === 'stale').length;
  setStatus('vehiclesStatus', vehicles.length + (stale ? ' · ' + stale + ' utdatert' : estimated ? ' · ' + estimated + ' estimert' : ' · GPS'));
  const newest = Math.max(...[...app.motion.tracks.values()].map(track => track.observedAt));
  byId('liveTimestamp').textContent = 'Siste GPS ' + new Date(newest).toLocaleTimeString('nb-NO') + (stale ? ' · estimat stoppet etter 5 min' : estimated ? ' · lokal framskriving' : ' · lagret snapshot');
}

async function prepareVehicleJourneys(vehicles, signal) {
  const journeys = new Map();
  vehicles.forEach(vehicle => { if (vehicle.serviceJourney?.id) journeys.set(vehicle.serviceJourney.id, vehicle.serviceJourney); });
  await pool([...journeys.values()], 2, async journey => {
    if (signal.aborted) return;
    try {
      const query = `{serviceJourney(id:${JSON.stringify(journey.id)}){id journeyPattern{pointsOnLink{points}}estimatedCalls{expectedArrivalTime expectedDepartureTime quay{id latitude longitude}}}}`;
      const result = await storedData('journey:' + journey.id + ':' + journey.date, 120000, () => graphql(query, signal), signal);
      if (signal.aborted || !result.serviceJourney?.journeyPattern?.pointsOnLink?.points) return;
      const data = result.serviceJourney;
      const geometry = turf.lineString(polyline.decode(data.journeyPattern.pointsOnLink.points).map(point => [point[1], point[0]]));
      app.motion.setJourney(journey.id, { geometry, calls: data.estimatedCalls || [] });
      renderVehicleEstimates();
    } catch (error) { if (!signal.aborted) console.warn('Ingen estimert trasé for bussreisen:', error.message); }
  });
}

async function loadVehicles(force = false) {
  if (!app.ready || !app.live.vehicles || document.hidden) return;
  const box = dataBox();
  if ((!activeScope() && app.engine.map.getZoom() < 11) || boxArea(box) > 500) {
    app.motion.update([]); app.engine.setVehicleModels([]);
    app.vehicleSnapshotKey = null;
    app.engine.visible('vehicles', false); app.engine.visible('vehicle-points', false); setStatus('vehiclesStatus', 'Zoom inn'); return;
  }
  const key = 'vehicles:' + box.map(value => value.toFixed(5)).join(',');
  if (!force && app.vehicleSnapshotKey === key) {
    app.vehicleSignature = null;
    if (app.motion.tracks.size) renderVehicleEstimates();
    else setStatus('vehiclesStatus', '0 · GPS');
    return;
  }
  if (app.loadingVehicles && !app.loadingVehicles.signal.aborted && app.vehicleLoadKey === key && !force) return;
  stopRequest('vehicles');
  const controller = new AbortController();
  app.loadingVehicles = controller; app.vehicleLoadKey = key; app.lastVehicleCheck = Date.now();
  app.requests.set('vehicles', controller);
  setStatus('vehiclesStatus', 'Henter snapshot …');
  try {
    const query = `{vehicles(boundingBox:{minLon:${box[0]},minLat:${box[1]},maxLon:${box[2]},maxLat:${box[3]}},mode:BUS,maxDataAge:"PT2M",includeInvalidLocations:false){vehicleId bearing lastUpdated destinationName serviceJourney{id date}location{latitude longitude}line{lineRef lineName}}}`;
    const fetchSnapshot = () => graphql(query, controller.signal, true);
    const data = force ? await fetchSnapshot() : await storedData(key, 300000, fetchSnapshot, controller.signal);
    if (controller.signal.aborted || !app.live.vehicles) return;
    if (force) await app.store.set(key, data);
    app.vehicleSnapshotKey = key;
    const vehicles = (data.vehicles || []).filter(vehicle => Number.isFinite(vehicle.location?.latitude) && Number.isFinite(vehicle.location?.longitude) && Date.now() - Date.parse(vehicle.lastUpdated) < 420000 && insideScope([vehicle.location.longitude, vehicle.location.latitude]));
    app.motion.update(vehicles);
    app.vehicleSignature = null;
    if (!vehicles.length) {
      app.vehicles = []; app.engine.setVehicleModels([]);
      ['vehicles', 'vehicle-points'].forEach(id => { if (app.engine.map.getSource(id)) app.engine.map.getSource(id).setData({ type: 'FeatureCollection', features: [] }); });
      setStatus('vehiclesStatus', '0 · GPS');
    } else {
      renderVehicleEstimates();
      await prepareVehicleJourneys(vehicles, controller.signal);
    }
  } catch (error) {
    if (!controller.signal.aborted) { setStatus('vehiclesStatus', 'Lagret / frakoblet'); renderVehicleEstimates(); console.warn('Entur kjøretøy:', error.message); }
  } finally { if (app.loadingVehicles === controller) app.loadingVehicles = null; }
}

function refreshViewport(force = false) {
  if (!app.ready) return;
  const key = activeScope() ? app.scopeKey : viewportBox().map(value => value.toFixed(4)).join(',') + ':' + app.engine.map.getZoom().toFixed(1);
  if (!force && key === app.lastViewportKey) return;
  app.lastViewportKey = key;
  if (force) { app.cache.clear(); app.bypassCacheUntil = Date.now() + 10000; }
  loadStops(force); loadVehicles(force); app.enabledRoads.forEach(loadRoad);
}

async function analyzeRoute(item) {
  stopRequest('analysis:' + item.id);
  const controller = new AbortController();
  app.requests.set('analysis:' + item.id, controller);
  const feature = structuredClone(item.feature);
  item.loading = true; item.stats = null; item.error = null;
  app.engine.clear('route-speed-' + item.id);
  renderDrawings();
  try {
    const routeKm = turf.length(feature);
    if (!(routeKm > 0) || routeKm > 150) throw new Error('Bruk en rute med lengde mellom 0 og 150 km.');
    const corridor = turf.buffer(feature, 0.05);
    const roads = (await nvdbForBox(105, turf.bbox(corridor), controller.signal)).filter(road => turf.booleanIntersects(road, corridor));
    const segments = [];
    roads.forEach(road => {
      if (road.geometry.type === 'LineString') segments.push(road);
      if (road.geometry.type === 'MultiLineString') road.geometry.coordinates.forEach(coordinates => segments.push(turf.lineString(coordinates, road.properties)));
    });
    const grid = new Map();
    const cellSize = 0.005;
    segments.forEach(road => {
      const bounds = turf.bbox(road);
      for (let column = Math.floor((bounds[0] - 0.001) / cellSize); column <= Math.floor((bounds[2] + 0.001) / cellSize); column++) {
        for (let row = Math.floor((bounds[1] - 0.0006) / cellSize); row <= Math.floor((bounds[3] + 0.0006) / cellSize); row++) {
          const key = column + ':' + row;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(road);
        }
      }
    });
    const sampleCount = Math.max(1, Math.min(12000, Math.ceil(routeKm / 0.02)));
    const sampleKm = routeKm / sampleCount;
    const speedKm = {}, highlights = [];
    let activeSpeed = null, activeCoordinates = [];
    const save = () => { if (activeCoordinates.length > 1) highlights.push(turf.lineString(activeCoordinates, { speed: activeSpeed, color: SPEED_COLORS[activeSpeed] || '#84918a' })); };
    for (let index = 0; index < sampleCount; index++) {
      if (controller.signal.aborted) return;
      const point = turf.along(feature, (index + 0.5) * sampleKm);
      const coordinates = point.geometry.coordinates;
      const candidates = grid.get(Math.floor(coordinates[0] / cellSize) + ':' + Math.floor(coordinates[1] / cellSize)) || [];
      let closest = null, distance = 0.035;
      candidates.forEach(road => { const nextDistance = turf.pointToLineDistance(point, road); if (nextDistance < distance) { closest = road; distance = nextDistance; } });
      const speed = closest ? speedValue(closest.properties) : 0;
      speedKm[speed] = (speedKm[speed] || 0) + sampleKm;
      const start = turf.along(feature, index * sampleKm).geometry.coordinates;
      const end = turf.along(feature, (index + 1) * sampleKm).geometry.coordinates;
      if (speed === activeSpeed) activeCoordinates.push(end);
      else { save(); activeSpeed = speed; activeCoordinates = [start, end]; }
      if (index % 150 === 149) await new Promise(resolve => setTimeout(resolve, 0));
    }
    save();
    if (controller.signal.aborted || !app.drawings.has(item.id)) return;
    item.stats = { routeKm, speedKm }; item.highlights = highlights; item.analyzedAt = new Date().toISOString();
  } catch (error) { if (!controller.signal.aborted) item.error = error.message; }
  finally { if (!controller.signal.aborted && app.drawings.has(item.id)) { item.loading = false; renderDrawings(); } }
}

function addDrawing(feature, name, source = 'Manuelt tegnet trasé') {
  if (!['LineString', 'Polygon'].includes(feature.geometry.type)) throw new Error('Bare linjer og polygoner kan analyseres.');
  const copy = structuredClone(feature);
  delete copy.id;
  const id = app.engine.draw.add(copy)[0];
  const item = { id, name: name || (feature.geometry.type === 'Polygon' ? 'Driftsområde ' : 'Rutekandidat ') + (app.drawings.size + 1), source, feature: copy, stats: null, loading: false, error: null };
  app.drawings.set(id, item); app.selectedId = id;
  app.scopeId = id;
  app.engine.draw.changeMode('simple_select', { featureIds: [id] });
  syncDataScope();
  renderDrawings();
  if (feature.geometry.type === 'LineString') analyzeRoute(item);
  return item;
}

function renderDrawings() {
  byId('drawings').replaceChildren();
  if (!app.drawings.size) byId('drawings').append(element('p', 'Ingen rutekandidater eller driftsområder.', 'note'));
  app.drawings.forEach(item => {
    const node = element('div', undefined, 'item' + (item.id === app.selectedId ? ' selected' : ''));
    const head = element('div', undefined, 'itemhead');
    const focus = element('button', item.name);
    focus.onclick = () => { app.selectedId = item.id; app.scopeId = item.id; syncDataScope(); app.engine.fit(item.feature); app.engine.draw.changeMode('simple_select', { featureIds: [item.id] }); renderDrawings(); };
    head.append(focus, iconButton('pencil', 'Rediger geometri', () => { app.selectedId = item.id; app.scopeId = item.id; syncDataScope(); app.engine.draw.changeMode('direct_select', { featureId: item.id }); showDrawbar('Rediger geometri'); }), iconButton('trash-2', 'Fjern ' + item.name, () => deleteDrawing(item.id)));
    node.append(head);
    if (item.feature.geometry.type === 'Polygon') node.append(element('p', (turf.area(item.feature) / 1000000).toFixed(2) + ' km²', 'note'));
    else {
      node.append(element('p', item.source, 'note'));
      if (item.loading) node.append(element('p', 'Henter fartsdata fra NVDB …', 'note'));
      if (item.error) { node.append(element('p', item.error, 'note')); const retry = element('button', 'Prøv analyse på nytt', 'full'); retry.onclick = () => analyzeRoute(item); node.append(retry); }
      if (item.stats) {
        const highlights = new Set(item.visibleSpeeds || []);
        Object.entries(item.stats.speedKm).sort((first, second) => Number(first[0]) - Number(second[0])).forEach(([speed, distance]) => {
          const label = element('label', undefined, 'speedrow');
          const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = highlights.has(speed);
          checkbox.onchange = () => { if (checkbox.checked) highlights.add(speed); else highlights.delete(speed); item.visibleSpeeds = [...highlights]; app.engine.setGeoJSON('route-speed-' + item.id, clipFeatures(item.highlights.filter(feature => highlights.has(String(feature.properties.speed))))); };
          label.append(checkbox, element('span', (Number(speed) ? speed + ' km/t' : 'Ukjent') + ' · ' + distance.toFixed(2) + ' km')); node.append(label);
        });
      }
    }
    byId('drawings').append(node);
  });
  icons();
}

function deleteDrawing(id) {
  stopRequest('analysis:' + id); app.drawings.delete(id); app.engine.draw.delete(id); app.engine.clear('route-speed-' + id);
  if (app.selectedId === id) app.selectedId = null;
  syncDataScope();
  renderDrawings();
}

function showDrawbar(text) { byId('drawbar').hidden = false; byId('drawModeLabel').textContent = text; }

function finishDrawing() {
  if (app.engine.draw.getMode().startsWith('draw_')) app.engine.map.getCanvas().dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  else app.engine.draw.changeMode('simple_select');
  byId('drawbar').hidden = true;
}

function cancelDrawing() {
  if (app.engine.draw.getMode().startsWith('draw_')) app.engine.map.getCanvas().dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
  else app.engine.draw.changeMode('simple_select');
  byId('drawbar').hidden = true;
}

function startDrawArea() {
  if (!app.ready) return;
  setWaypointMode(false);
  app.engine.draw.changeMode('draw_polygon');
  showDrawbar('Driftsområde');
}

function setWaypointMode(enabled) {
  if (!app.ready) return;
  app.waypointMode = enabled; app.engine.waypointMode = enabled;
  if (enabled) app.engine.draw.changeMode('simple_select');
  byId('waypointMode').classList.toggle('active', enabled);
  byId('waypointControls').hidden = !enabled && !app.waypoints.length;
  app.engine.map.getCanvas().style.cursor = enabled ? 'crosshair' : '';
  updateWaypoints();
}

function updateWaypoints() {
  byId('waypointCount').textContent = app.waypoints.length + ' rutepunkter';
  byId('calculateRoute').disabled = app.waypoints.length < 2 || app.routing;
  byId('calculateRoute').textContent = app.routing ? 'Beregner …' : 'Beregn vegtrasé';
}

function addWaypoint(coordinates) {
  if (app.waypoints.length >= 25) { toast('Bruk maksimalt 25 rutepunkter.'); return; }
  const marker = new maplibregl.Marker({ element: element('div', String(app.waypoints.length + 1), 'waypoint'), draggable: true }).setLngLat(coordinates).addTo(app.engine.map);
  marker.on('dragend', updateWaypoints); app.waypoints.push(marker); updateWaypoints();
}

function clearWaypoints() { stopRequest('routing'); app.routeToken++; app.routing = false; app.waypoints.forEach(marker => marker.remove()); app.waypoints = []; updateWaypoints(); }

async function calculateRoute() {
  if (app.waypoints.length < 2 || app.routing) return;
  const coordinates = app.waypoints.map(marker => marker.getLngLat().toArray().join(',')).join(';');
  const token = ++app.routeToken, controller = new AbortController();
  app.requests.set('routing', controller); app.routing = true; updateWaypoints();
  try {
    const data = await requestJSON('https://router.project-osrm.org/route/v1/driving/' + coordinates + '?overview=full&geometries=geojson&steps=false', {}, controller.signal);
    if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error('Ingen kjørbar trasé funnet.');
    if (controller.signal.aborted || token !== app.routeToken) return;
    if (coordinates !== app.waypoints.map(marker => marker.getLngLat().toArray().join(',')).join(';')) throw new Error('Rutepunktene er endret. Beregn på nytt.');
    const feature = { type: 'Feature', geometry: data.routes[0].geometry, properties: {} };
    addDrawing(feature, undefined, 'OSRM bilruting · ikke verifisert for buss / AV'); setWaypointMode(false); app.engine.fit(feature);
  } catch (error) { if (!controller.signal.aborted) toast('Ruteberegning: ' + error.message); }
  finally { if (token === app.routeToken) { app.routing = false; updateWaypoints(); } }
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportGeoJSON() {
  if (!app.drawings.size) { toast('Ingen tegninger å eksportere.'); return; }
  const collection = { type: 'FeatureCollection', exportedAt: new Date().toISOString(),
    limitations: 'Veg- og rutedata er screeninggrunnlag, ikke godkjenning for autonom drift. Nærmeste NVDB-veg kan treffe parallellveg. Vær, føre, dekning og kjøretøykrav må vurderes separat.',
    features: [...app.drawings.values()].map(item => ({ ...item.feature, properties: { ...item.feature.properties, name: item.name, source: item.source, analyzedAt: item.analyzedAt || null, status: item.loading ? 'loading' : item.error ? 'error' : item.stats ? 'complete' : 'not-analyzed', error: item.error, stats: item.stats } })) };
  download('selvkjoringsanalyse.geojson', JSON.stringify(collection, null, 2), 'application/geo+json');
}

function exportKml() {
  if (!app.drawings.size) { toast('Ingen tegninger å eksportere.'); return; }
  const xml = document.implementation.createDocument('http://www.opengis.net/kml/2.2', 'kml');
  const create = name => xml.createElementNS(xml.documentElement.namespaceURI, name);
  const root = create('Document'); xml.documentElement.append(root);
  app.drawings.forEach(item => {
    const placemark = create('Placemark'), name = create('name'); name.textContent = item.name; placemark.append(name);
    const polygon = item.feature.geometry.type === 'Polygon';
    const geometry = create(polygon ? 'Polygon' : 'LineString'), coordinates = create('coordinates');
    coordinates.textContent = (polygon ? item.feature.geometry.coordinates[0] : item.feature.geometry.coordinates).map(point => point.slice(0, 2).join(',') + ',0').join(' ');
    if (polygon) { const boundary = create('outerBoundaryIs'), ring = create('LinearRing'); ring.append(coordinates); boundary.append(ring); geometry.append(boundary); }
    else geometry.append(coordinates);
    placemark.append(geometry); root.append(placemark);
  });
  download('driftsomrader.kml', new XMLSerializer().serializeToString(xml), 'application/vnd.google-earth.kml+xml');
}

async function importGeometry(file) {
  if (!file || !app.ready) return;
  try {
    const text = await file.text();
    let features;
    if (/\.kml$/i.test(file.name)) {
      const xml = new DOMParser().parseFromString(text, 'application/xml');
      if (xml.querySelector('parsererror')) throw new Error('Ugyldig KML.');
      features = [...xml.getElementsByTagNameNS('*', 'Placemark')].flatMap(placemark => {
        const name = placemark.getElementsByTagNameNS('*', 'name')[0]?.textContent;
        return [...placemark.getElementsByTagNameNS('*', 'Polygon'), ...placemark.getElementsByTagNameNS('*', 'LineString')].map(geometry => {
          const coordinates = geometry.getElementsByTagNameNS('*', 'coordinates')[0]?.textContent.trim().split(/\s+/).map(pair => pair.split(',').slice(0, 2).map(Number));
          return { type: 'Feature', properties: { name }, geometry: { type: geometry.localName, coordinates: geometry.localName === 'Polygon' ? [coordinates] : coordinates } };
        });
      });
    } else {
      const data = JSON.parse(text);
      features = data.type === 'FeatureCollection' ? data.features : data.type === 'Feature' ? [data] : [{ type: 'Feature', geometry: data, properties: {} }];
    }
    if (!features.length) throw new Error('Filen inneholder ingen linjer eller polygoner.');
    const flattened = [];
    features.forEach(feature => {
      if (feature.geometry.type === 'MultiLineString') feature.geometry.coordinates.forEach(coordinates => flattened.push(turf.lineString(coordinates, feature.properties)));
      else if (feature.geometry.type === 'MultiPolygon') feature.geometry.coordinates.forEach(coordinates => flattened.push(turf.polygon(coordinates, feature.properties)));
      else flattened.push(feature);
    });
    flattened.forEach(feature => {
      turf.coordEach(feature, coordinates => { if (!Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1]) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) throw new Error('Koordinatene må være WGS84 lengdegrad/breddegrad.'); });
      if (!['Polygon', 'LineString'].includes(feature.geometry.type)) throw new Error('Bare linjer og polygoner støttes.');
    });
    flattened.forEach(feature => addDrawing(feature, feature.properties?.name, 'Importert ' + file.name));
    app.engine.fit({ type: 'FeatureCollection', features: flattened }); toast(flattened.length + ' tegninger importert.');
  } catch (error) { toast('Import: ' + error.message); }
}

function parseWaymoCells(rows, S2CellId, S2Cell) {
  const cells = new Map();
  rows.filter(row => row.state_name === 'Arizona' && row.county_name === 'Maricopa').forEach(row => {
    const id = String(row['S2 Cell'] || '').trim(), miles = Number(row['Waymo RO Miles']);
    if (!/^\d{18,20}$/.test(id) || !Number.isFinite(miles) || miles < 0) return;
    let feature = cells.get(id);
    if (!feature) {
      const cellId = new S2CellId(id);
      feature = { type: 'Feature', id, geometry: new S2Cell(cellId).toGEOJSON().geometry,
        properties: { s2CellId: id, waymoMiles: miles, hpmsVmt: Number(row['HPMS Yearly Vehicle Miles Traveled']) || 0, benchmarkCrashes: {} } };
      cells.set(id, feature);
    }
    const crashCount = Number(row['Benchmark Crash Count']);
    if (row.Outcome && Number.isFinite(crashCount)) feature.properties.benchmarkCrashes[row.Outcome] = crashCount;
  });
  return [...cells.values()];
}

function waymoMileageColors(features) {
  const values = features.map(feature => feature.properties.waymoMiles).sort((a, b) => a - b);
  const quantile = fraction => values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))] || 0;
  const breaks = [quantile(0.2), quantile(0.4), quantile(0.6), quantile(0.8)];
  const colors = ['#dbece6', '#a8d1c0', '#6db69a', '#328a70', '#d18b3b'];
  features.forEach(feature => {
    const index = breaks.findIndex(value => feature.properties.waymoMiles <= value);
    feature.properties.milesColor = colors[index < 0 ? colors.length - 1 : index];
  });
}

function combineWaymoCoverage(cells) {
  if (!cells.length) return null;
  const ordered = [...cells].sort((first, second) => {
    const firstId = BigInt(first.properties.s2CellId), secondId = BigInt(second.properties.s2CellId);
    return firstId < secondId ? -1 : firstId > secondId ? 1 : 0;
  });
  const geometry = ordered.slice(1).reduce((merged, cell) => turf.union(merged, cell), structuredClone(ordered[0]));
  return {
    ...geometry,
    properties: {
      kind: 'waymo-coverage',
      name: 'Waymo Phoenix · observert S2-dekning',
      s2CellCount: cells.length,
      waymoMiles: cells.reduce((sum, cell) => sum + cell.properties.waymoMiles, 0),
      osmComplexity: null, complexityColor: '#718087'
    }
  };
}

function waymoCellAt(point, index) {
  return complexityCandidates(point, index).find(cell => turf.booleanPointInPolygon(point, cell)) || null;
}

function waymoCoverageKml(coverage) {
  if (!coverage) throw new Error('Waymo-dekningen er ikke lastet.');
  const namespace = 'http://www.opengis.net/kml/2.2';
  const xml = document.implementation.createDocument(namespace, 'kml');
  const create = name => xml.createElementNS(namespace, name);
  const documentNode = create('Document'), documentName = create('name'), placemark = create('Placemark'), name = create('name'), description = create('description');
  documentName.textContent = coverage.properties.name;
  name.textContent = 'Waymo Phoenix · observert S2-dekning';
  description.textContent = coverage.properties.s2CellCount + ' S2-celler · ' + Math.round(coverage.properties.waymoMiles).toLocaleString('en-US') + ' Waymo RO miles. Observert kjøredekning i CSV4, ikke en offisiell driftsgrense.';
  placemark.append(name, description);
  const polygonFromRings = rings => {
    const polygon = create('Polygon');
    rings.forEach((coordinates, index) => {
      const boundary = create(index === 0 ? 'outerBoundaryIs' : 'innerBoundaryIs');
      const ring = create('LinearRing'), points = create('coordinates');
      points.textContent = coordinates.map(point => point.slice(0, 2).join(',') + ',0').join(' ');
      ring.append(points); boundary.append(ring); polygon.append(boundary);
    });
    return polygon;
  };
  const polygons = coverage.geometry.type === 'Polygon' ? [coverage.geometry.coordinates] : coverage.geometry.coordinates;
  if (polygons.length === 1) {
    placemark.append(polygonFromRings(polygons[0]));
  } else {
    const multiGeometry = create('MultiGeometry');
    polygons.forEach(rings => multiGeometry.append(polygonFromRings(rings)));
    placemark.append(multiGeometry);
  }
  documentNode.append(documentName, placemark); xml.documentElement.append(documentNode);
  return new XMLSerializer().serializeToString(xml);
}

async function updateWaymoOsmMetrics() {
  if ((!app.waymoVisible && !app.waymoCellDetailsVisible) || !app.waymoCells.length || !app.engine?.map.isStyleLoaded()) return;
  let detailData = null, detailBox = null;
  if (app.engine.map.getZoom() >= 13) {
    app.waymoOsmRequest?.abort();
    const controller = new AbortController(); app.waymoOsmRequest = controller;
    detailBox = viewportBox();
    try { detailData = await loadOsmMapFeatures(detailBox, controller.signal); }
    catch (error) { if (controller.signal.aborted) return; toast('OSM-detaljer: ' + error.message); }
    if (controller.signal.aborted || (!app.waymoVisible && !app.waymoCellDetailsVisible)) return;
  }
  const cellIndex = complexityIndex(app.waymoCells), metrics = new Map();
  const ensure = cell => {
    if (!metrics.has(cell.properties.s2CellId)) metrics.set(cell.properties.s2CellId, {
      roadKm: 0, weightedRoadKm: 0, majorRoadKm: 0, cycleLaneKm: 0, cyclewayKm: 0, tramKm: 0, tunnelKm: 0, rampKm: 0,
      namedJunctions: new Set(), roadJunctions: new Set(), signals: new Set(), crossings: new Set(), signalizedCrossings: new Set()
    });
    return metrics.get(cell.properties.s2CellId);
  };
  const roadWeights = { motorway: 4, motorway_link: 3.5, trunk: 3.5, trunk_link: 3, primary: 3, primary_link: 2.5, secondary: 2.5, secondary_link: 2, tertiary: 2, tertiary_link: 1.5, minor: 1.5, residential: 1, unclassified: 1, living_street: 1, road: 1, service: 0.75 };
  const transportation = new Map();
  app.engine.map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' }).forEach(feature => {
    const id = feature.id || JSON.stringify(feature.geometry.coordinates);
    transportation.set(id, feature);
  });
  const osmLines = detailData
    ? [...(detailData.roads || []), ...(detailData.tram || []), ...(detailData.cycleway || [])]
    : [...transportation.values()];
  osmLines.forEach(feature => {
    const properties = feature.properties || {};
    if (!['LineString', 'MultiLineString'].includes(feature.geometry.type)) return;
    turf.flatten(feature).features.forEach(line => {
      const length = turf.length(line);
      if (!(length > 0)) return;
      const steps = Math.max(1, Math.ceil(length / 0.25)), stepLength = length / steps;
      for (let step = 0; step < steps; step++) {
        const point = turf.along(line, (step + 0.5) * stepLength);
        const cell = waymoCellAt(point, cellIndex);
        if (!cell) continue;
        const item = ensure(cell), roadClass = properties.roadClass || properties.highway || properties.class, roadWeight = roadWeights[roadClass];
        if (properties.railway === 'tram' || properties.class === 'transit' && properties.subclass === 'tram') item.tramKm += stepLength;
        else if (properties.cycleType === 'Sykkelfelt i sykkelveg' || properties.class === 'path' && properties.subclass === 'cycleway') item.cyclewayKm += stepLength;
        else if (roadWeight) {
          item.roadKm += stepLength;
          item.weightedRoadKm += stepLength * roadWeight;
          if (['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link'].includes(roadClass)) item.majorRoadKm += stepLength;
          if (detailData && osmCyclewayCategories(properties).lane) item.cycleLaneKm += stepLength;
          if (properties.ramp) item.rampKm += stepLength;
          if (properties.brunnel === 'tunnel' || ['yes', 'building_passage'].includes(properties.tunnel) || properties.covered === 'yes') item.tunnelKm += stepLength;
        }
      }
    });
  });
  if (detailData) {
    const detailBounds = turf.bboxPolygon(detailBox), signalIndex = complexityIndex(detailData.signals || []);
    for (const [sourceKey, targetKey] of [['junctions', 'roadJunctions'], ['signals', 'signals'], ['crossings', 'crossings']]) {
      (detailData[sourceKey] || []).forEach(feature => {
        const cell = waymoCellAt(feature, cellIndex);
        if (!cell || !turf.booleanIntersects(feature, detailBounds)) return;
        const item = ensure(cell), id = String(feature.properties.osm_id || feature.id || JSON.stringify(feature.geometry.coordinates));
        item[targetKey].add(id);
        if (sourceKey === 'crossings' && (feature.properties.signalized || nearestComplexityFeature(feature, signalIndex, 10))) item.signalizedCrossings.add(id);
      });
    }
  } else {
    app.engine.map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation_name' })
      .filter(feature => feature.properties?.subclass === 'junction' && feature.geometry.type === 'Point')
      .forEach(feature => {
        const cell = waymoCellAt(feature, cellIndex);
        if (cell) ensure(cell).namedJunctions.add(String(feature.id || JSON.stringify(feature.geometry.coordinates)));
      });
  }
  const values = [];
  const detailLoadedBounds = (detailData?.osmLoadedBoxes || []).map(box => turf.bboxPolygon(box));
  const detailFailedBounds = (detailData?.osmFailedBoxes || []).map(box => turf.bboxPolygon(box));
  app.waymoCells.forEach(cell => {
    const item = metrics.get(cell.properties.s2CellId);
    const loadedTileCount = detailLoadedBounds.filter(bounds => turf.booleanIntersects(cell, bounds)).length;
    const failedTileCount = detailFailedBounds.filter(bounds => turf.booleanIntersects(cell, bounds)).length;
    const detailRelevant = loadedTileCount + failedTileCount > 0;
    const detailAvailableForCell = loadedTileCount > 0;
    const detailLoadedForCell = detailAvailableForCell && failedTileCount === 0;
    if (!item) {
      Object.assign(cell.properties, {
        osmComplexity: null, complexityColor: '#718087', osmDetailLoaded: detailLoadedForCell,
        osmDetailAvailable: detailAvailableForCell, osmDetailFailedTiles: detailRelevant ? failedTileCount : null,
        osmDetailTileCount: detailRelevant ? loadedTileCount + failedTileCount : null,
        osmRoadJunctions: detailAvailableForCell ? 0 : null, osmSignals: detailAvailableForCell ? 0 : null,
        osmPedestrianCrossings: detailAvailableForCell ? 0 : null, osmSignalizedCrossings: detailAvailableForCell ? 0 : null
      });
      return;
    }
    const areaKm2 = turf.area(cell) / 1e6;
    const junctionCount = item.namedJunctions.size;
    const roadJunctionCount = item.roadJunctions.size, signalCount = item.signals.size;
    const crossingCount = item.crossings.size, signalizedCrossingCount = item.signalizedCrossings.size;
    const uncontrolledCrossings = Math.max(0, crossingCount - signalizedCrossingCount);
    const indicator = areaKm2 > 0 ? (item.weightedRoadKm + junctionCount * 0.3 + roadJunctionCount * 0.5 + uncontrolledCrossings * 0.8 - signalizedCrossingCount * 0.25 + signalCount * 0.1 + item.tramKm * 1.5 + item.rampKm * 0.5 + item.tunnelKm * 0.25) / areaKm2 : null;
    Object.assign(cell.properties, {
      osmComplexity: indicator, osmRoadKm: item.roadKm, osmMajorRoadKm: item.majorRoadKm,
      osmCycleLaneKm: item.cycleLaneKm, osmCyclewayKm: item.cyclewayKm, osmTramKm: item.tramKm, osmTunnelKm: item.tunnelKm,
      osmNamedJunctions: junctionCount, osmRoadJunctions: detailAvailableForCell ? roadJunctionCount : null,
      osmSignals: detailAvailableForCell ? signalCount : null, osmPedestrianCrossings: detailAvailableForCell ? crossingCount : null,
      osmSignalizedCrossings: detailAvailableForCell ? signalizedCrossingCount : null, osmDetailLoaded: detailLoadedForCell,
      osmDetailAvailable: detailAvailableForCell, osmDetailFailedTiles: detailRelevant ? failedTileCount : null,
      osmDetailTileCount: detailRelevant ? loadedTileCount + failedTileCount : null
    });
    if (Number.isFinite(indicator)) values.push(indicator);
  });
  values.sort((a, b) => a - b);
  const quantile = fraction => values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))] || 0;
  const breaks = [quantile(0.25), quantile(0.5), quantile(0.75)];
  app.waymoCells.forEach(cell => {
    const value = cell.properties.osmComplexity;
    const index = Number.isFinite(value) ? breaks.findIndex(limit => value <= limit) : -1;
    cell.properties.complexityColor = index < 0 ? (Number.isFinite(value) ? '#b13543' : '#718087') : ['#08775e', '#d28a2f', '#c4553c'][index];
  });
  waymoMileageColors(app.waymoCells);
  app.engine.setGeoJSON('waymo-miles', app.waymoCells, '#6db69a', 'waymo');
  app.engine.visible('waymo-miles', app.waymoCellDetailsVisible);
  app.waymoCoverage.properties.osmComplexity = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  app.waymoCoverage.properties.osmRoadKm = app.waymoCells.reduce((sum, cell) => sum + (cell.properties.osmRoadKm || 0), 0);
  app.waymoCoverage.properties.osmNamedJunctions = app.waymoCells.reduce((sum, cell) => sum + (cell.properties.osmNamedJunctions || 0), 0);
  const hasLoadedDetailTiles = detailLoadedBounds.length > 0;
  app.waymoCoverage.properties.osmRoadJunctions = hasLoadedDetailTiles ? app.waymoCells.reduce((sum, cell) => sum + (cell.properties.osmRoadJunctions || 0), 0) : null;
  app.waymoCoverage.properties.osmSignals = hasLoadedDetailTiles ? app.waymoCells.reduce((sum, cell) => sum + (cell.properties.osmSignals || 0), 0) : null;
  app.waymoCoverage.properties.osmPedestrianCrossings = hasLoadedDetailTiles ? app.waymoCells.reduce((sum, cell) => sum + (cell.properties.osmPedestrianCrossings || 0), 0) : null;
  app.waymoCoverage.properties.osmSignalizedCrossings = hasLoadedDetailTiles ? app.waymoCells.reduce((sum, cell) => sum + (cell.properties.osmSignalizedCrossings || 0), 0) : null;
  app.waymoCoverage.properties.osmDetailFailedTiles = detailData?.osmFailedTiles ?? null;
  app.waymoCoverage.properties.osmDetailTileCount = detailData?.osmTileCount ?? null;
  app.waymoCoverage.properties.osmDetailAvailable = hasLoadedDetailTiles;
  app.waymoCoverage.properties.complexityColor = Number.isFinite(app.waymoCoverage.properties.osmComplexity)
    ? ['#08775e', '#d28a2f', '#c4553c'][breaks.findIndex(limit => app.waymoCoverage.properties.osmComplexity <= limit) < 0 ? 2 : breaks.findIndex(limit => app.waymoCoverage.properties.osmComplexity <= limit)]
    : '#718087';
  app.engine.setGeoJSON('waymo-coverage', [app.waymoCoverage], '#477e6b', 'waymo-coverage');
  app.engine.visible('waymo-coverage', app.waymoVisible);
}

async function loadWaymoPhoenix(file) {
  if (app.waymoLoading) return;
  if (app.waymoCells.length) {
    app.waymoVisible = !app.waymoVisible;
    app.engine.visible('waymo-coverage', app.waymoVisible);
    byId('waymoLegend').hidden = !app.waymoVisible && !app.waymoCellDetailsVisible;
    app.waymoButton?.setAttribute('aria-pressed', String(app.waymoVisible));
    if (app.waymoVisible) app.engine.map.fitBounds([[app.waymoBounds[0], app.waymoBounds[1]], [app.waymoBounds[2], app.waymoBounds[3]]], { padding: 48, maxZoom: 12.5, duration: 900 });
    return;
  }
  if (!file && location.protocol === 'file:') { byId('waymoFile').click(); return; }
  app.waymoLoading = true;
  app.waymoButton?.classList.add('loading');
  if (app.waymoButton) app.waymoButton.disabled = true;
  setStatus('mapStatus', 'Laster Waymo S2-celler …');
  try {
    const csvUrl = location.protocol === 'file:' ? new URL(encodeURIComponent(WAYMO_CSV_FILE), location.href) : new URL('/waymo-data.csv', location.href);
    const text = file ? await file.text() : await fetch(csvUrl).then(response => {
      if (!response.ok) throw new Error('CSV-filen kunne ikke hentes (HTTP ' + response.status + ').');
      return response.text();
    });
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    if (parsed.errors.length) throw new Error('CSV-filen kunne ikke leses.');
    app.waymoS2Promise ||= import('https://esm.sh/nodes2ts@4.0.2?bundle').catch(error => { app.waymoS2Promise = null; throw error; });
    const { S2CellId, S2Cell } = await app.waymoS2Promise;
    app.waymoCells = parseWaymoCells(parsed.data, S2CellId, S2Cell);
    if (!app.waymoCells.length) throw new Error('Fant ingen Arizona/Maricopa S2-celler i CSV-filen.');
    app.waymoCoverage = combineWaymoCoverage(app.waymoCells);
    app.waymoBounds = turf.bbox(turf.featureCollection(app.waymoCells));
    app.waymoVisible = true;
    app.waymoCellDetailsVisible = false;
    byId('waymoLegend').hidden = false;
    waymoMileageColors(app.waymoCells);
    app.engine.setGeoJSON('waymo-miles', app.waymoCells, '#6db69a', 'waymo');
    app.engine.visible('waymo-miles', false);
    app.engine.setGeoJSON('waymo-coverage', [app.waymoCoverage], '#477e6b', 'waymo-coverage');
    app.engine.visible('waymo-coverage', true);
    if (app.waymoKmlButton) app.waymoKmlButton.disabled = false;
    if (app.waymoCellsButton) app.waymoCellsButton.disabled = false;
    app.engine.onFeature('waymo-miles', (feature, coordinates) => {
      const properties = feature.properties, crashes = properties.benchmarkCrashes.police_reported;
      showProperties('Waymo · Phoenix S2-celle', {
        'Waymo RO miles': Math.round(properties.waymoMiles).toLocaleString('en-US'),
        'Benchmark · police reported': crashes === undefined ? 'Ikke tilgjengelig' : Number(crashes).toFixed(1),
        'OSM-kompleksitetsindikator': Number.isFinite(properties.osmComplexity) ? properties.osmComplexity.toFixed(2) : 'OSM-data ikke lastet for cellen',
        'OSM-veilengde': Number.isFinite(properties.osmRoadKm) ? properties.osmRoadKm.toFixed(1) + ' km' : null,
        'OSM-veikryss': properties.osmNamedJunctions ?? null,
        'OSM-vegkryss, detalj': properties.osmRoadJunctions ?? 'Ingen tilgjengelige OSM-detaljer',
        'OSM-lyskryss': properties.osmSignals ?? 'Ingen tilgjengelige OSM-detaljer',
        'OSM-gangfelt': properties.osmPedestrianCrossings ?? 'Ingen tilgjengelige OSM-detaljer',
        'Lysregulerte OSM-gangfelt': properties.osmSignalizedCrossings ?? 'Ingen tilgjengelige OSM-detaljer',
        'OSM-flisedekning': properties.osmDetailTileCount === null ? 'Detaljer ikke lastet' : properties.osmDetailAvailable ? (properties.osmDetailLoaded ? 'Komplett' : 'Delvis') + ' · ' + properties.osmDetailFailedTiles + ' av ' + properties.osmDetailTileCount + ' fliser manglet' : 'Alle relevante OSM-fliser manglet',
        'OSM-sykkelvei': Number.isFinite(properties.osmCyclewayKm) ? properties.osmCyclewayKm.toFixed(1) + ' km' : null,
        'S2 Cell ID': properties.s2CellId
      }, coordinates);
    });
    app.engine.onFeature('waymo-coverage', (feature, coordinates) => showProperties('Waymo Phoenix · samlet område', {
      'Waymo RO miles': Math.round(feature.properties.waymoMiles).toLocaleString('en-US'),
      'S2-celler': feature.properties.s2CellCount,
      'OSM-kompleksitetsindikator': Number.isFinite(feature.properties.osmComplexity) ? feature.properties.osmComplexity.toFixed(2) : 'OSM-data ikke lastet',
      'OSM-veilengde i innlastede tiles': Number.isFinite(feature.properties.osmRoadKm) ? feature.properties.osmRoadKm.toFixed(1) + ' km' : null,
      'Registrerte OSM-veikryss': feature.properties.osmNamedJunctions ?? null,
      'OSM-vegkryss i innlastet detaljutsnitt': feature.properties.osmRoadJunctions ?? (feature.properties.osmDetailTileCount === null ? 'Zoom inn for OSM-detaljer' : 'Ingen tilgjengelige OSM-detaljer'),
      'OSM-lyskryss i innlastet detaljutsnitt': feature.properties.osmSignals ?? (feature.properties.osmDetailTileCount === null ? 'Zoom inn for OSM-detaljer' : 'Ingen tilgjengelige OSM-detaljer'),
      'OSM-gangfelt i innlastet detaljutsnitt': feature.properties.osmPedestrianCrossings ?? (feature.properties.osmDetailTileCount === null ? 'Zoom inn for OSM-detaljer' : 'Ingen tilgjengelige OSM-detaljer'),
      'Lysregulerte OSM-gangfelt': feature.properties.osmSignalizedCrossings ?? (feature.properties.osmDetailTileCount === null ? 'Zoom inn for OSM-detaljer' : 'Ingen tilgjengelige OSM-detaljer'),
      'OSM-fliser som manglet': feature.properties.osmDetailFailedTiles === null ? 'Zoom inn for detaljer' : feature.properties.osmDetailFailedTiles + ' av ' + feature.properties.osmDetailTileCount,
      Avgrensning: 'Observert CSV-dekning, ikke offisiell Waymo-driftsgrense'
    }, coordinates));
    app.waymoButton?.setAttribute('aria-pressed', 'true');
    app.engine.map.fitBounds([[app.waymoBounds[0], app.waymoBounds[1]], [app.waymoBounds[2], app.waymoBounds[3]]], { padding: 48, maxZoom: 12.5, duration: 1100 });
    await new Promise(resolve => app.engine.map.once('idle', resolve));
    updateWaymoOsmMetrics();
    const totalMiles = app.waymoCells.reduce((sum, feature) => sum + feature.properties.waymoMiles, 0);
    toast(app.waymoCells.length.toLocaleString('en-US') + ' Phoenix S2-celler · ' + Math.round(totalMiles).toLocaleString('en-US') + ' Waymo miles. OSM-veistruktur er en proxy.');
  } catch (error) {
    toast('Waymo Phoenix: ' + error.message);
  } finally {
    app.waymoLoading = false;
    app.waymoButton?.classList.remove('loading');
    if (app.waymoButton) app.waymoButton.disabled = false;
  }
}

function setupWaymoMapControl() {
  const control = {
    onAdd() {
      const container = document.createElement('div');
      container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
      const button = element('button', undefined, 'waymo-map-control');
      button.type = 'button'; button.title = 'Vis samlet Waymo-dekning i Phoenix';
      button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', 'false');
      const icon = document.createElement('i'); icon.dataset.lucide = 'map-pin'; button.append(icon);
      button.onclick = () => loadWaymoPhoenix();
      const exportButton = document.createElement('button');
      exportButton.type = 'button'; exportButton.className = 'waymo-map-control waymo-kml-control';
      exportButton.title = 'Last ned observert Phoenix-dekning som KML';
      exportButton.setAttribute('aria-label', exportButton.title); exportButton.disabled = true;
      const exportIcon = document.createElement('i'); exportIcon.dataset.lucide = 'download'; exportButton.append(exportIcon);
      const cellsButton = document.createElement('button');
      cellsButton.type = 'button'; cellsButton.className = 'waymo-map-control waymo-cells-control';
      cellsButton.title = 'Vis Waymo miles per S2-celle'; cellsButton.setAttribute('aria-label', cellsButton.title); cellsButton.setAttribute('aria-pressed', 'false'); cellsButton.disabled = true;
      const cellsIcon = document.createElement('i'); cellsIcon.dataset.lucide = 'grid-2x2'; cellsButton.append(cellsIcon);
      cellsButton.onclick = () => {
        app.waymoCellDetailsVisible = !app.waymoCellDetailsVisible;
        app.engine.visible('waymo-miles', app.waymoCellDetailsVisible);
        cellsButton.setAttribute('aria-pressed', String(app.waymoCellDetailsVisible));
        byId('waymoLegend').hidden = !app.waymoVisible && !app.waymoCellDetailsVisible;
      };
      exportButton.onclick = () => { if (app.waymoCoverage) download('waymo-phoenix-observed-coverage.kml', waymoCoverageKml(app.waymoCoverage), 'application/vnd.google-earth.kml+xml'); };
      container.append(button, cellsButton, exportButton); this.container = container; app.waymoButton = button; app.waymoCellsButton = cellsButton; app.waymoKmlButton = exportButton;
      if (globalThis.lucide) lucide.createIcons();
      return container;
    },
    onRemove() { this.container?.remove(); app.waymoButton = null; app.waymoCellsButton = null; app.waymoKmlButton = null; }
  };
  app.engine.map.addControl(control, 'top-right');
}

function setupSearch() {
  let timer, sequence = 0;
  byId('search').oninput = () => {
    clearTimeout(timer); stopRequest('search');
    const token = ++sequence, query = byId('search').value.trim();
    byId('searchResults').replaceChildren();
    if (query.length < 3) return;
    timer = setTimeout(async () => {
      const controller = new AbortController(); app.requests.set('search', controller);
      try {
        const data = await requestJSON('https://ws.geonorge.no/adresser/v1/sok?sok=' + encodeURIComponent(query) + '&treffPerSide=5', {}, controller.signal);
        if (controller.signal.aborted || token !== sequence) return;
        const addresses = data.adresser || [];
        addresses.forEach(address => {
          const button = element('button', address.adressetekst + ', ' + address.poststed);
          button.onclick = () => { app.engine.map.flyTo({ center: [address.representasjonspunkt.lon, address.representasjonspunkt.lat], zoom: 16, duration: 1200 }); byId('search').value = address.adressetekst; byId('searchResults').replaceChildren(); };
          byId('searchResults').append(button);
        });
        if (!addresses.length) byId('searchResults').append(element('p', 'Ingen adressetreff.', 'note'));
      } catch (error) { if (!controller.signal.aborted) toast('Adressesøk: ' + error.message); }
    }, 400);
  };
  document.addEventListener('click', event => { if (!event.target.closest('#searchwrap')) byId('searchResults').replaceChildren(); });
}

function setupControls() {
  byId('panelHide').onclick = () => { byId('app').classList.add('collapsed'); app.engine.map.resize(); };
  byId('panelOpen').onclick = () => { byId('app').classList.remove('collapsed'); app.engine.map.resize(); };
  document.querySelectorAll('[data-tab]').forEach(button => { button.onclick = () => setTab(button.dataset.tab); });
  byId('view2d').onclick = () => { app.engine.view3d(false); byId('view2d').classList.add('active'); byId('view3d').classList.remove('active'); };
  byId('view3d').onclick = () => { app.engine.view3d(true); byId('view3d').classList.add('active'); byId('view2d').classList.remove('active'); };
  byId('terrain').onclick = () => { const enabled = byId('terrain').classList.toggle('active'); byId('terrain').setAttribute('aria-pressed', String(enabled)); app.engine.terrain(enabled); };
  byId('refresh').onclick = () => refreshViewport(true);
  byId('roadComplexityRefresh').onclick = () => {
    const currentKey = dataBox().map(value => value.toFixed(4)).join(',');
    const resumePartial = app.complexityDatasets?.osmFailedTiles > 0 && app.complexitySnapshotKey === currentKey;
    loadRoadComplexity(!resumePartial);
  };
  byId('waymoFile').onchange = event => loadWaymoPhoenix(event.target.files[0]);
  byId('roadComplexity').onchange = () => {
    app.complexityEnabled = byId('roadComplexity').checked;
    byId('complexityFactors').hidden = !app.complexityEnabled;
    byId('roadComplexity').setAttribute('aria-expanded', String(app.complexityEnabled));
    if (app.complexityEnabled) {
      const hasSnapshot = Boolean(app.complexitySnapshotKey && app.engine.map.getSource('road-complexity'));
      app.engine.visible('road-complexity', hasSnapshot);
      if (hasSnapshot) renderComplexitySnapshot();
      else loadRoadComplexity();
    }
    else { stopRequest('road-complexity'); app.engine.visible('road-complexity', false); renderComplexityFactorOverlays(); setStatus('roadComplexityStatus', 'av'); }
  };
  byId('drawArea').onclick = startDrawArea;
  byId('finishDraw').onclick = finishDrawing;
  byId('cancelDraw').onclick = cancelDrawing;
  byId('waypointMode').onclick = () => setWaypointMode(!app.waypointMode);
  byId('calculateRoute').onclick = calculateRoute; byId('clearWaypoints').onclick = clearWaypoints;
  byId('exportJson').onclick = exportGeoJSON; byId('exportKml').onclick = exportKml;
  byId('geometryFile').onchange = event => importGeometry(event.target.files[0]);
  byId('closeInspector').onclick = () => { stopRequest('departures'); stopRequest('line'); byId('inspector').hidden = true; app.engine.clear('transit-line'); };
  byId('clearAll').onclick = () => { setWaypointMode(false); clearWaypoints(); [...app.drawings.keys()].forEach(deleteDrawing); app.engine.draw.deleteAll(); byId('drawbar').hidden = true; toast('Alle tegninger fjernet.'); };
  document.querySelectorAll('[data-live]').forEach(input => {
    input.onchange = () => {
      const key = input.dataset.live; app.live[key] = input.checked;
      if (input.checked) { if (key === 'stops') loadStops(); else loadVehicles(); }
      else { stopRequest(key); app.engine.visible(key, false); if (key === 'vehicles') app.engine.visible('vehicle-points', false); setStatus(key + 'Status', 'av'); }
    };
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { setWaypointMode(false); byId('drawbar').hidden = true; } });
  setupSearch();
}

async function startApp() {
  icons(); renderComplexityControls();
  try {
    if (!globalThis.maplibregl || !globalThis.MapboxDraw) throw new Error('Kartbibliotekene kunne ikke lastes. Kontroller nettforbindelsen.');
    app.engine = new AvMapEngine('map');
    app.engine.map.getContainer().addEventListener('av-map-fallback', () => setStatus('mapStatus', 'Vektorkart utilgjengelig · laster reservekart …'), { once: true });
    await app.engine.ready;
    app.ready = true; setupControls(); setupWaymoMapControl(); renderDrawings();
    const map = app.engine.map;
    map.on('moveend', () => {
      clearTimeout(viewportTimer); viewportTimer = setTimeout(refreshViewport, 450); updateComplexitySnapshotStatus();
      const detailMode = map.getZoom() >= 14.2;
      if (app.complexityEnabled && app.complexityFeatures.length && detailMode !== app.complexityDetailMode) renderComplexitySnapshot();
      setStatus('mapStatus', map.getCenter().lat.toFixed(4) + ' N · ' + map.getCenter().lng.toFixed(4) + ' Ø · zoom ' + map.getZoom().toFixed(1));
      if (app.waymoVisible) { clearTimeout(waymoOsmTimer); waymoOsmTimer = setTimeout(() => map.once('idle', updateWaymoOsmMetrics), 250); }
    });
    map.on('click', event => { if (app.waypointMode) addWaypoint(event.lngLat); });
    map.on('draw.create', event => {
      event.features.forEach(feature => {
        const item = { id: feature.id, name: (feature.geometry.type === 'Polygon' ? 'Driftsområde ' : 'Rutekandidat ') + (app.drawings.size + 1), feature, source: 'Manuelt tegnet trasé', stats: null, loading: false, error: null };
        app.drawings.set(item.id, item); app.selectedId = item.id;
        app.scopeId = item.id;
        if (feature.geometry.type === 'LineString') analyzeRoute(item);
      });
      syncDataScope(); byId('drawbar').hidden = true; renderDrawings();
    });
    map.on('draw.update', event => {
      event.features.forEach(feature => {
        const item = app.drawings.get(feature.id); if (!item) return;
        item.feature = feature; item.source = 'Manuelt redigert trasé'; item.analyzedAt = null; item.visibleSpeeds = [];
        app.scopeId = item.id;
        if (feature.geometry.type === 'LineString') analyzeRoute(item);
      });
      syncDataScope(); renderDrawings();
    });
    map.on('draw.delete', event => { event.features.forEach(feature => deleteDrawing(feature.id)); });
    map.on('draw.selectionchange', event => {
      app.selectedId = event.features[0]?.id || null;
      if (app.selectedId) {
        app.scopeId = app.selectedId;
        const selected = app.drawings.get(app.selectedId);
        if (['Polygon', 'MultiPolygon'].includes(selected?.feature.geometry.type)) app.engine.fit(selected.feature);
      }
      syncDataScope(); renderDrawings();
    });
    map.on('error', event => console.warn('Kartressurs:', event.error?.message));
    new ResizeObserver(() => map.resize()).observe(byId('main'));
    setStatus('mapStatus', app.engine.fallbackUsed ? 'Reservekart · OpenStreetMap' : 'MapLibre GL · OpenFreeMap · Mapterhorn'); refreshViewport();
    setInterval(() => {
      if (document.hidden || !app.live.vehicles) return;
      renderVehicleEstimates();
      const interval = Number(byId('vehicleSync').value);
      if (interval && !app.loadingVehicles && Date.now() - app.lastVehicleCheck >= interval) loadVehicles(true);
    }, 250);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { app.lastViewportKey = null; refreshViewport(); } else ['stops', 'vehicles'].forEach(stopRequest); });
  } catch (error) { setStatus('mapStatus', 'Kartfeil: ' + error.message); toast(error.message); }
}

startApp();