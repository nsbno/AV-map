# AV-map

## Generate `gtfs.geojson`

The repository includes a GTFS-to-GeoJSON generator:

- Script: `scripts/generate-gtfs.ps1`
- Default source: `https://storage.googleapis.com/marduk-production/outbound/gtfs/rb_sky-aggregated-gtfs.zip`
- Default output: `gtfs.geojson`

Run from repository root:

```powershell
pwsh -File ./scripts/generate-gtfs.ps1
```

If the feed must be provided locally:

```powershell
pwsh -File ./scripts/generate-gtfs.ps1 -InputZipPath /path/to/feed.zip
```

### Output format

`gtfs.geojson` is a GeoJSON `FeatureCollection` with:

- `features` containing:
  - stop features (`Point`) with stop identifiers, names, coordinates, and parent station metadata
  - line features (`LineString`) with route identifiers/names/type and trip/service metadata
- `frequency` containing grouped scheduled-service metadata for line/stop frequency calculations
- top-level metadata (`generated`, `source`, `counts`, `description`)

## Generate `nvdb.geojson`

The NVDB generator fetches speed limits, roundabouts, tunnels, and public-transport hubs for every Bergen bydel. It writes standard GeoJSON, including valid `[longitude, latitude]` coordinates for point objects.

```powershell
pwsh -File ./scripts/generate-nvdb.ps1
```

The script uses `areas.geojson` as its area source and overwrites `nvdb.geojson` by default.
