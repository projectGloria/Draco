# Builds the native-messaging host.
#
# -H=windowsgui is deliberately NOT used: Chrome 115+ reads the PE subsystem
# header to decide whether to start the host hidden, and a CONSOLE subsystem
# binary is the one it hides. A GUI-subsystem host would flash a window on
# every download.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $here
try {
    # The Node build entry point provisions a private Go toolchain if needed.
    node (Join-Path $here '../tools/build-host.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Native host build failed' }
    Write-Host "built $here\draco-host.exe"
} finally {
    Pop-Location
}
