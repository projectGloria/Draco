import { spawn, type ChildProcess } from 'node:child_process'
import { basename, extname } from 'node:path'
import { rename, rm, stat } from 'node:fs/promises'
import type { DownloadTask } from '../../shared/types.ts'
import type { RunnerContext } from '../engine/manager.ts'
import { uniquePath } from '../engine/naming.ts'
import type { Runner } from '../engine/runner.ts'
import { ensureFfmpeg } from '../hls/ffmpeg.ts'
import { ffmpegHeaders } from './headers.ts'
import { resolveMpd } from './manifest.ts'

const SPEED_WINDOW_MS = 3000

/** Downloads an unencrypted VOD MPD with ffmpeg's native DASH demuxer. */
export class MpdRunner implements Runner {
  readonly task: DownloadTask
  running = false

  private context: RunnerContext
  private controller = new AbortController()
  private child: ChildProcess | null = null
  private inFlight: Promise<void> | null = null
  private restarted = false
  private outputPath: string | null = null
  private samples: Array<{ t: number; received: number }> = []
  private durationSeconds: number | null = null
  private mediaSeconds = 0

  constructor(task: DownloadTask, context: RunnerContext) {
    this.task = task
    this.context = context
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.controller = new AbortController()
    this.samples = []

    try {
      this.inFlight = this.run()
      await this.inFlight
      this.context.onFinished(this.task, null)
    } catch (error) {
      if (this.controller.signal.aborted) {
        this.task.status = 'paused'
        this.task.detail = null
        this.task.speed = 0
        this.task.eta = null
        this.context.onFinished(this.task, null)
      } else {
        const reason = error instanceof Error ? error : new Error(String(error))
        this.task.status = 'error'
        this.task.error = reason.message
        this.task.detail = null
        this.task.speed = 0
        this.task.eta = null
        this.context.onFinished(this.task, reason)
      }
    } finally {
      this.child = null
      this.inFlight = null
      this.running = false
    }
  }

  async pause(): Promise<void> {
    this.controller.abort()
    this.killChild()
    await this.inFlight?.catch(() => {})
    if (this.outputPath) await rm(this.outputPath, { force: true }).catch(() => {})
    this.task.status = 'paused'
    this.task.detail = null
    this.task.speed = 0
    this.task.eta = null
    this.context.onUpdate(this.task)
  }

  tick(): void {
    if (!this.running) return
    const now = Date.now()
    this.samples.push({ t: now, received: this.task.received })
    while (this.samples.length > 2 && now - this.samples[0].t > SPEED_WINDOW_MS) this.samples.shift()
    const oldest = this.samples[0]
    const elapsed = (now - oldest.t) / 1000
    if (elapsed >= 0.25) this.task.speed = Math.max(0, (this.task.received - oldest.received) / elapsed)
    if (this.durationSeconds && this.mediaSeconds > 0) {
      const rate = this.mediaSeconds / Math.max(0.25, (now - (this.task.startedAt ?? now)) / 1000)
      this.task.eta = rate > 0 ? Math.max(0, Math.round((this.durationSeconds - this.mediaSeconds) / rate)) : null
    }
  }

  async resetForRestart(): Promise<boolean> {
    if (this.restarted) return false
    this.restarted = true
    this.killChild()
    if (this.outputPath) await rm(this.outputPath, { force: true }).catch(() => {})
    this.task.received = 0
    this.task.size = null
    this.task.segments = []
    this.task.error = null
    return true
  }

  private async run(): Promise<void> {
    this.task.status = 'probing'
    this.task.error = null
    this.task.detail = 'Inspecting DASH manifest…'
    this.context.onUpdate(this.task)

    const resolved = await resolveMpd(this.task.url, this.task.headers, this.context.timeoutMs)
    this.durationSeconds = resolved.summary.durationSeconds
    this.task.finalUrl = resolved.variants[0].url
    this.task.mimeType = 'video/mp4'
    this.task.resumable = false
    await this.context.onProbed?.(this.task)

    this.task.detail = 'Preparing media engine…'
    this.context.onUpdate(this.task)
    const ffmpegPath = await ensureFfmpeg((progress) => {
      this.task.detail = progress.stage === 'downloading'
        ? `Fetching ffmpeg${progress.percent === null ? '…' : ` ${Math.round(progress.percent)}%`}`
        : 'Unpacking ffmpeg…'
      this.context.onUpdate(this.task)
    })
    if (this.controller.signal.aborted) throw new Error('Cancelled')

    const targetPath = await uniquePath(this.task.dir, this.task.filename)
    const extension = extname(targetPath) || '.mp4'
    this.outputPath = `${targetPath.slice(0, -extension.length)}.draco-dash-temp${extension}`
    await rm(this.outputPath, { force: true }).catch(() => {})

    this.task.status = 'downloading'
    this.task.detail = 'Downloading MPEG-DASH media…'
    this.task.startedAt = this.task.startedAt ?? Date.now()
    this.task.connections = 1
    this.context.onUpdate(this.task)

    await this.runFfmpeg(ffmpegPath, this.task.finalUrl, this.outputPath)
    if (this.controller.signal.aborted) throw new Error('Cancelled')
    await rename(this.outputPath, targetPath)
    const info = await stat(targetPath)
    this.task.filename = basename(targetPath)
    this.task.size = info.size
    this.task.received = info.size
    this.task.status = 'done'
    this.task.completedAt = Date.now()
    this.task.detail = null
    this.task.speed = 0
    this.task.eta = 0
    this.outputPath = null
  }

  private runFfmpeg(ffmpegPath: string, url: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error']
      if (this.context.proxyUrl) args.push('-http_proxy', this.context.proxyUrl)
      const headerBlock = ffmpegHeaders(this.task.headers)
      if (headerBlock) args.push('-headers', headerBlock)
      args.push('-i', url, '-map', '0', '-c', 'copy', '-progress', 'pipe:1', '-nostats')
      if (outputPath.toLowerCase().endsWith('.mp4')) args.push('-movflags', '+faststart')
      args.push(outputPath)

      const child = spawn(ffmpegPath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      this.child = child
      let stderr = ''
      let stdout = ''

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
        const lines = stdout.split(/\r?\n/)
        stdout = lines.pop() ?? ''
        for (const line of lines) this.consumeProgress(line)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-4000)
      })

      const onAbort = (): void => this.killChild()
      this.controller.signal.addEventListener('abort', onAbort, { once: true })
      child.on('error', (error) => reject(error))
      child.on('close', (code) => {
        this.controller.signal.removeEventListener('abort', onAbort)
        this.child = null
        if (this.controller.signal.aborted) {
          void rm(outputPath, { force: true }).catch(() => {})
          reject(new Error('Cancelled'))
        } else if (code === 0) resolve()
        else {
          void rm(outputPath, { force: true }).catch(() => {})
          reject(new Error(`Media engine failed (${code}): ${stderr.trim().split(/\r?\n/).pop() ?? 'unknown error'}`))
        }
      })
    })
  }

  private consumeProgress(line: string): void {
    const separator = line.indexOf('=')
    if (separator < 1) return
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (key === 'total_size' && /^\d+$/.test(value)) this.task.received = Number(value)
    if (key === 'out_time_us' && /^\d+$/.test(value)) this.mediaSeconds = Number(value) / 1_000_000
    if (key === 'progress') this.context.onUpdate(this.task)
  }

  private killChild(): void {
    const pid = this.child?.pid
    if (!pid) return
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.on('error', () => this.child?.kill('SIGKILL'))
  }
}
