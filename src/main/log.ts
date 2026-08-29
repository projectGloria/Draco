import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getPaths } from './bootstrap/paths.ts'

/**
 * Append-only log. Kept intentionally dumb - the native-messaging host is the
 * component that most needs a log, and it must never write diagnostics to
 * stdout because that channel carries the protocol.
 */

type Level = 'info' | 'warn' | 'error'

let queue: Promise<void> = Promise.resolve()

function write(level: Level, scope: string, message: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}\n`

  if (!import.meta.env?.PROD) {
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    method(`[${scope}] ${message}`)
  }

  // Serialise appends so interleaved writes cannot tear a line in half.
  queue = queue
    .then(async () => {
      const paths = getPaths()
      await mkdir(paths.logs, { recursive: true })
      await appendFile(join(paths.logs, 'main.log'), line, 'utf8')
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
