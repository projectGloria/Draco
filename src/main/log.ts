import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Append-only log. Kept intentionally dumb - the native-messaging host is the
 * component that most needs a log, and it must never write diagnostics to
 * stdout because that channel carries the protocol.
 */

type Level = 'info' | 'warn' | 'error'

let queue: Promise<void> = Promise.resolve()
let logDirectory: string | null = null

/** Configured after Electron is ready; keeping this module Electron-free lets engine tests import it. */
export function setLogDirectory(path: string): void {
  logDirectory = path
}

/** Waits until all queued writes have reached disk. Primarily useful for shutdown and tests. */
export function flushLogs(): Promise<void> {
  return queue
}

function write(level: Level, scope: string, message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}\n`

  if (!import.meta.env?.PROD) {
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    method(`[${scope}] ${message}`)
  }

  // Serialise appends so interleaved writes cannot tear a line in half.
  queue = queue
    .then(async () => {
      if (!logDirectory) return
      await mkdir(logDirectory, { recursive: true })
      await appendFile(join(logDirectory, 'main.log'), line, 'utf8')
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
