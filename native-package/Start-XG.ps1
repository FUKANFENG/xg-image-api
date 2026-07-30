param(
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeDir = Join-Path $root '.runtime'
$python = Join-Path $root 'runtime\python\python.exe'
$appDir = Join-Path $root 'app'
$launcher = Join-Path $root 'XG生图桌面版.exe'
$envFile = Join-Path $root '.env'
$pidFile = Join-Path $runtimeDir 'server.pid'
$stdoutLog = Join-Path $runtimeDir 'server.stdout.log'
$stderrLog = Join-Path $runtimeDir 'server.stderr.log'
$healthUrl = "http://127.0.0.1:$Port/health?format=json"

function Import-DotEnv {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "缺少密钥配置文件：$Path"
    }

    foreach ($line in [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $separator = $trimmed.IndexOf('=')
        if ($separator -le 0) { continue }
        $name = $trimmed.Substring(0, $separator).Trim()
        $value = $trimmed.Substring($separator + 1).Trim()
        if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        if ($name.EndsWith('_BASE64', [System.StringComparison]::Ordinal)) {
            $name = $name.Substring(0, $name.Length - 7)
            try {
                $value = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($value))
            } catch {
                throw "密钥配置项 $name 的 Base64 内容无效。"
            }
        }
        if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$') {
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}

function Test-Health {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 3
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Get-OwnedServerProcess {
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    $storedPid = [int]([System.IO.File]::ReadAllText($pidFile).Trim())
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $storedPid" -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    $expectedPython = [System.IO.Path]::GetFullPath($python)
    if ([string]::IsNullOrWhiteSpace($process.ExecutablePath)) { return $null }
    if (-not [System.IO.Path]::GetFullPath($process.ExecutablePath).Equals($expectedPython, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
    return $process
}

if (-not (Test-Path -LiteralPath $python)) { throw "便携 Python 运行时不完整：$python" }
if (-not (Test-Path -LiteralPath $launcher)) { throw "桌面程序不完整：$launcher" }
if (-not (Test-Path -LiteralPath (Join-Path $appDir 'main.py'))) { throw "应用文件不完整：$appDir" }

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
Import-DotEnv -Path $envFile

$server = Get-OwnedServerProcess
if ($null -eq $server -or -not (Test-Health)) {
    if ($null -ne $server) {
        Stop-Process -Id $server.ProcessId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 300
    }

    Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
    $arguments = @('-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', [string]$Port, '--no-access-log')
    $serverProcess = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $appDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    [System.IO.File]::WriteAllText($pidFile, [string]$serverProcess.Id, [System.Text.Encoding]::ASCII)

    $ready = $false
    for ($attempt = 0; $attempt -lt 90; $attempt++) {
        if ($serverProcess.HasExited) { break }
        if (Test-Health) {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        $details = if (Test-Path -LiteralPath $stderrLog) { (Get-Content -LiteralPath $stderrLog -Tail 20) -join [Environment]::NewLine } else { '未生成错误日志。' }
        throw "XG生图服务启动失败。错误日志：$stderrLog`n$details"
    }
}

Start-Process -FilePath $launcher -ArgumentList @('--server-url', "http://127.0.0.1:$Port") -WorkingDirectory $root | Out-Null
