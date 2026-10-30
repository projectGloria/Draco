import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Append-only log. Kept intentionally dumb - the native-messaging host is the
 * component that most needs a log, and it must never write diagnostics to
 * stdout because that channel carries the protocol.
 */

type Level = 'info' | 'warn' | 'error'

let queue: Promise<void> = Promise.resolve()
let logDirectory: string | null = null

/**
 * Append-only was also append-forever. One rollover at a few megabytes keeps
 * the log useful - the tail is the part anybody reads - without ever letting it
 * become the largest file in the profile.
 */
const MAX_LOG_BYTES = 4 * 1024 * 1024
/** Tracked rather than stat'ed per line; the file is only ours to append to. */
let bytesWritten = -1

/**
 * Whether the log directory has been created since it was last set.
 *
 * `mkdir -p` ran before every single appended line, so every log write was two
 * syscalls where one would do - on a promise chain that serialises all of them.
 */
let directoryReady = false

/**
 * Whether lines are echoed to the console as well as the file. On by default
 * outside a production bundle so `npm run dev` shows them; the `draco` CLI runs
 * the unbundled source, where that default would interleave engine internals
 * with its own progress output, so it switches this off unless asked.
 */
let consoleEcho = !import.meta.env?.PROD

export function setLogConsole(enabled: boolean): void {
  consoleEcho = enabled
}

/** Configured after Electron is ready; keeping this module Electron-free lets engine tests import it. */
export function setLogDirectory(path: string): void {
  logDirectory = path
  bytesWritten = -1
  directoryReady = false
}

/** Waits until all queued writes have reached disk. Primarily useful for shutdown and tests. */
export function flushLogs(): Promise<void> {
  return queue
}

function write(level: Level, scope: string, message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}\n`

  if (consoleEcho) {
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    method(`[${scope}] ${message}`)
  }

  // Serialise appends so interleaved writes cannot tear a line in half.
  queue = queue
    .then(async () => {
      if (!logDirectory) return
      if (!directoryReady) {
        await mkdir(logDirectory, { recursive: true })
        directoryReady = true
      }
      const path = join(logDirectory, 'main.log')

      if (bytesWritten < 0) {
        bytesWritten = (await stat(path).catch(() => null))?.size ?? 0
      }
      if (bytesWritten + line.length > MAX_LOG_BYTES) {
        // One generation kept: the previous run's tail is worth having, older
        // than that is not worth the disk.
        await rm(path + '.1', { force: true }).catch(() => {})
        await rename(path, path + '.1').catch(() => {})
        bytesWritten = 0
      }

      await appendFile(path, line, 'utf8')
      bytesWritten += Buffer.byteLength(line, 'utf8')
    })
    .catch(() => {})
}

export function logger(scope: string) {
  return {
    info: (message: string) => write('info', scope, message),
    warn: (message: string) => write('warn', scope, message),
    error: (message: string, err?: unknown) =>
      write('error', scope, err ? `${message}: ${describe(err)}` : message)
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message
  return String(err)
}
