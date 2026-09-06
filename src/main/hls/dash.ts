import { basename, extname, join } from 'node:path'
import { rm, stat } from 'node:fs/promises'
import type { DownloadTask } from '@shared/types'
import { QuotaExceededError } from '../engine/limiter.ts'
import { TaskRunner, quotaDetail } from '../engine/task.ts'
import type { Runner } from '../engine/runner.ts'
import type { RunnerContext } from '../engine/manager.ts'
import { discardReservedPath, moveFile, uniquePath } from '../engine/naming.ts'
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
  /** The temp file the mux is writing, so the error path deletes the real one. */
  private muxTemp: string | null = null
  /** The final name `uniquePath` reserved, given back if the merge never lands. */
  private reservedTarget: string | null = null
  /** Set when a child stopped on the transfer quota rather than on a failure. */
  private quotaError: QuotaExceededError | null = null
  running = false

  constructor(task: DownloadTask, context: RunnerContext) {
    this.task = task
    this.deps = context

    const videoTask: DownloadTask = JSON.parse(JSON.stringify(task))
    videoTask.id = task.id + '-v'
    videoTask.filename = task.filename + '.v.mp4'
    // The halves' names are this runner's contract with itself: `adoptFinishedHalf`
    // and the mux both address them by name. Unlocked, `TaskRunner` would replace
    // the name with whatever Content-Disposition said - `videoplayback.mp4` on a
    // Google CDN - and the merge would look for a file that no longer exists.
    videoTask.filenameLocked = true
    videoTask.size = null
    videoTask.received = 0
    videoTask.segments = []
    if (task.youtube) videoTask.youtube = { ...task.youtube, role: 'video' }

    const audioTask: DownloadTask = JSON.parse(JSON.stringify(task))
    audioTask.id = task.id + '-a'
    audioTask.url = task.audioUrl!
    audioTask.filename = task.filename + '.a.m4a'
    audioTask.filenameLocked = true
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
        // The budget belongs to the whole app, so a half that ran out of it
        // stops the pair. Kept so `start` can report it as a hold rather than
        // letting the mux run on a file that was never finished.
        if (error instanceof QuotaExceededError) this.quotaError = error
        // Stop the sibling, but do not abort the parent controller. An abort
        // is a user pause in the parent's catch path and would hide this real
        // child failure by leaving the composite task stuck on "probing".
        if (childTask.id === videoTask.id) void this.audioRunner?.pause()
        else void this.videoRunner?.pause()
      },
      onProbed: () => {}
    }

    const config = {
      maxConnections: Math.max(1, Math.floor(context.maxConnections / 2)),
      minSplitSize: 1024 * 1024,
      retryLimit: context.retryLimit,
      timeoutMs: context.timeoutMs,
      // The halves are ordinary downloads and their partials belong in the same
      // workspace every other download uses, so `remove` and the restore-time
      // reconciliation find them where they expect to.
      tempDir: context.tempDir,
      checkDiskSpace: context.checkDiskSpace,
      exponentialBackoff: context.exponentialBackoff
    }

    this.videoRunner = new TaskRunner(videoTask, config, childContext)
    this.audioRunner = new TaskRunner(audioTask, config, childContext)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.muxing = false
    this.quotaError = null
    this.controller = new AbortController()

    try {
      this.task.status = 'probing'
      this.deps.onUpdate(this.task)

      // Start both runners concurrently - unless a half is already sitting there
      // finished from an attempt whose mux failed.
      const vPromise = (await this.adoptFinishedHalf(this.videoRunner))
        ? Promise.resolve()
        : this.videoRunner.start()
      const aPromise = (await this.adoptFinishedHalf(this.audioRunner))
        ? Promise.resolve()
        : this.audioRunner.start()

      await Promise.all([vPromise, aPromise])
      if (this.quotaError) throw this.quotaError
      if (this.videoRunner.task.status === 'error') throw new Error(this.videoRunner.task.error || 'Video fetch failed')
      if (this.audioRunner.task.status === 'error') throw new Error(this.audioRunner.task.error || 'Audio fetch failed')
      if (this.controller.signal.aborted) throw new AbortedError()

      // Neither half may be short of its final name here. Muxing a stream that
      // stopped early would produce a truncated file that still looks finished.
      const unfinished = [this.videoRunner.task, this.audioRunner.task].find((t) => t.status !== 'done')
      if (unfinished) throw new AbortedError()

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
      this.reservedTarget = targetPath
      const muxTemp = muxTempPath(targetPath)
      this.muxTemp = muxTemp
      await rm(muxTemp, { force: true }).catch(() => {})

      await mux({
        ffmpegPath,
        inputPath: videoPath,
        audioInputPath: audioPath,
        outputPath: muxTemp,
        signal: this.controller.signal
      })

      if (this.controller.signal.aborted) throw new AbortedError()
      await moveFile(muxTemp, targetPath)

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
      // The temp is named after the path `uniquePath` handed out, which is not
      // always `task.filename` - deleting the guess left the real one behind,
      // taking up exactly the space the next attempt needs.
      const temp = this.muxTemp ?? muxTempPath(join(this.task.dir, this.task.filename))
      await rm(temp, { force: true }).catch(() => {})
      // Same reasoning for the name itself: a merge that never landed must not
      // leave an empty file wearing the download's final name.
      if (this.reservedTarget) await discardReservedPath(this.reservedTarget)
      this.reservedTarget = null
      if (err instanceof QuotaExceededError) {
        this.task.status = 'paused'
        this.task.error = null
        this.task.speed = 0
        this.task.eta = null
        this.task.detail = quotaDetail(err.resumesAt)
        this.deps.onFinished(this.task, err)
      } else if (err instanceof AbortedError || this.controller.signal.aborted) {
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

  /**
   * A half only reaches its own name once every byte is written - `TaskRunner`
   * renames it there from `.dracodl` - so the file existing *is* the record
   * that the half is finished, the same rule the HLS pieces run on.
   *
   * Without this, a mux that failed (out of disk, most often) meant the next
   * attempt re-fetched both streams and, since the old halves are still there,
   * landed them beside as `… (1)`. The retry then needed three copies of the
   * video to succeed where two had not fit, so freeing "enough" space never
   * helped.
   */
  private async adoptFinishedHalf(runner: TaskRunner): Promise<boolean> {
    const path = join(this.task.dir, runner.task.filename)
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size === 0) return false
      runner.task.size = info.size
      runner.task.received = info.size
      runner.task.status = 'done'
      runner.task.speed = 0
      runner.task.eta = null
      runner.task.detail = null
      return true
    } catch {
      return false
    }
  }

  async pause(): Promise<void> {
    this.task.status = 'paused'
    this.task.speed = 0
    this.task.eta = null
    this.controller.abort()

    await Promise.allSettled([this.videoRunner.pause(), this.audioRunner.pause()])
    // Each child publishes a final update as it stops. Keep that update from
    // recombining their transient states into "probing" after the user chose
    // Pause for the parent task.
    this.task.status = 'paused'
    this.task.speed = 0
    this.task.eta = null
    this.task.detail = null
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
      if (this.controller.signal.aborted) {
        this.task.status = 'paused'
        this.task.detail = null
      } else {
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
