import { spawn } from 'node:child_process'
import { killTree } from '../proc.ts'

/** Runs a user-configured scanner directly; no command shell sees file names. */
export function scanFile(
  program: string,
  configuredArgs: string[],
  filePath: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('scanner cancelled'))
  const args = scannerArgs(configuredArgs, filePath)

  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    let settled = false
    let timedOut = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    timer.unref?.()

    const onAbort = (): void => killTree(child)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000)
    })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => finish(() => {
      if (timedOut) reject(new Error('scanner timed out'))
      else if (signal?.aborted) reject(new Error('scanner cancelled'))
      else if (code === 0) resolve()
      else reject(new Error(`scanner exited with ${code}: ${stderr.trim()}`))
    }))
  })
}

export function scannerArgs(configuredArgs: string[], filePath: string): string[] {
  const hasPlaceholder = configuredArgs.some((arg) => arg.includes('{file}'))
  const args = configuredArgs.map((arg) => arg.replaceAll('{file}', filePath))
  if (!hasPlaceholder) args.push(filePath)
  return args
}
