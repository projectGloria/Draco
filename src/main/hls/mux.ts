import { spawn, type ChildProcess } from 'node:child_process'
import { rm, stat, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { logger } from '../log.ts'

const log = logger('mux')

/**
 * Remuxes the concatenated stream into its final container.
 *
 * `-c copy` throughout: the bytes that came off the wire are the bytes that end
 * up in the file. Re-encoding a download would take an hour and lose quality to
 * produce something the user did not ask for.
 */

export class MuxError extends Error {}

export interface MuxOptions {
  ffmpegPath: string
  inputPath: string
  audioInputPath?: string
  outputPath: string
  signal: AbortSignal
}

export async function mux(options: MuxOptions): Promise<void> {
  const { ffmpegPath, inputPath, audioInputPath, outputPath, signal } = options

  const args = [
    '-y',
    // ffmpeg reads stdin for interactive keys unless told not to. With stdin
    // left open on a pipe nothing ever writes to, it can sit there waiting -
    // which shows up as a finished download stuck on "Muxing" forever.
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath
  ]

  if (audioInputPath) {
    args.push('-i', audioInputPath, '-map', '0:v', '-map', '1:a')
  } else {
    args.push('-map', '0')
  }

  args.push('-c', 'copy')

  if (outputPath.toLowerCase().endsWith('.mp4')) {
    args.push('-movflags', '+faststart')
  }

  args.push(outputPath)

  await ensureSpaceFor([inputPath, ...(audioInputPath ? [audioInputPath] : [])], outputPath)

  await runFfmpeg(ffmpegPath, args, signal, outputPath)
  log.info(`muxed ${outputPath}`)
}

/**
 * `-c copy` writes a second copy of every byte it was given, so the merge needs
 * as much free space again as the parts already take. Out of space, ffmpeg only
 * says "Invalid argument" on the last line of its log, and the download that
 * did finish looks like it failed - so ask the volume first and say plainly
 * what is missing.
 */
async function ensureSpaceFor(inputs: string[], outputPath: string): Promise<void> {
  let needed = 0
  for (const path of inputs) {
    try {
      needed += (await stat(path)).size
    } catch {
      return
    }
  }

  let free: number
  try {
    const fs = await statfs(dirname(outputPath))
    free = Number(fs.bsize) * Number(fs.bavail)
  } catch {
    return
  }

  if (free >= needed) return
  throw new MuxError(
    `Not enough free space to merge: needs ${formatBytes(needed)}, ` +
      `${formatBytes(free)} free. Free up space and start the download again.`
  )
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  signal: AbortSignal,
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new MuxError('Cancelled'))
      return
    }

    // stdin closed and stdout discarded: only stderr is read, so neither of the
    // other two can fill its pipe buffer and wedge the process.
    const child = spawn(ffmpegPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000)
    })

    const onAbort = (): void => {
      // ffmpeg spawns no children of its own here, but killing the tree is the
      // discipline: a plain kill on Windows can leave a process holding the
      // output file open, and the next attempt then fails to write it.
      killTree(child)
    }
    signal.addEventListener('abort', onAbort, { once: true })

    const done = (fn: () => void): void => {
      signal.removeEventListener('abort', onAbort)
      fn()
    }

    child.on('error', (err) => done(() => reject(new MuxError(err.message))))

    child.on('close', (code) => {
      done(() => {
        if (signal.aborted) {
          // A half-written mp4 is worse than none: it plays for two seconds and
          // looks like a corrupt download rather than a cancelled one.
          void rm(outputPath, { force: true }).catch(() => {})
          reject(new MuxError('Cancelled'))
          return
        }
        if (code === 0) {
          resolve()
          return
        }
        void rm(outputPath, { force: true }).catch(() => {})
        reject(new MuxError(`ffmpeg exited with ${code}: ${stderr.trim().split('\n').pop() ?? ''}`))
      })
    })
  })
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return

  const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
    shell: false,
    windowsHide: true
  })
  killer.on('error', () => child.kill('SIGKILL'))
}
