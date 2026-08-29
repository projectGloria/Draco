import { basename, extname, join } from 'node:path'
import { rename, rm } from 'node:fs/promises'
import type { DownloadTask } from '@shared/types'
import { TaskRunner } from '../engine/task.ts'
import type { Runner } from '../engine/runner.ts'
import type { RunnerContext } from '../engine/manager.ts'
import { uniquePath } from '../engine/naming.ts'
import { AbortedError } from '../engine/worker.ts'
import { ensureFfmpeg } from './ffmpeg.ts'
import { mux } from './mux.ts'

export class DashRunner implements Runner {
  task: DownloadTask
  private videoRunner: TaskRunner
  private audioRunner: TaskRunner
  private deps: RunnerContext
  private controller = new AbortController()
  /**
   * Which half of the job is running. While the children download, `tick()`
   * derives the parent status from them; once muxing starts it must stop, or it
   * would overwrite the mux status four times a second.
   */
  private muxing = false
  running = false

  constructor(task: DownloadTask, context: RunnerContext) {
    this.task = task
    this.deps = context

    const videoTask: DownloadTask = JSON.parse(JSON.stringify(task))
    videoTask.id = task.id + '-v'
    videoTask.filename = task.filename + '.v.mp4'
    videoTask.size = null
    videoTask.received = 0
    videoTask.segments = []
    if (task.youtube) videoTask.youtube = { ...task.youtube, role: 'video' }

    const audioTask: DownloadTask = JSON.parse(JSON.stringify(task))
    audioTask.id = task.id + '-a'
    audioTask.url = task.audioUrl!
    audioTask.filename = task.filename + '.a.m4a'
    audioTask.size = null
    audioTask.received = 0
    audioTask.segments = []
    if (task.youtube?.audioFormatId) {
      audioTask.youtube = { ...task.youtube, role: 'audio' }
    }

    const childContext: RunnerContext = {
      ...context,
      onUpdate: () => this.tick(),
      onFinished: (childTask, error) => {
        if (!error) return
        this.controller.abort()
        if (childTask.id === videoTask.id) void this.audioRunner?.pause()
        else void this.videoRunner?.pause()
      },
      onProbed: () => {}
    }

    const config = {
      maxConnections: Math.max(1, Math.floor(context.maxConnections / 2)),
      minSplitSize: 1024 * 1024,
      retryLimit: context.retryLimit,
      timeoutMs: context.timeoutMs
    }

    this.videoRunner = new TaskRunner(videoTask, config, childContext)
    this.audioRunner = new TaskRunner(audioTask, config, childContext)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.muxing = false
    this.controller = new AbortController()

    try {
      this.task.status = 'probing'
      this.deps.onUpdate(this.task)

      // Start both runners concurrently
      const vPromise = this.videoRunner.start()
      const aPromise = this.audioRunner.start()

      await Promise.all([vPromise, aPromise])
      if (this.controller.signal.aborted) throw new AbortedError()

      if (this.videoRunner.task.status === 'error') throw new Error(this.videoRunner.task.error || 'Video fetch failed')
      if (this.audioRunner.task.status === 'error') throw new Error(this.audioRunner.task.error || 'Audio fetch failed')

      this.muxing = true
      this.task.status = 'downloading'
      this.task.speed = 0
      this.task.eta = null
      this.task.detail = 'Muxing…'
      this.deps.onUpdate(this.task)

      const ffmpegPath = await ensureFfmpeg((progress) => {
        this.task.detail =
          progress.stage === 'downloading'
            ? 'Fetching ffmpeg' + (progress.percent === null ? '…' : ` ${Math.round(progress.percent)}%`)
            : 'Unpacking ffmpeg…'
        this.deps.onUpdate(this.task)
      })

      if (this.controller.signal.aborted) throw new AbortedError()

      this.task.detail = 'Muxing…'
      this.deps.onUpdate(this.task)

      const videoPath = join(this.task.dir, this.videoRunner.task.filename)
      const audioPath = join(this.task.dir, this.audioRunner.task.filename)
      const targetPath = await uniquePath(this.task.dir, this.task.filename)
      const muxTemp = muxTempPath(targetPath)
      await rm(muxTemp, { force: true }).catch(() => {})

      await mux({
        ffmpegPath,
        inputPath: videoPath,
        audioInputPath: audioPath,
        outputPath: muxTemp,
        signal: this.controller.signal
      })

      if (this.controller.signal.aborted) throw new AbortedError()
      await rename(muxTemp, targetPath)

      await rm(videoPath, { force: true }).catch(() => {})
      await rm(audioPath, { force: true }).catch(() => {})

      this.task.filename = basename(targetPath)
      this.task.status = 'done'
      this.task.completedAt = Date.now()
      this.task.detail = null
      this.task.speed = 0
      this.task.eta = null
      this.task.size = this.videoRunner.task.size! + this.audioRunner.task.size!
      this.task.received = this.task.size
      this.task.segments = []

      this.deps.onFinished(this.task, null)
    } catch (err) {
      const target = join(this.task.dir, this.task.filename)
      await rm(muxTempPath(target), { force: true }).catch(() => {})
      if (err instanceof AbortedError || this.controller.signal.aborted) {
        this.task.speed = 0
        this.task.eta = null
        this.deps.onFinished(this.task, null)
      } else {
        this.task.status = 'error'
        this.task.error = err instanceof Error ? err.message : String(err)
        this.task.speed = 0
        this.task.eta = null
        this.deps.onFinished(this.task, err as Error)
      }
    } finally {
      this.running = false
    }
  }

  async pause(): Promise<void> {
    this.task.status = 'paused'
    this.task.speed = 0
    this.task.eta = null
    this.controller.abort()

    await Promise.allSettled([this.videoRunner.pause(), this.audioRunner.pause()])
    this.deps.onUpdate(this.task)
  }

  tick(): void {
    if (!this.running) return
    this.videoRunner.tick()
    this.audioRunner.tick()

    /*
     * The parent's status is the two children's, combined. Without this it stayed
     * on `probing` for the entire download - and the table only shows a speed for
     * a task that says it is downloading, so the column read empty throughout.
     */
    if (!this.muxing) {
      const states = [this.videoRunner.task.status, this.audioRunner.task.status]
      this.task.status = states.includes('downloading') ? 'downloading' : 'probing'

      // Before any bytes move, the only thing worth saying is what the children
      // are waiting on - resolving a YouTube URL, most of the time - and the
      // parent is the task the list and the progress window are looking at.
      this.task.detail =
        this.task.status === 'downloading'
          ? null
          : (this.videoRunner.task.detail ?? this.audioRunner.task.detail)
    }

    this.task.received = this.videoRunner.task.received + this.audioRunner.task.received

    const vSize = this.videoRunner.task.size
    const aSize = this.audioRunner.task.size
    if (vSize !== null && aSize !== null) {
      this.task.size = vSize + aSize
    } else {
      this.task.size = null
    }

    this.task.speed = this.muxing
      ? 0
      : this.videoRunner.task.speed + this.audioRunner.task.speed

    if (this.task.size !== null && this.task.speed > 1) {
      this.task.eta = Math.max(0, Math.round((this.task.size - this.task.received) / this.task.speed))
    } else {
      this.task.eta = null
    }

    // Pass up the segments for visualization
    this.task.segments = [...this.videoRunner.task.segments, ...this.audioRunner.task.segments]
  }

  async resetForRestart(): Promise<boolean> {
    const v = await this.videoRunner.resetForRestart()
    const a = await this.audioRunner.resetForRestart()
    return v && a
  }
}


function muxTempPath(target: string): string {
  const ext = extname(target)
  return ext ? `${target.slice(0, -ext.length)}.draco-mux-temp${ext}` : `${target}.draco-mux-temp.mp4`
}
