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
