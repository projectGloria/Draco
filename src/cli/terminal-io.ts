import { closeSync, fstatSync, openSync } from 'node:fs'
import { ReadStream } from 'node:tty'

export interface TerminalIO {
  input: NodeJS.ReadStream
  output: NodeJS.WriteStream
  close: () => void
}

/** Electron's GUI executable can inherit NUL as stdin from cmd.exe even
 * though it has an attached console. Open that console's input explicitly.
 * Never replace redirected pipe/file input, or open a new console window. */
export function acquireTerminal(): TerminalIO | null {
  const output = process.stdout
  if (!output.isTTY) return null
  if (process.stdin.isTTY) return { input: process.stdin, output, close: () => {} }
  if (process.platform !== 'win32' || !process.versions.electron) return null
  let fd: number | undefined
  try {
    if (!fstatSync(0).isCharacterDevice()) return null
    // SetConsoleMode (raw input) needs a read/write console handle.
    fd = openSync('\\\\.\\CONIN$', 'r+')
    const input = new ReadStream(fd)
    if (!input.isTTY) { input.destroy(); return null }
    return { input, output, close: () => { input.destroy() } }
  } catch {
    if (fd !== undefined) closeSync(fd)
    return null
  }
}
