# AV analysis: frontend and data API

## Run locally

Requires Node.js 24 or newer, including npm.

```powershell
npm ci
npm start
```

Open <http://127.0.0.1:3000/>. This serves the frontend and API from the same
origin. No frontend build step is required.

Opening the HTML file directly still bypasses this backend for most external
APIs; OSM map data is requested directly from OpenStreetMap. Use the HTTP URL
to test the proxy and avoid data-API CORS dependencies.

The map uses OpenFreeMap vector tiles by default and starts in 2D with terrain
disabled for smoother rendering. Enable 3D and terrain when needed. If the
vector style fails to start, the app switches to OpenStreetMap raster tiles;
the map status identifies when the fallback is active. Frontend libraries load
with visible progress and retry a second CDN after a timeout or load error, so
a stalled deferred script cannot leave startup silently stuck.

```powershell
npm test
```

Tests use mocked upstream services. They cover client routing, normal requests,
input validation, read-only GraphQL, request/response limits, caching, timeouts,
rate limiting, origin checks and private-file protection.

## Endpoints

| Endpoint | Method | Upstream |
| --- | --- | --- |
| `/api/health` | GET | Local health check |
| `/api/entur/journey-planner` | POST | Entur Journey Planner GraphQL |
| `/api/entur/vehicles` | POST | Entur vehicle GraphQL |
| `/api/nvdb/objects/:type` | GET | NVDB v4 road objects |
| `/api/geonorge/addresses` | GET | Geonorge address search |
| `/api/osrm/route/:coordinates` | GET | OSRM driving routes |

API requests are only accepted from the same browser origin. An arbitrary
upstream URL cannot be supplied. Entur and NVDB client-identification headers
are set on the server; browser credentials and authorization headers are not
forwarded. Redirects from upstream services are rejected.

NVDB traffic accident objects (type 570) are available only for the fixed
2016-2025 date window. The map shows average registered accidents per year in
500 m grid cells at overview zoom and individual records at close zoom. NVDB
describes this object type as primarily covering accidents with personal
injury; the layer is not exposure-adjusted risk.

Physical tram tracks used for complexity are sourced from OSM.

The optional road-complexity overlay uses the same OSM-only method in Oslo,
Phoenix, and other regions. It loads a snapshot when enabled and can be manually
refreshed; panning or zooming does not fetch new data. The app sends bbox-limited
OSM map API in tiles up to 0.06 degrees. A drawn polygon or route limits which
tiles are requested; returned geometry is clipped to the exact analysis scope
before scoring. Route analysis uses the existing 50 m corridor around the drawn
route. Hosted mode sends tile bounds to the backend with POST, avoiding long
browser URLs; the proxy makes a compact OSM map request. Local-file mode makes
that request directly. The map API returns all mapped objects in each bbox, so
removing complexity factors reduces local parsing and scoring but does not
reduce bytes returned by OSM. Large tiles are split if OSM rejects them;
cooldowns stop remaining requests and partial results are marked. For bulk
regional analysis, use a regional OSM extract.

Roughly 100 m road sections are scored from junctions, crossings, signals,
physical tram tracks, tunnels and cycle facilities. Speed limits are shown in a
separate neutral information layer and do not affect the score. Parallel one-way
ways are used as a limited separated-road proxy. Each scoring subcategory has
a locally stored 0-200% weight, defaulting to 100%; changing a weight rescales
the cached segment metrics and updates the map without an OSM request. Speed
limits remain a neutral information layer and are not scored. Traffic volume and collisions
are not mapped consistently enough in OSM for cross-region comparison and are
excluded. Tunnel length is the tagged OSM way length, not an engineering
measurement. OSM cycle lanes and separate cycleways are classified from their
tags; tram tracks count only when a physical OSM `railway=tram` way is within
4 m of the road. Signals within 10 m reduce the crossing contribution. These
are screening indicators, not safety ratings.

Subcategory checkboxes are map filters only; their separate weight sliders
control scoring. At overview zoom, results are aggregated into roughly 220 m cells; at zoom 14.2
and closer, the map switches to individual road sections. OSM coverage and tag
quality can differ between places, so inspect the displayed tag coverage before
comparing scores. NVDB-only Norwegian map layers remain separate and are not
queried by the complexity overlay.

Entur queries are limited to the operations used by this application:
`quaysByBbox`, `quay`, `line`, `serviceJourney` and bounding-box bus positions.
Mutations, introspection, fragments and excessive query complexity are rejected.

## Waymo Phoenix comparison

The map control loads the bundled CSV4 dataset and filters it to Arizona / Maricopa.
Each S2 cell is decoded from its decimal string ID; miles are counted once per
cell because the CSV repeats them across crash outcomes. The displayed cell
coverage is observed mileage coverage, not an official Waymo service boundary.
The primary map and KML export use one dissolved polygon from the observed S2
cells; holes are preserved. A separate map control can show the original cell
grid, whose fill represents Waymo miles. Cell outlines show an OSM road-structure
indicator calculated from road-class-weighted kilometers, junctions, signals,
crossings, tram, ramps and tunnels per S2-cell area; road-class weights range
from 0.75 (service) to 4 (motorway). Signalized crossings are distinguished
from uncontrolled crossings. At zoom 13 and closer, small raw OSM map tiles add
road-intersection nodes, signal nodes and pedestrian crossings to visible
cells. These detailed counts are limited to loaded tiles; cells also report
failed OSM tiles so missing data is not confused with zero crossings. At
overview zoom the map uses loaded vector-tile classes. Separate cycleway length is shown in cell
details but is not part of the indicator. Gray outlines mean no OSM road
features are loaded for that cell. Phoenix mode does not call NVDB. This
view-dependent OSM indicator is separate from the OSM-only road-complexity
layer used in both Phoenix and Oslo. The CSV's
benchmark crash outcomes remain separate from Waymo miles and are not summed
together.
NVDB object types and query parameters are allowlisted. Route requests accept
2 to 25 valid waypoints.

## Caching and limits

- Vehicle responses: 5 seconds.
- Entur departures and journey responses: 15 seconds.
- Entur line geometry and address searches: 1 hour.
- NVDB responses: 5 minutes.
- OSRM routes: 15 minutes.
- Successful OSM map feature tiles: 24 hours in IndexedDB.
- Failed responses and GraphQL errors are not cached.
- Concurrent identical requests share one upstream request.
- Maximum upstream concurrency: 8; maximum request duration: 20 seconds.
- Maximum request JSON: 64 KiB; maximum upstream response: 16 MiB.
- Server cache: at most 128 entries / 32 MiB, in memory.
- API rate limit: 120 requests per minute per client IP.

`X-Proxy-Cache` reports `HIT`, `MISS` or `COALESCED`. API responses carry
`X-Request-ID` for identifying individual requests. Cache and rate-limit state
are process-local and reset on restart. Multiple replicas do not share them.

The existing IndexedDB cache and local bus estimation in the frontend remain
active. A manual frontend refresh can still receive a recently cached server
response within the TTL above.

## Publish

This application needs a Node hosting service, container, VM or app service.
Static-only hosting such as GitHub Pages cannot execute the backend.

Configure the host's install command as `npm ci --omit=dev` and start command as
`npm start`. Serve the whole application at the domain root; forward `/api/*`
to the same Node process. Terminate HTTPS at the hosting platform or reverse
proxy. Preserve the original `Host` header.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listening port |
| `HOST` | `127.0.0.1` | Bind address; use `0.0.0.0` on managed/container hosts |
| `ENTUR_CLIENT_NAME` | `vy-av-analysis` | Deployment-specific Entur client identifier |
| `TRUST_PROXY` | unset | Set to `1` only behind exactly one trusted reverse proxy |

For example, in a PowerShell deployment environment:

```powershell
$env:HOST = '0.0.0.0'
$env:PORT = '3000'
$env:ENTUR_CLIENT_NAME = 'your-organization-av-analysis'
npm start
```

Do not enable `TRUST_PROXY` on a directly exposed Node process: untrusted
forwarded-IP headers can bypass client rate limiting. Match this setting to the
actual proxy topology.

This is a public read-only proxy, not an authentication system. Same-origin
checks are browser protections, not access control against scripts or bots.
Use hosting-level authentication/access restrictions for a private deployment,
and shared rate limiting/caching for a larger multi-instance deployment.

MapLibre vector tiles, terrain, fonts, icons and third-party scripts still load
from their existing providers. This backend proxies the data APIs only; those
asset providers still require network access and appropriate CORS policies.