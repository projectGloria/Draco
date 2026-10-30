import { spawn } from 'node:child_process'
import { readFile, rm, stat, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { logger } from '../log.ts'
import { killTree } from '../proc.ts'

const log = logger('mux')

/**
 * Remuxes the concatenated stream into its final container.
 *
 * `-c copy` throughout: the bytes that came off the wire are the bytes that end
 * up in the file. Re-encoding a download would take an hour and lose quality to
 * produce something the user did not ask for.
 */

/**
 * Task details a runner shows while it builds the final file from pieces it
 * already has. The status stays 'downloading' meanwhile, so these strings are
 * how a caller tells "bytes still arriving" from "local work only" - the CLI's
 * queue starts the next download the moment one of these appears.
 */
export const MUX_DETAIL = 'Muxing…'
export const JOIN_DETAIL = 'Joining pieces…'

export class MuxError extends Error {}

/**
 * One input to the mux.
 *
 * `concatList` is the whole point of P8: an HLS track is a few hundred piece
 * files, and joining them into one file first meant reading every byte back and
 * writing it out again before ffmpeg had even started - a full extra pass over
 * a download that was already finished, with the row sitting at 100% for the
 * duration. ffmpeg's concat demuxer reads the pieces in place, so the join pass
 * disappears entirely and the bytes are read exactly once.
 */
export interface MuxInput {
  path: string
  /** True when `path` is a concat list file rather than a media file. */
  concatList?: boolean
  language?: string | null
  title?: string | null
  isDefault?: boolean
}

export interface MuxOptions {
  ffmpegPath: string
  inputPath: string
  /** Whether `inputPath` is a concat list rather than a single media file. */
  inputIsConcatList?: boolean
  audioInputPath?: string
  audioInputs?: MuxInput[]
  outputPath: string
  signal: AbortSignal
}

/** The `-f concat` preamble one input needs, or nothing for a plain file. */
function inputArgs(input: { path: string; concatList?: boolean }): string[] {
  // `-safe 0` because the list holds absolute paths; the list is written by
  // Draco into its own workspace and never contains anything a server chose.
  return input.concatList ? ['-f', 'concat', '-safe', '0', '-i', input.path] : ['-i', input.path]
}

export async function mux(options: MuxOptions): Promise<void> {
  const { ffmpegPath, inputPath, audioInputPath, outputPath, signal } = options
  const audioInputs: MuxInput[] =
    options.audioInputs ?? (audioInputPath ? [{ path: audioInputPath }] : [])

  const args = [
    '-y',
    // ffmpeg reads stdin for interactive keys unless told not to. With stdin
    // left open on a pipe nothing ever writes to, it can sit there waiting -
    // which shows up as a finished download stuck on "Muxing" forever.
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputArgs({ path: inputPath, concatList: options.inputIsConcatList })
  ]

  if (audioInputs.length > 0) {
    for (const input of audioInputs) args.push(...inputArgs(input))
    args.push('-map', '0:v')
    for (let index = 0; index < audioInputs.length; index++) {
      args.push('-map', `${index + 1}:a`)
    }
  } else {
    args.push('-map', '0')
  }

  args.push('-c', 'copy')

  for (let index = 0; index < audioInputs.length; index++) {
    const input = audioInputs[index]
    if (input.language) args.push(`-metadata:s:a:${index}`, `language=${input.language}`)
    if (input.title) args.push(`-metadata:s:a:${index}`, `title=${input.title}`)
    args.push(`-disposition:a:${index}`, input.isDefault || (index === 0 && !audioInputs.some((item) => item.isDefault)) ? 'default' : '0')
  }

  if (outputPath.toLowerCase().endsWith('.mp4')) {
    args.push('-movflags', '+faststart')
  }

  args.push(outputPath)

  await ensureSpaceFor(
    [
      { path: inputPath, concatList: options.inputIsConcatList },
      ...audioInputs
    ],
    outputPath
  )

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
async function ensureSpaceFor(
  inputs: Array<{ path: string; concatList?: boolean }>,
  outputPath: string
): Promise<void> {
  let needed = 0
  for (const input of inputs) {
    try {
      // A concat list is a few kilobytes of filenames; what the output will
      // cost is the sum of the pieces it names.
      needed += input.concatList
        ? await concatListBytes(input.path)
        : (await stat(input.path)).size
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

/**
 * What the pieces named by a concat list add up to.
 *
 * Parsed rather than guessed, so the space check stays as honest as it was when
 * the tracks had already been joined into one file it could simply `stat`.
 */
async function concatListBytes(listPath: string): Promise<number> {
  const text = await readFile(listPath, 'utf8')
  const paths: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^file\s+'(.*)'\s*$/.exec(line.trim())
    if (match) paths.push(match[1].replace(/'\\''/g, "'"))
  }

  const sizes = await Promise.all(
    paths.map((path) => stat(path).then((info) => info.size).catch(() => 0))
  )
  return sizes.reduce((total, size) => total + size, 0)
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

    let processError: Error | null = null
    child.on('error', (err) => { processError = new MuxError(err.message) })

    child.on('close', async (code) => {
      signal.removeEventListener('abort', onAbort)
      if (processError) {
        await rm(outputPath, { force: true }).catch(() => {})
        reject(processError)
        return
      }
      if (signal.aborted) {
        // A half-written mp4 is worse than none: it plays for two seconds and
        // looks like a corrupt download rather than a cancelled one.
        await rm(outputPath, { force: true }).catch(() => {})
        reject(new MuxError('Cancelled'))
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      await rm(outputPath, { force: true }).catch(() => {})
      // ffmpeg's last line is only its summary - "Error opening output files:
      // Invalid argument" for anything the muxer refused. What actually went
      // wrong is on the lines above it (the stream map that matched nothing,
      // the codec the container will not take), so reporting the tail alone
      // turned every distinct failure into the same unactionable sentence.
      const detail = stderr
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-4)
        .join(' | ')
      reject(new MuxError(`ffmpeg exited with ${code}${detail ? `: ${detail}` : ''}`))
    })
  })
}
