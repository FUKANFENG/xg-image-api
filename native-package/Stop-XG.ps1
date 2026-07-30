$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = [System.IO.Path]::GetFullPath((Join-Path $root 'runtime\python\python.exe'))
$pidFile = Join-Path $root '.runtime\server.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'XG生图服务当前未运行。'
    exit 0
}

$storedPid = [int]([System.IO.File]::ReadAllText($pidFile).Trim())
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $storedPid" -ErrorAction SilentlyContinue
if ($null -ne $process -and -not [string]::IsNullOrWhiteSpace($process.ExecutablePath)) {
    $actualPath = [System.IO.Path]::GetFullPath($process.ExecutablePath)
    if ($actualPath.Equals($python, [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $storedPid -Force
        Write-Host 'XG生图服务已停止。'
    } else {
        throw "PID $storedPid 不属于本便携包，已拒绝终止。"
    }
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
