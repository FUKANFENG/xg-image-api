param(
    [string]$OutputRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) 'native-dist'),
    [string]$ContainerName = 'chatgpt2api',
    [switch]$SkipWebBuild,
    [switch]$SkipLauncherBuild
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repoRoot = Split-Path -Parent $PSScriptRoot
$version = ([System.IO.File]::ReadAllText((Join-Path $repoRoot 'VERSION'))).Trim()
$packageName = "XG生图-原生便携版-$version-win-x64"
$packageRoot = Join-Path $OutputRoot $packageName
$appRoot = Join-Path $packageRoot 'app'
$pythonSource = Join-Path $env:APPDATA 'uv\python\cpython-3.13-windows-x86_64-none'
$sitePackagesSource = Join-Path $repoRoot '.venv\Lib\site-packages'
$webOutput = Join-Path $repoRoot 'web\out'
$launcherBuildOutput = Join-Path $OutputRoot '.launcher-build'
$launcherOutput = Join-Path $launcherBuildOutput 'ChatGPT2API-LAN-Launcher.exe'

function Copy-DirectoryClean {
    param([string]$Source, [string]$Destination)
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $result = & robocopy $Source $Destination /E /R:2 /W:1 /XD '__pycache__' '.pytest_cache' '.ruff_cache' 2>&1
    if ($LASTEXITCODE -ge 8) {
        throw "复制目录失败：$Source -> $Destination`n$($result -join [Environment]::NewLine)"
    }
}

function Read-DotEnv {
    param([string]$Path)
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $values }
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
        $values[$name] = $value
    }
    return $values
}

function Read-ContainerEnvironment {
    param([string]$Name)
    $values = @{}
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if ($null -eq $docker) { return $values }
    $lines = & docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $Name 2>$null
    if ($LASTEXITCODE -ne 0) { return $values }
    foreach ($line in $lines) {
        $separator = $line.IndexOf('=')
        if ($separator -le 0) { continue }
        $values[$line.Substring(0, $separator)] = $line.Substring($separator + 1)
    }
    return $values
}

function Write-EnvironmentFile {
    param([string]$Path, [hashtable]$Values)
    if (-not $Values.ContainsKey('CHATGPT2API_AUTH_KEY') -or [string]::IsNullOrWhiteSpace([string]$Values['CHATGPT2API_AUTH_KEY'])) {
        throw '缺少必需环境变量：CHATGPT2API_AUTH_KEY'
    }
    if (-not $Values.ContainsKey('CHATGPT2API_ADMIN_PASSWORD') -or [string]::IsNullOrWhiteSpace([string]$Values['CHATGPT2API_ADMIN_PASSWORD'])) {
        # 与服务端现有兼容逻辑一致：未单独配置管理员密码时沿用认证密钥。
        $Values['CHATGPT2API_ADMIN_PASSWORD'] = $Values['CHATGPT2API_AUTH_KEY']
    }
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($name in @('CHATGPT2API_AUTH_KEY', 'CHATGPT2API_ADMIN_PASSWORD', 'MINIMAX_API_KEY')) {
        if ($Values.ContainsKey($name) -and -not [string]::IsNullOrWhiteSpace([string]$Values[$name])) {
            $encoded = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$Values[$name]))
            $lines.Add("${name}_BASE64=$encoded")
        }
    }
    [System.IO.File]::WriteAllLines($Path, $lines, (New-Object System.Text.UTF8Encoding($false)))
}

if (-not (Test-Path -LiteralPath $pythonSource)) { throw "未找到 uv Python 运行时：$pythonSource" }
if (-not (Test-Path -LiteralPath $sitePackagesSource)) { throw "未找到项目依赖：$sitePackagesSource" }

New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
if (Test-Path -LiteralPath $packageRoot) {
    Remove-Item -LiteralPath $packageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null

if (-not $SkipWebBuild) {
    Push-Location (Join-Path $repoRoot 'web')
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败。' }
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path -LiteralPath $webOutput)) { throw "未找到前端构建产物：$webOutput" }

if (-not $SkipLauncherBuild) {
    if (Test-Path -LiteralPath $launcherBuildOutput) {
        Remove-Item -LiteralPath $launcherBuildOutput -Recurse -Force
    }
    $launcherProject = Join-Path $repoRoot 'desktop-launcher\src\ChatGPT2ApiLauncher\ChatGPT2ApiLauncher.csproj'
    & dotnet publish $launcherProject `
        --configuration Release `
        --runtime win-x64 `
        --self-contained:true `
        -p:PublishSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:PublishTrimmed=false `
        --output $launcherBuildOutput
    if ($LASTEXITCODE -ne 0) { throw '桌面启动器构建失败。' }
}
if (-not (Test-Path -LiteralPath $launcherOutput)) { throw "未找到桌面启动器：$launcherOutput" }

foreach ($file in @('main.py', 'VERSION')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $appRoot $file) -Force
}
foreach ($directory in @('api', 'services', 'utils')) {
    Copy-DirectoryClean -Source (Join-Path $repoRoot $directory) -Destination (Join-Path $appRoot $directory)
}
Copy-DirectoryClean -Source $webOutput -Destination (Join-Path $appRoot 'web_dist')
Copy-Item -LiteralPath (Join-Path $repoRoot 'config.json') -Destination (Join-Path $appRoot 'config.json') -Force

$dataRoot = Join-Path $appRoot 'data'
New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
foreach ($file in @('accounts.json', 'auth_keys.json', '.cumulative_total')) {
    $source = Join-Path $repoRoot "data\$file"
    if (-not (Test-Path -LiteralPath $source)) { throw "缺少迁移数据：$source" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $dataRoot $file) -Force
}

Copy-DirectoryClean -Source $pythonSource -Destination (Join-Path $packageRoot 'runtime\python')
Copy-DirectoryClean -Source $sitePackagesSource -Destination (Join-Path $packageRoot 'runtime\python\Lib\site-packages')

Copy-Item -LiteralPath $launcherOutput -Destination (Join-Path $packageRoot 'XG生图桌面版.exe') -Force
Copy-Item -Path (Join-Path $repoRoot 'native-package\*') -Destination $packageRoot -Force

$environment = Read-DotEnv -Path (Join-Path $repoRoot '.env')
$containerEnvironment = Read-ContainerEnvironment -Name $ContainerName
foreach ($name in @('CHATGPT2API_AUTH_KEY', 'CHATGPT2API_ADMIN_PASSWORD', 'MINIMAX_API_KEY')) {
    if ($containerEnvironment.ContainsKey($name) -and -not [string]::IsNullOrWhiteSpace([string]$containerEnvironment[$name])) {
        $environment[$name] = $containerEnvironment[$name]
    } elseif (-not $environment.ContainsKey($name)) {
        $processValue = [Environment]::GetEnvironmentVariable($name, 'Process')
        if (-not [string]::IsNullOrWhiteSpace($processValue)) { $environment[$name] = $processValue }
    }
}
Write-EnvironmentFile -Path (Join-Path $packageRoot '.env') -Values $environment

$forbiddenPaths = @(
    'app\data\images',
    'app\data\image_thumbnails',
    'app\data\image_tasks.db',
    'app\data\image_tasks.json',
    'app\data\image_index.json',
    'app\data\image_tags.json',
    'app\data\inspiration_images',
    'app\data\backups',
    'app\data\logs.jsonl',
    'app\data\files'
)
foreach ($relativePath in $forbiddenPaths) {
    if (Test-Path -LiteralPath (Join-Path $packageRoot $relativePath)) {
        throw "便携包包含禁止迁移的数据：$relativePath"
    }
}

$manifestPath = Join-Path $packageRoot 'SHA256SUMS.txt'
$manifestLines = Get-ChildItem -LiteralPath $packageRoot -Recurse -File |
    Where-Object { $_.FullName -ne $manifestPath -and $_.Name -ne '.env' -and $_.Name -notin @('accounts.json', 'auth_keys.json') } |
    Sort-Object FullName |
    ForEach-Object {
        $relative = $_.FullName.Substring($packageRoot.Length + 1).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $relative"
    }
[System.IO.File]::WriteAllLines($manifestPath, $manifestLines, (New-Object System.Text.UTF8Encoding($false)))

$archivePath = Join-Path $OutputRoot "$packageName.zip"
if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
Compress-Archive -LiteralPath $packageRoot -DestinationPath $archivePath -CompressionLevel Optimal
$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText("$archivePath.sha256", "$archiveHash  $([System.IO.Path]::GetFileName($archivePath))`n", (New-Object System.Text.UTF8Encoding($false)))

$size = (Get-Item -LiteralPath $archivePath).Length
Write-Host "PACKAGE_PATH=$archivePath"
Write-Host "PACKAGE_BYTES=$size"
Write-Host "PACKAGE_SHA256=$archiveHash"
