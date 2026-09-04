param(
    [string]$SourceUrl = 'https://storage.googleapis.com/marduk-production/outbound/gtfs/rb_sky-aggregated-gtfs.zip',
    [string]$InputZipPath,
    [string]$OutputPath = (Join-Path $PSScriptRoot '..' 'gtfs.geojson')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Read-GtfsCsv {
    param(
        [System.IO.Compression.ZipArchive]$Archive,
        [string]$Name,
        [bool]$Optional = $false
    )

    $entry = $Archive.GetEntry($Name)
    if (-not $entry) {
        if ($Optional) { return @() }
        throw "Missing required GTFS file: $Name"
    }

    $reader = [System.IO.StreamReader]::new($entry.Open())
    try {
        $content = $reader.ReadToEnd()
        if ([string]::IsNullOrWhiteSpace($content)) { return @() }
        return @($content | ConvertFrom-Csv)
    }
    finally {
        $reader.Dispose()
    }
}

function Parse-Int {
    param([string]$Value)
    $parsed = 0
    if ([int]::TryParse(($Value ?? '').Trim(), [ref]$parsed)) { return $parsed }
    return $null
}

function Parse-Double {
    param([string]$Value)
    $parsed = 0.0
    if ([double]::TryParse(($Value ?? '').Trim(), [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
        return [math]::Round($parsed, 6)
    }
    return $null
}

function Parse-GtfsTimeToSeconds {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }

    $parts = $Value.Split(':')
    if ($parts.Count -ne 3) { return $null }

    $h = Parse-Int $parts[0]
    $m = Parse-Int $parts[1]
    $s = Parse-Int $parts[2]
    if ($null -eq $h -or $null -eq $m -or $null -eq $s) { return $null }
    if ($m -lt 0 -or $m -gt 59 -or $s -lt 0 -or $s -gt 59 -or $h -lt 0) { return $null }

    return ($h * 3600) + ($m * 60) + $s
}

function Format-SecondsToGtfsTime {
    param([int]$TotalSeconds)
    $hours = [int][math]::Floor($TotalSeconds / 3600)
    $minutes = [int][math]::Floor(($TotalSeconds % 3600) / 60)
    $seconds = [int]($TotalSeconds % 60)
    return ('{0:D2}:{1:D2}:{2:D2}' -f $hours, $minutes, $seconds)
}

function Get-TransportType {
    param([string]$RouteType)
    switch ($RouteType) {
        '0' { return 'tram' }
        '2' { return 'train' }
        '3' { return 'localBus' }
        default { return 'localBus' }
    }
}

$tempZip = $null
$downloadedTemp = $false

try {
    if ($InputZipPath) {
        if (-not (Test-Path -LiteralPath $InputZipPath)) {
            throw "InputZipPath does not exist: $InputZipPath"
        }
        $tempZip = (Resolve-Path -LiteralPath $InputZipPath).Path
    }
    else {
        $tempZip = Join-Path ([System.IO.Path]::GetTempPath()) ('av-map-gtfs-' + [guid]::NewGuid() + '.zip')
        Invoke-WebRequest -Uri $SourceUrl -OutFile $tempZip
        $downloadedTemp = $true
    }

    $archive = [System.IO.Compression.ZipFile]::OpenRead($tempZip)
    try {
        $routes = Read-GtfsCsv -Archive $archive -Name 'routes.txt'
        $trips = Read-GtfsCsv -Archive $archive -Name 'trips.txt'
        $shapes = Read-GtfsCsv -Archive $archive -Name 'shapes.txt'
        $stops = Read-GtfsCsv -Archive $archive -Name 'stops.txt'
        $stopTimes = Read-GtfsCsv -Archive $archive -Name 'stop_times.txt'
        $calendar = Read-GtfsCsv -Archive $archive -Name 'calendar.txt' -Optional $true
        $calendarDates = Read-GtfsCsv -Archive $archive -Name 'calendar_dates.txt' -Optional $true

        $routeIndex = @{}
        foreach ($route in $routes) {
            if (-not $route.route_id) { continue }
            $routeIndex[$route.route_id] = $route
        }

        $tripInfo = @{}
        $routeTripsPerDay = @{}
        $shapeTripsPerDay = @{}
        $routeDirectionServiceTripSets = @{}

        foreach ($trip in $trips) {
            if (-not $trip.trip_id -or -not $trip.route_id) { continue }
            if (-not $routeIndex.ContainsKey($trip.route_id)) { continue }

            $route = $routeIndex[$trip.route_id]
            $transportType = Get-TransportType $route.route_type
            $directionId = Parse-Int $trip.direction_id

            $tripInfo[$trip.trip_id] = [ordered]@{
                route_id = $trip.route_id
                service_id = $trip.service_id
                direction_id = $directionId
                shape_id = $trip.shape_id
                trip_headsign = $trip.trip_headsign
                transport_type = $transportType
            }

            $routeTripsPerDay[$trip.route_id] = ($routeTripsPerDay[$trip.route_id] ?? 0) + 1

            if ($trip.shape_id) {
                $shapeTripsPerDay[$trip.shape_id] = ($shapeTripsPerDay[$trip.shape_id] ?? 0) + 1
            }

            $groupKey = "{0}|{1}|{2}" -f $trip.route_id, ($directionId ?? ''), ($trip.service_id ?? '')
            if (-not $routeDirectionServiceTripSets.ContainsKey($groupKey)) {
                $routeDirectionServiceTripSets[$groupKey] = [System.Collections.Generic.HashSet[string]]::new()
            }
            [void]$routeDirectionServiceTripSets[$groupKey].Add($trip.trip_id)
        }

        $shapeRepresentativeTrip = @{}
        foreach ($tripId in ($tripInfo.Keys | Sort-Object)) {
            $shapeId = $tripInfo[$tripId].shape_id
            if (-not $shapeId) { continue }
            if (-not $shapeRepresentativeTrip.ContainsKey($shapeId)) {
                $shapeRepresentativeTrip[$shapeId] = $tripId
            }
        }

        $shapePointMap = @{}
        foreach ($shapeRow in $shapes) {
            $shapeId = $shapeRow.shape_id
            if (-not $shapeId) { continue }
            if (-not $shapeRepresentativeTrip.ContainsKey($shapeId)) { continue }
            if (-not $shapePointMap.ContainsKey($shapeId)) {
                $shapePointMap[$shapeId] = [System.Collections.Generic.List[object]]::new()
            }
            $shapePointMap[$shapeId].Add($shapeRow)
        }

        $features = [System.Collections.Generic.List[object]]::new()

        $stopService = @{}
        $routeStopSets = @{}
        foreach ($stopTime in $stopTimes) {
            if (-not $stopTime.trip_id -or -not $stopTime.stop_id) { continue }
            if (-not $tripInfo.ContainsKey($stopTime.trip_id)) { continue }

            $trip = $tripInfo[$stopTime.trip_id]
            $routeId = $trip.route_id

            if (-not $routeStopSets.ContainsKey($routeId)) {
                $routeStopSets[$routeId] = [System.Collections.Generic.HashSet[string]]::new()
            }
            [void]$routeStopSets[$routeId].Add($stopTime.stop_id)

            $seconds = Parse-GtfsTimeToSeconds $stopTime.departure_time
            if ($null -eq $seconds) {
                $seconds = Parse-GtfsTimeToSeconds $stopTime.arrival_time
            }
            if ($null -eq $seconds) { continue }

            $serviceKey = "{0}|{1}|{2}|{3}" -f $trip.route_id, ($trip.direction_id ?? ''), ($trip.service_id ?? ''), $stopTime.stop_id
            if (-not $stopService.ContainsKey($serviceKey)) {
                $stopService[$serviceKey] = [ordered]@{
                    route_id = $trip.route_id
                    direction_id = $trip.direction_id
                    service_id = $trip.service_id
                    stop_id = $stopTime.stop_id
                    departures = [System.Collections.Generic.List[int]]::new()
                }
            }
            $stopService[$serviceKey].departures.Add($seconds)
        }

        $stopTransportTypes = @{}
        foreach ($group in $stopService.GetEnumerator()) {
            $entry = $group.Value
            $route = $routeIndex[$entry.route_id]
            if (-not $route) { continue }
            $tt = Get-TransportType $route.route_type
            if (-not $stopTransportTypes.ContainsKey($entry.stop_id)) {
                $stopTransportTypes[$entry.stop_id] = [System.Collections.Generic.HashSet[string]]::new()
            }
            [void]$stopTransportTypes[$entry.stop_id].Add($tt)
        }

        foreach ($stop in ($stops | Sort-Object stop_id)) {
            if (-not $stop.stop_id) { continue }
            $lon = Parse-Double $stop.stop_lon
            $lat = Parse-Double $stop.stop_lat
            if ($null -eq $lat -or $null -eq $lon) { continue }

            $transportTypes = @()
            if ($stopTransportTypes.ContainsKey($stop.stop_id)) {
                $transportTypes = @($stopTransportTypes[$stop.stop_id] | Sort-Object)
            }

            $features.Add([ordered]@{
                type = 'Feature'
                id = "stop:$($stop.stop_id)"
                geometry = [ordered]@{
                    type = 'Point'
                    coordinates = @($lon, $lat)
                }
                properties = [ordered]@{
                    feature_kind = 'stop'
                    stop_id = $stop.stop_id
                    stop_name = $stop.stop_name
                    parent_station = if ($stop.parent_station) { $stop.parent_station } else { $null }
                    location_type = Parse-Int $stop.location_type
                    transport_types = $transportTypes
                }
            })
        }

        foreach ($shapeId in ($shapePointMap.Keys | Sort-Object)) {
            $tripId = $shapeRepresentativeTrip[$shapeId]
            if (-not $tripId) { continue }
            $trip = $tripInfo[$tripId]
            if (-not $trip) { continue }
            $route = $routeIndex[$trip.route_id]
            if (-not $route) { continue }

            $coordinates = @(
                $shapePointMap[$shapeId] |
                    Sort-Object { Parse-Int $_.shape_pt_sequence } |
                    ForEach-Object {
                        $lon = Parse-Double $_.shape_pt_lon
                        $lat = Parse-Double $_.shape_pt_lat
                        if ($null -ne $lat -and $null -ne $lon) { ,@($lon, $lat) }
                    }
            )

            if ($coordinates.Count -lt 2) { continue }

            $transportType = Get-TransportType $route.route_type
            $routeId = $trip.route_id

            $features.Add([ordered]@{
                type = 'Feature'
                id = "line:$shapeId"
                geometry = [ordered]@{
                    type = 'LineString'
                    coordinates = $coordinates
                }
                properties = [ordered]@{
                    feature_kind = 'line'
                    route_id = $routeId
                    route_short_name = $route.route_short_name
                    route_long_name = $route.route_long_name
                    route_type = Parse-Int $route.route_type
                    transport_type = $transportType
                    trip_headsign = $trip.trip_headsign
                    direction_id = $trip.direction_id
                    service_id = $trip.service_id
                    shape_id = $shapeId
                    trip_id = $tripId
                    trips_per_day = ($shapeTripsPerDay[$shapeId] ?? 0)
                    route_trips_per_day = ($routeTripsPerDay[$routeId] ?? 0)
                    route_stop_count = if ($routeStopSets.ContainsKey($routeId)) { $routeStopSets[$routeId].Count } else { 0 }
                }
            })
        }

        $routeDirectionService = @(
            foreach ($groupKey in ($routeDirectionServiceTripSets.Keys | Sort-Object)) {
                $parts = $groupKey.Split('|', 3)
                [ordered]@{
                    route_id = $parts[0]
                    direction_id = Parse-Int $parts[1]
                    service_id = if ($parts[2]) { $parts[2] } else { $null }
                    trips_per_day = $routeDirectionServiceTripSets[$groupKey].Count
                }
            }
        )

        $stopFrequency = @(
            foreach ($serviceKey in ($stopService.Keys | Sort-Object)) {
                $entry = $stopService[$serviceKey]
                $departures = @($entry.departures | Sort-Object)
                if (-not $departures.Count) { continue }
                $headways = @()
                for ($i = 1; $i -lt $departures.Count; $i++) {
                    $headways += ($departures[$i] - $departures[$i - 1])
                }

                $avgHeadway = $null
                $minHeadway = $null
                $maxHeadway = $null
                if ($headways.Count -gt 0) {
                    $avgHeadway = [int][math]::Round((($headways | Measure-Object -Average).Average), 0)
                    $minHeadway = [int](($headways | Measure-Object -Minimum).Minimum)
                    $maxHeadway = [int](($headways | Measure-Object -Maximum).Maximum)
                }

                [ordered]@{
                    route_id = $entry.route_id
                    direction_id = $entry.direction_id
                    service_id = $entry.service_id
                    stop_id = $entry.stop_id
                    departure_count = $departures.Count
                    first_departure_time = Format-SecondsToGtfsTime $departures[0]
                    last_departure_time = Format-SecondsToGtfsTime $departures[$departures.Count - 1]
                    headway_secs = $avgHeadway
                    min_headway_secs = $minHeadway
                    max_headway_secs = $maxHeadway
                }
            }
        )

        $serviceCalendar = @{}
        foreach ($row in $calendar) {
            if (-not $row.service_id) { continue }
            $activeDays = @('monday','tuesday','wednesday','thursday','friday','saturday','sunday') |
                ForEach-Object { Parse-Int $row.$_ } |
                Where-Object { $_ -eq 1 }

            $serviceCalendar[$row.service_id] = [ordered]@{
                service_id = $row.service_id
                start_date = $row.start_date
                end_date = $row.end_date
                weekly_active_days = $activeDays.Count
                exception_added_days = 0
                exception_removed_days = 0
            }
        }

        foreach ($row in $calendarDates) {
            if (-not $row.service_id) { continue }
            if (-not $serviceCalendar.ContainsKey($row.service_id)) {
                $serviceCalendar[$row.service_id] = [ordered]@{
                    service_id = $row.service_id
                    start_date = $null
                    end_date = $null
                    weekly_active_days = 0
                    exception_added_days = 0
                    exception_removed_days = 0
                }
            }

            switch ($row.exception_type) {
                '1' { $serviceCalendar[$row.service_id].exception_added_days++ }
                '2' { $serviceCalendar[$row.service_id].exception_removed_days++ }
            }
        }

        $output = [ordered]@{
            type = 'FeatureCollection'
            generated = (Get-Date).ToUniversalTime().ToString('o')
            source = $SourceUrl
            description = 'Aggregert GTFS-data for AV-map. Inneholder stoppesteder, linjegeometri og frekvensgrunnlag fra planlagte avganger.'
            counts = [ordered]@{
                features_total = $features.Count
                stop_features = @($features | Where-Object { $_.properties.feature_kind -eq 'stop' }).Count
                line_features = @($features | Where-Object { $_.properties.feature_kind -eq 'line' }).Count
                route_direction_service_groups = $routeDirectionService.Count
                stop_frequency_groups = $stopFrequency.Count
            }
            frequency = [ordered]@{
                route_direction_service = $routeDirectionService
                stop_service = $stopFrequency
                service_calendar = @($serviceCalendar.Values | Sort-Object service_id)
            }
            features = $features
        }

        $json = $output | ConvertTo-Json -Depth 20
        Set-Content -LiteralPath $OutputPath -Value $json -Encoding utf8NoBOM

        Write-Host "Wrote $($features.Count) features to $OutputPath"
    }
    finally {
        $archive.Dispose()
    }
}
finally {
    if ($downloadedTemp -and $tempZip -and (Test-Path -LiteralPath $tempZip)) {
        Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue
    }
}
