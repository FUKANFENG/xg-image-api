param(
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$ruleName = "XG-LAN-TCP-$Port"
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Port $Port"
    $elevated = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    if ($elevated.ExitCode -ne 0) {
        throw "The elevated firewall configuration failed with exit code $($elevated.ExitCode)."
    }
    & netsh.exe advfirewall firewall show rule "name=$ruleName" *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "The firewall rule was not created."
    }
    exit 0
}

& netsh.exe advfirewall firewall delete rule "name=$ruleName" *> $null
& netsh.exe advfirewall firewall add rule `
    "name=$ruleName" `
    dir=in `
    action=allow `
    protocol=TCP `
    "localport=$Port" `
    remoteip=localsubnet `
    profile=private `
    enable=yes *> $null
if ($LASTEXITCODE -ne 0) {
    throw "The firewall rule could not be created."
}
$addresses = Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp,Manual -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress -Unique
Write-Host "局域网访问已开启，端口：$Port"
foreach ($address in $addresses) {
    Write-Host "访问地址：http://${address}:$Port"
}
