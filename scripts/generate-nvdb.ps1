param(
    [string]$AreasPath = (Join-Path $PSScriptRoot '..' 'areas.geojson'),
    [string]$OutputPath = (Join-Path $PSScriptRoot '..' 'nvdb.geojson')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$NvdbBaseUrl = 'https://nvdbapiles.atlas.vegvesen.no/vegobjekter/api/v4/vegobjekter'
$NvdbTypes = @(105, 37, 67, 42)
$headers = @{ 'X-Client' = 'AV-map-local-data-export'; Accept = 'application/json' }

function ConvertTo-NvdbCoordinate {
    param([string]$Text)

    $values = @($Text.Trim().Split([char[]]' ', [System.StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object {
        [double]::Parse($_, [System.Globalization.CultureInfo]::InvariantCulture)
    })
    if ($values.Count -lt 2) { return $null }
    return [pscustomobject]@{ lon = $values[1]; lat = $values[0] }
}

function ConvertFrom-NvdbWkt {
    param([string]$Wkt)

    if ([string]::IsNullOrWhiteSpace($Wkt)) { return $null }
    $match = [regex]::Match($Wkt.Trim(), '^(POINT|LINESTRING|MULTILINESTRING)(?:\s+Z)?\s*\((.*)\)$', 'IgnoreCase')
    if (-not $match.Success) { return $null }

    $type = $match.Groups[1].Value.ToUpperInvariant()
    $body = $match.Groups[2].Value
    if ($type -eq 'POINT') {
        $coordinate = ConvertTo-NvdbCoordinate $body
        if ($null -eq $coordinate) { return $null }
        $point = [System.Collections.ArrayList]::new()
        [void]$point.Add($coordinate.lon)
        [void]$point.Add($coordinate.lat)
        return [ordered]@{ type = 'Point'; coordinates = $point }
    }

    $lineStrings = if ($type -eq 'LINESTRING') { @($body) } else { @([regex]::Matches($body, '\(([^()]*)\)') | ForEach-Object { $_.Groups[1].Value }) }
    $lines = [System.Collections.ArrayList]::new()
    foreach ($lineString in $lineStrings) {
        $line = [System.Collections.ArrayList]::new()
        foreach ($positionText in $lineString.Split(',')) {
            $coordinate = ConvertTo-NvdbCoordinate $positionText
            if ($null -ne $coordinate) {
                $position = [System.Collections.ArrayList]::new()
                [void]$position.Add($coordinate.lon)
                [void]$position.Add($coordinate.lat)
                [void]$line.Add($position)
            }
        }
        if ($line.Count -ge 2) { [void]$lines.Add($line) }
    }
    if ($lines.Count -eq 0) { return $null }
    if ($type -eq 'LINESTRING') { return [ordered]@{ type = 'LineString'; coordinates = $lines[0] } }
    return [ordered]@{ type = 'MultiLineString'; coordinates = $lines }
}

function Get-NvdbPolygon {
    param($Geometry)

    $ring = if ($Geometry.type -eq 'Polygon') { @($Geometry.coordinates[0]) } else { @($Geometry.coordinates[0][0]) }
    if ($ring.Count -lt 3) { throw 'Area geometry does not contain a usable exterior ring.' }
    $step = [math]::Max(1, [math]::Ceiling($ring.Count / 39))
    $sampled = @()
    for ($index = 0; $index -lt $ring.Count; $index += $step) { $sampled += ,$ring[$index] }
    if (($sampled[-1][0] -ne $sampled[0][0]) -or ($sampled[-1][1] -ne $sampled[0][1])) { $sampled += ,$sampled[0] }
    $coordinates = ($sampled | ForEach-Object {
        ('{0} {1}' -f ([double]$_[1]).ToString([System.Globalization.CultureInfo]::InvariantCulture), ([double]$_[0]).ToString([System.Globalization.CultureInfo]::InvariantCulture))
    }) -join ','
    return "POLYGON(($coordinates))"
}

$areas = Get-Content -Raw -LiteralPath $AreasPath | ConvertFrom-Json
$features = [System.Collections.Generic.List[object]]::new()

foreach ($area in $areas.features) {
    $bydel = $area.properties.name
    if ([string]::IsNullOrWhiteSpace($bydel)) { continue }
    $polygon = Get-NvdbPolygon $area.geometry

    foreach ($typeId in $NvdbTypes) {
        $url = "$NvdbBaseUrl/$typeId?polygon=$([uri]::EscapeDataString($polygon))&srid=4326&inkluder=egenskaper,geometri&antall=1000"
        while ($url) {
            $page = Invoke-RestMethod -Uri $url -Headers $headers
            foreach ($object in @($page.objekter)) {
                $geometry = ConvertFrom-NvdbWkt $object.geometri.wkt
                if ($null -eq $geometry) { continue }
                $properties = [ordered]@{
                    source = 'NVDB'
                    id = $object.id
                    typeId = $typeId
                    bydel = $bydel
                    egenskaper = @($object.egenskaper | ForEach-Object {
                        [ordered]@{ id = $_.id; name = $_.navn; verdi = $_.verdi }
                    })
                }
                $features.Add([ordered]@{ type = 'Feature'; properties = $properties; geometry = $geometry })
            }
            $url = if ($page.metadata.neste.href) { $page.metadata.neste.href } else { $null }
        }
    }
}

$output = [ordered]@{
    type = 'FeatureCollection'
    generated = (Get-Date).ToUniversalTime().ToString('o')
    source = $NvdbBaseUrl
    types = $NvdbTypes
    description = 'NVDB objects for Bergen bydeler. Coordinates are standard GeoJSON [longitude, latitude].'
    features = $features
}

$output | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Host "Wrote $($features.Count) features to $OutputPath"