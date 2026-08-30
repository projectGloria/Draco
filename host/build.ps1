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
    $env:CGO_ENABLED = '0'
    $env:GOOS = 'windows'
    # -s -w strip the symbol table and DWARF data; this binary is never debugged
    # in the field and the size shows up in every install.
    go build -trimpath -ldflags '-s -w' -o draco-host.exe .
    Write-Host "built $here\draco-host.exe"
} finally {
    Pop-Location
}
