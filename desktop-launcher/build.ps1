param(
    [switch]$SelfContained = $true
)

$ErrorActionPreference = 'Stop'
$launcherRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $launcherRoot 'src\ChatGPT2ApiLauncher\ChatGPT2ApiLauncher.csproj'
$output = Join-Path $launcherRoot 'dist'

dotnet publish $project `
    --configuration Release `
    --runtime win-x64 `
    --self-contained:$SelfContained `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:PublishTrimmed=false `
    --output $output
