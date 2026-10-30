// The installed command runs in Electron's GUI-subsystem executable. cmd.exe
// can supply console output but NUL as stdin; reconnect input before loading
// the CLI so its normal interactive-terminal checks and readline work.
const fs = require('node:fs')
const path = require('node:path')
const tty = require('node:tty')

if (process.platform === 'win32' && process.argv.length === 2 && process.stdout.isTTY) {
  if (!process.stdin.isTTY) {
    let fd
    try {
      // Respect file/pipe redirection; only a character-device handle can be
      // Electron's missing console input. This never creates a new console.
      if (fs.fstatSync(0).isCharacterDevice()) {
        fd = fs.openSync('\\\\.\\CONIN$', 'r+')
        const input = new tty.ReadStream(fd)
        Object.defineProperty(process, 'stdin', { configurable: true, value: input })
      }
    } catch {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  // TERM=dumb is sometimes inherited on Windows even with a real VT console.
  // Also supports installed CLI bundles that still check TERM themselves.
  if (process.stdin.isTTY && process.env.TERM === 'dumb') delete process.env.TERM
}

require(path.join(__dirname, '..', 'app.asar', 'out', 'main', 'cli.js'))
