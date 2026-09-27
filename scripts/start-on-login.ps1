[CmdletBinding()]
param(
    [ValidateRange(60, 900)]
    [int]$StartupTimeoutSeconds = 300
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$dockerDesktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
$dockerCliFallback = Join-Path $env:ProgramFiles "Docker\Docker\resources\bin\docker.exe"
$logDirectory = Join-Path $env:LOCALAPPDATA "XG-Image-Service"
$logPath = Join-Path $logDirectory "startup.log"
$deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-StartupLog {
    param([Parameter(Mandatory)][string]$Message)

    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Resolve-DockerCli {
    $command = Get-Command docker.exe -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }
    if (Test-Path -LiteralPath $dockerCliFallback -PathType Leaf) {
        return $dockerCliFallback
    }
    throw "Docker CLI was not found."
}

function Test-DockerReady {
    param([Parameter(Mandatory)][string]$DockerCli)

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $DockerCli info 2>&1 | Out-Null
        return $LASTEXITCODE -eq 0
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

try {
    Write-StartupLog "Startup requested."
    $dockerCli = Resolve-DockerCli

    if (-not (Test-DockerReady -DockerCli $dockerCli)) {
        if (-not (Test-Path -LiteralPath $dockerDesktop -PathType Leaf)) {
            throw "Docker Desktop was not found at the expected path."
        }
        if (-not (Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue)) {
            Start-Process -FilePath $dockerDesktop -WindowStyle Hidden | Out-Null
            Write-StartupLog "Docker Desktop launch requested."
        }
    }

    while (-not (Test-DockerReady -DockerCli $dockerCli)) {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Docker Desktop did not become ready before the timeout."
        }
        Start-Sleep -Seconds 3
    }

    Push-Location $projectRoot
    try {
        $previousPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            & $dockerCli compose `
                -f "docker-compose.yml" `
                -f "docker-compose.lan.yml" `
                up -d app 2>&1 | Out-Null
            $composeExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousPreference
        }
        if ($composeExitCode -ne 0) {
            throw "docker compose up failed with exit code $composeExitCode."
        }
    }
    finally {
        Pop-Location
    }

    while ($true) {
        $health = (& $dockerCli inspect chatgpt2api --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>$null).Trim()
        if ($health -in @("healthy", "running")) {
            break
        }
        if ($health -eq "unhealthy") {
            throw "The XG container reported an unhealthy state."
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "The XG container did not become healthy before the timeout."
        }
        Start-Sleep -Seconds 3
    }

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $dockerCli update --restart unless-stopped chatgpt2api 2>&1 | Out-Null
        $updateExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($updateExitCode -ne 0) {
        throw "Unable to enforce the container restart policy."
    }

    Write-StartupLog "XG is healthy on the configured Docker port."
    exit 0
}
catch {
    Write-StartupLog ("Startup failed: {0}" -f $_.Exception.Message)
    exit 1
}
