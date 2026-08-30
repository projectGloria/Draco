<#
.SYNOPSIS
  Registers Draco's native-messaging host with Chrome, Edge, Brave, Opera, Vivaldi and Firefox.

.DESCRIPTION
  Draco does this for itself on every launch (see src/main/bridge/integration.ts), so this script
  is for the case where it cannot: the app will not start, the registration is being inspected, or
  the extension needs to be wired up against a build that is not running.

  It writes the native-messaging manifest to %APPDATA%\Draco and points each browser's HKCU key at
  it. Registration is per-user by design - no elevation, nothing left behind for other accounts.

.PARAMETER AppExe
  The Draco executable the host should start when the app is not running. Defaults to the installed
  copy, falling back to the dev launcher.

.PARAMETER Remove
  Deletes the registry keys and the manifest instead of writing them.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/register-host.ps1
#>

[CmdletBinding()]
param(
  [string]$AppExe,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$HostName = 'com.nihil.draco'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $env:APPDATA 'Draco'
$ManifestPath = Join-Path $DataDir "$HostName.json"
$FirefoxManifestPath = Join-Path $DataDir "$HostName.firefox.json"

# Each browser reads a different key, and all three are Chromium.
$RegistryKeys = @{
  Chrome = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
  Edge   = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
  Brave  = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
  Opera  = "HKCU:\Software\Opera Software\NativeMessagingHosts\$HostName"
  Vivaldi = "HKCU:\Software\Vivaldi\NativeMessagingHosts\$HostName"
  Firefox = "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
}

if ($Remove) {
  foreach ($entry in $RegistryKeys.GetEnumerator()) {
    if (Test-Path $entry.Value) {
      Remove-Item $entry.Value -Recurse -Force
      Write-Output "removed $($entry.Key)"
    }
  }
  if (Test-Path $ManifestPath) {
    Remove-Item $ManifestPath -Force
    Write-Output "removed $ManifestPath"
  }
  if (Test-Path $FirefoxManifestPath) {
    Remove-Item $FirefoxManifestPath -Force
    Write-Output "removed Firefox manifest"
  }
  return
}

# --- The extension ID -------------------------------------------------------
# It is pinned by the "key" field in the manifest, and allowed_origins has to
# match it exactly or Chrome refuses the connection with no useful error.

$ExtensionManifest = Join-Path $RepoRoot 'extension\manifest.json'
if (-not (Test-Path $ExtensionManifest)) {
  throw "No extension manifest at $ExtensionManifest"
}

$extension = Get-Content $ExtensionManifest -Raw | ConvertFrom-Json
if (-not $extension.key) {
  throw 'The extension manifest has no "key". Run: npm run keygen'
}

$der = [Convert]::FromBase64String($extension.key)
$sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($der)

# Chrome's ID is the first 16 bytes of SHA-256(DER), hex-encoded, with 0-9a-f
# mapped onto a-p.
$id = -join ($sha[0..15] | ForEach-Object {
  $hex = '{0:x2}' -f $_
  -join ($hex.ToCharArray() | ForEach-Object {
    [char]([int][char]'a' + [Convert]::ToInt32([string]$_, 16))
  })
})

# --- The host binary and the app it starts ---------------------------------

$HostExe = Join-Path $RepoRoot 'host\draco-host.exe'
if (-not (Test-Path $HostExe)) {
  throw "No host binary at $HostExe. Run: npm run host"
}

if (-not $AppExe) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\draco\Draco.exe'),
    (Join-Path $RepoRoot 'node_modules\electron\dist\electron.exe')
  )
  $AppExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $AppExe) {
  throw 'Could not find Draco.exe; pass -AppExe <path>'
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$utf8NoBom = New-Object System.Text.UTF8Encoding $false

$manifestJson = @{
  name           = $HostName
  description    = 'Draco download manager bridge'
  path           = $HostExe
  type           = 'stdio'
  allowed_origins = @("chrome-extension://$id/")
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($ManifestPath, $manifestJson, $utf8NoBom)

$firefoxManifestJson = @{
  name               = $HostName
  description        = 'Draco download manager bridge'
  path               = $HostExe
  type               = 'stdio'
  allowed_extensions = @('draco@nihil.local')
} | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($FirefoxManifestPath, $firefoxManifestJson, $utf8NoBom)

# The host reads this to know what to launch when the pipe is not answering.
$hostConfigJson = @{ appPath = $AppExe; appArgs = @() } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $DataDir 'host-config.json'), $hostConfigJson, $utf8NoBom)

foreach ($entry in $RegistryKeys.GetEnumerator()) {
  $targetManifest = if ($entry.Key -eq 'Firefox') { $FirefoxManifestPath } else { $ManifestPath }
  New-Item -Path $entry.Value -Force | Out-Null
  Set-ItemProperty -Path $entry.Value -Name '(Default)' -Value $targetManifest
  Write-Output "registered $($entry.Key)"
}

Write-Output ''
Write-Output "extension id : $id"
Write-Output "host         : $HostExe"
Write-Output "app          : $AppExe"
Write-Output "manifest     : $ManifestPath"
Write-Output ''
Write-Output "Load unpacked from: $(Join-Path $RepoRoot 'extension')"
