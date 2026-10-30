import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, resolve } from 'node:path'
import { ensureYtDlp } from '../main/youtube.ts'
import { ensureFfmpeg } from '../main/hls/ffmpeg.ts'
import { electronNodeRuntimeArgs, electronNodeRuntimeEnv } from '../main/youtube-runtime.ts'
import { killTree } from '../main/proc.ts'
import { validateUrl } from '../main/engine/create.ts'
import type { CliOptions } from './args.ts'
import { formatBytes, friendlyError, stepName, transfer, type Transfer } from './progress.ts'
import { cleanText } from './text.ts'

interface Status {
  set(message: string | null): void
  info(message: string): void
  error(message: string): void
  progress(transfers: Transfer[]): void
  saved(path: string, message: string): void
}

/**
 * yt-dlp is asked for machine-readable lines instead of its human output:
 * raw byte counts (so the bar can be drawn at any width) and postprocessor
 * keys (so "Merger" can become "Merging video and audio"). Everything else it
 * prints is hidden unless --verbose, because "[youtube] jNQX: Downloading
 * android player API JSON" means nothing to the person waiting.
 *
 * Fields are `|`-separated; the title goes last on its line, so a `|` inside
 * a title cannot shift the others.
 */
export const MEDIA_PROGRESS_ARGS = [
  '--newline', '--progress', '--progress-delta', '0.25',
  '--print', 'before_dl:DRACO_ITEM:%(playlist_index|)s|%(n_entries|)s|%(format_id)s|%(title)s',
  '--print', 'after_move:DRACO_DONE:%(filepath)s',
  '--progress-template', 'download:DRACO_PROGRESS:%(info.format_id)s|%(info.vcodec)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
  '--progress-template', 'postprocess:DRACO_STEP:%(progress.postprocessor)s|%(progress.status)s'
]

const number = (value: string | undefined): number | null => {
  const n = Number(value)
  return value && value !== 'NA' && Number.isFinite(n) ? n : null
}

/**
 * Folds yt-dlp's machine lines into the one `Transfer` the screen shows.
 * Pure state + a line in, so it is testable without spawning anything.
 */
export class MediaProgress {
  current: Transfer = transfer('media', 'Your download', 'preparing', { step: 'Getting download details' })
  private parts: string[] = []
  private downloaded = false

  /** Returns what the line meant, for the caller to report. */
  receive(line: string): { kind: 'progress' } | { kind: 'done'; path: string } | null {
    if (line.startsWith('DRACO_ITEM:')) {
      const [index, count, formats, ...title] = line.slice(11).split('|')
      this.parts = formats ? formats.split('+') : []
      this.downloaded = false
      const item = number(index) && number(count) && number(count)! > 1 ? ` (${index} of ${count})` : ''
      this.current = transfer('media', (title.join('|') || 'Your download') + item, 'preparing', { step: 'Starting' })
      return { kind: 'progress' }
    }
    if (line.startsWith('DRACO_PROGRESS:')) {
      const [formatId, vcodec, received, total, estimate, speed, eta] = line.slice(15).split('|')
      const index = this.parts.indexOf(formatId)
      const parts = this.parts.length > 1 ? this.parts.length : null
      this.downloaded = true
      this.current = {
        ...this.current, phase: 'downloading',
        // vcodec "none" is the audio half of a merged download.
        step: parts ? (vcodec === 'none' ? 'Audio' : 'Video') : null,
        part: parts && index >= 0 ? index + 1 : null, parts,
        received: number(received), total: number(total) ?? number(estimate),
        speed: number(speed), eta: number(eta)
      }
      return { kind: 'progress' }
    }
    if (line.startsWith('DRACO_STEP:')) {
      const [key, state] = line.slice(11).split('|')
      if (state !== 'started') return null
      // Thumbnail conversion runs before the download starts; that is still
      // "getting ready", not "finishing".
      this.current = { ...this.current, phase: this.downloaded ? 'finishing' : 'preparing', step: stepName(key),
        part: null, parts: null, speed: null, eta: null }
      return { kind: 'progress' }
    }
    if (line.startsWith('DRACO_DONE:')) {
      return { kind: 'done', path: line.slice(11) }
    }
    return null
  }
}

export function mediaArguments(options: CliOptions): string[] {
  if (options.format.kind === 'index') throw new Error('Use a quality such as 1080 or best with media config options.')
  const format = options.format.kind === 'height' ? `bv*[height<=${options.format.height}]+ba/b[height<=${options.format.height}]`
    : options.format.kind === 'bestaudio' ? 'ba' : options.format.kind === 'worst' ? 'worst' : 'bv*+ba/b'
  const args = ['--ignore-config', '-f', format, '-P', resolve(options.dir ?? process.cwd())]
  for (const [flag, value] of Object.entries(options.mediaOptions)) {
    args.push(flag)
    if (value !== true) args.push(value)
  }
  if (options.output) args.push('-o', options.output)
  if (options.cookiesFromBrowser && options.cookiesFromBrowser !== 'none') args.push('--cookies-from-browser', options.cookiesFromBrowser)
  if (options.noPlaylist) args.push('--no-playlist')
  if (options.force) args.push('--force-overwrites')
  if (options.proxy) args.push('--proxy', options.proxy)
  if (options.rateLimit) args.push('--limit-rate', String(options.rateLimit))
  if (options.retries !== null) args.push('--retries', String(options.retries))
  if (options.socketTimeout !== null) args.push('--socket-timeout', String(options.socketTimeout))
  if (options.connections !== null) args.push('--concurrent-fragments', String(options.connections))
  if (options.listFormats) args.push('--list-formats')
  if (options.getUrl) args.push('--get-url')
  return args
}

export async function runMediaDownload(options: CliOptions, status: Status, signal?: AbortSignal): Promise<number> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (!signal) process.on('SIGINT', abort)
  if (signal?.aborted) abort()
  try {
    status.set('Preparing your download…')
    const args = mediaArguments(options)
    const urls = options.urls.map(url => validateUrl(url))
    const executable = await ensureYtDlp()
    const ffmpeg = await ensureFfmpeg()
    if (controller.signal.aborted) return 130
    args.push('--ffmpeg-location', ffmpeg, ...electronNodeRuntimeArgs(), '--remote-components', 'ejs:github')
    const inspecting = options.listFormats || options.getUrl
    if (!inspecting) args.push('--no-simulate', ...MEDIA_PROGRESS_ARGS)
    args.push('--', ...urls)
    return await new Promise<number>((done, reject) => {
      const child = spawn(executable, args, { windowsHide: true, env: electronNodeRuntimeEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
      const stop = (): void => { status.set('Pausing your download…'); killTree(child) }
      controller.signal.addEventListener('abort', stop, { once: true })
      if (controller.signal.aborted) stop()
      const progress = new MediaProgress()
      status.progress([progress.current])
      let failed = false
      const receive = (raw: string): void => {
        const line = cleanText(raw)
        const event = progress.receive(line)
        if (event?.kind === 'progress') status.progress([progress.current])
        else if (event?.kind === 'done') {
          // The merged file's size is only known once it exists; yt-dlp's own
          // filesize field describes the streams, not the result.
          let size: number | null = null
          try { size = statSync(event.path).size } catch {}
          status.saved(event.path, `Saved ${basename(event.path)}${size ? ` · ${formatBytes(size)}` : ''}`)
        } else if (line.startsWith('ERROR:')) {
          failed = true
          status.error(`Could not download: ${friendlyError(line)}`)
        } else if (inspecting || (options.verbose && line)) status.info(line)
      }
      const stdout = createInterface({ input: child.stdout })
      const stderr = createInterface({ input: child.stderr })
      stdout.on('line', receive); stderr.on('line', receive)
      const cleanup = (): void => { controller.signal.removeEventListener('abort', stop); stdout.close(); stderr.close() }
      child.once('error', error => { cleanup(); reject(error) })
      child.once('close', code => {
        cleanup()
        status.progress([])
        if (controller.signal.aborted) {
          // The full-screen UI words its own pause note ("Press F5"); a plain run needs this one.
          if (!signal) status.info('Paused. Run the same command again to pick up where it stopped.')
          done(130)
        }
        else {
          // yt-dlp exits non-zero without an ERROR line when, say, it is killed.
          if (code !== 0 && !failed) status.error('Could not download: the downloader stopped unexpectedly.')
          done(code === 0 ? 0 : 1)
        }
      })
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!signal) process.removeListener('SIGINT', abort)
  }
}
