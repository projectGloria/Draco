import { spawn } from 'node:child_process'

/** Runs a user-configured scanner directly; no command shell sees file names. */
export function scanFile(
  program: string,
  configuredArgs: string[],
  filePath: string,
  timeoutMs: number
): Promise<void> {
  const args = scannerArgs(configuredArgs, filePath)

  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new Error('scanner timed out')))
    }, timeoutMs)
    timer.unref?.()

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000)
    })
    child.on('error', (error) => finish(() => reject(error)))
    child.on('close', (code) => finish(() => {
      if (code === 0) resolve()
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
