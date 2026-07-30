[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$BindAddress = "",
    [ValidateRange(1, 1000)]
    [int]$SearchLimit = 200,
    [string[]]$ComposeFile = @("docker-compose.yml"),
    [switch]$Build,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$envFile = Join-Path $projectRoot ".env"

function Get-DotEnvValue {
    param([Parameter(Mandatory)][string]$Name)

    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
        return ""
    }
    foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) {
            continue
        }
        $separatorIndex = $trimmed.IndexOf("=")
        if ($separatorIndex -lt 1) {
            continue
        }
        $namePart = $trimmed.Substring(0, $separatorIndex)
        $valuePart = $trimmed.Substring($separatorIndex + 1)
        if ($namePart.Trim() -ne $Name) {
            continue
        }
        return $valuePart.Trim().Trim('"').Trim("'")
    }
    return ""
}

function Convert-ToPort {
    param(
        [string]$Value,
        [string]$Source
    )

    $parsed = 0
    if (-not [int]::TryParse($Value, [ref]$parsed) -or $parsed -lt 1024 -or $parsed -gt 65535) {
        throw "$Source must be an integer between 1024 and 65535."
    }
    return $parsed
}

function Get-CurrentAppPort {
    foreach ($containerName in @("chatgpt2api", "chatgpt2api-local")) {
        $published = & docker port $containerName "80/tcp" 2>$null
        if ($LASTEXITCODE -ne 0) {
            continue
        }
        foreach ($line in @($published)) {
            if ([string]$line -match ":(\d+)$") {
                return [int]$Matches[1]
            }
        }
    }
    return 0
}

function Test-PortAvailable {
    param(
        [Parameter(Mandatory)][string]$Address,
        [Parameter(Mandatory)][int]$Candidate,
        [int]$OwnedPort = 0
    )

    if ($OwnedPort -gt 0 -and $Candidate -eq $OwnedPort) {
        return $true
    }

    # On Windows, Docker Desktop/WSL/HTTP forwarding can occasionally allow a
    # second bind attempt even though the port already has an active listener.
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $activeListener = Get-NetTCPConnection `
            -State Listen `
            -LocalPort $Candidate `
            -ErrorAction SilentlyContinue
        if ($activeListener) {
            return $false
        }
    }

    $listener = $null
    try {
        $ipAddress = [Net.IPAddress]::Parse($Address)
        $listener = [Net.Sockets.TcpListener]::new($ipAddress, $Candidate)
        $listener.Server.ExclusiveAddressUse = $true
        $listener.Start()
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $listener) {
            $listener.Stop()
        }
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI was not found. Install or start Docker Desktop first."
}

& docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker Desktop is not running or the Docker engine is unavailable."
}

$resolvedBindAddress = $BindAddress.Trim()
if (-not $resolvedBindAddress) {
    $resolvedBindAddress = [string]$env:XG_HOST_IP
}
if (-not $resolvedBindAddress) {
    $resolvedBindAddress = Get-DotEnvValue "XG_HOST_IP"
}
if (-not $resolvedBindAddress) {
    $resolvedBindAddress = "127.0.0.1"
}
if ($resolvedBindAddress -eq "localhost") {
    $resolvedBindAddress = "127.0.0.1"
}

$parsedAddress = $null
if (
    -not [Net.IPAddress]::TryParse($resolvedBindAddress, [ref]$parsedAddress) -or
    $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork
) {
    throw "BindAddress must be an IPv4 address such as 127.0.0.1 or 0.0.0.0."
}

$portWasExplicit = $false
$requestedPort = 0
if ($Port -ne 0) {
    $requestedPort = Convert-ToPort ([string]$Port) "-Port"
    $portWasExplicit = $true
}
elseif ([string]$env:XG_HOST_PORT) {
    $requestedPort = Convert-ToPort ([string]$env:XG_HOST_PORT) "XG_HOST_PORT"
    $portWasExplicit = $true
}
else {
    $dotEnvPort = Get-DotEnvValue "XG_HOST_PORT"
    if ($dotEnvPort) {
        $requestedPort = Convert-ToPort $dotEnvPort ".env XG_HOST_PORT"
        $portWasExplicit = $true
    }
}

$currentAppPort = Get-CurrentAppPort
if (-not $portWasExplicit -and $currentAppPort -gt 0) {
    # Re-running the script should keep the existing XG endpoint stable.
    $requestedPort = $currentAppPort
}
if ($requestedPort -eq 0) {
    $requestedPort = 18080
}

$selectedPort = 0
$lastCandidate = [Math]::Min(65535, $requestedPort + $SearchLimit - 1)
for ($candidate = $requestedPort; $candidate -le $lastCandidate; $candidate++) {
    if (Test-PortAvailable -Address $resolvedBindAddress -Candidate $candidate -OwnedPort $currentAppPort) {
        $selectedPort = $candidate
        break
    }
}
if ($selectedPort -eq 0) {
    throw "No free port was found from $requestedPort to $lastCandidate."
}

if ($selectedPort -ne $requestedPort) {
    Write-Warning (
        "Port {0} is already occupied. XG will use {1}; the existing service was not stopped or changed." -f
        $requestedPort,
        $selectedPort
    )
}

foreach ($file in $ComposeFile) {
    $resolvedFile = Join-Path $projectRoot $file
    if (-not (Test-Path -LiteralPath $resolvedFile -PathType Leaf)) {
        throw "Compose file not found: $resolvedFile"
    }
}

$displayHost = if ($resolvedBindAddress -in @("0.0.0.0", "127.0.0.1")) { "127.0.0.1" } else { $resolvedBindAddress }
$serviceUrl = "http://${displayHost}:$selectedPort"

if ($DryRun) {
    [pscustomobject]@{
        RequestedPort = $requestedPort
        SelectedPort = $selectedPort
        ExistingContainerPort = $currentAppPort
        BindAddress = $resolvedBindAddress
        Url = $serviceUrl
        ExistingServicesChanged = $false
        DryRun = $true
    }
    return
}

$oldHostPort = [Environment]::GetEnvironmentVariable("XG_HOST_PORT", "Process")
$oldHostIp = [Environment]::GetEnvironmentVariable("XG_HOST_IP", "Process")
$env:XG_HOST_PORT = [string]$selectedPort
$env:XG_HOST_IP = $resolvedBindAddress

try {
    Push-Location $projectRoot
    try {
        $dockerArgs = @("compose")
        foreach ($file in $ComposeFile) {
            $dockerArgs += @("-f", $file)
        }
        $dockerArgs += @("up", "-d")
        if ($Build) {
            $dockerArgs += "--build"
        }
        & docker @dockerArgs
        if ($LASTEXITCODE -ne 0) {
            throw "docker compose up failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    if ($null -eq $oldHostPort) {
        Remove-Item Env:XG_HOST_PORT -ErrorAction SilentlyContinue
    }
    else {
        $env:XG_HOST_PORT = $oldHostPort
    }
    if ($null -eq $oldHostIp) {
        Remove-Item Env:XG_HOST_IP -ErrorAction SilentlyContinue
    }
    else {
        $env:XG_HOST_IP = $oldHostIp
    }
}

Write-Host "[XG] Started without stopping any unrelated service."
Write-Host "[XG] Web: $serviceUrl/"
Write-Host "[XG] API: $serviceUrl/v1"
