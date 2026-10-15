import { spawn } from 'node:child_process'
import { AbortedError } from './worker.ts'

/** Wait for the process to release its output before cleanup or pause returns. */
export function runConversion(file: string, args: string[], signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new AbortedError())
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let failure: Error | null = null
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192) })
    const onAbort = (): void => {
      try { child.kill('SIGKILL') } catch {}
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.once('error', (error) => { failure = error })
    child.once('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) reject(new AbortedError())
      else if (failure) reject(failure)
      else if (code === 0) resolve()
      else reject(new Error(`ffmpeg conversion failed (${code}): ${stderr.trim() || 'No error details'}`))
    })
    if (signal.aborted) onAbort()
  })
}

export async function convertMedia(input: string, output: string, format: 'mp4' | 'mp3', signal: AbortSignal): Promise<void> {
  const { ensureFfmpeg } = await import('../hls/ffmpeg.ts')
  const file = await ensureFfmpeg()
  const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', input]
  if (format === 'mp4') args.push('-c:v', 'copy', '-c:a', 'copy')
  else args.push('-vn', '-c:a', 'libmp3lame', '-q:a', '2')
  args.push(output)
  await runConversion(file, args, signal)
}
