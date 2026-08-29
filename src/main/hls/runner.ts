import { createDecipheriv } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DownloadTask, Segment } from '@shared/types'
import { getDispatcher } from '../engine/http.ts'
import type { RateLimiter } from '../engine/limiter.ts'
import { uniquePath } from '../engine/naming.ts'
import { buildHeaders } from '../engine/probe.ts'
import type { Runner } from '../engine/runner.ts'
import { AbortedError } from '../engine/worker.ts'
import { logger } from '../log.ts'
import { ensureFfmpeg } from './ffmpeg.ts'
import { mux } from './mux.ts'
import { loadMediaPlaylist, type HlsSegment } from './playlist.ts'

const log = logger('hls')

/**
 * Downloads an HLS stream: fetch every media segment, put them back in order,
 * and remux the result into a real container.
 *
 * The byte-range segmenter is deliberately not reused here. A playlist is not
 * one resource split into ranges; it is a few hundred separate resources, each
 * with its own byte space, some of them individually encrypted. What is shared
 * is the part that actually matters across both kinds of download - the global
 * rate limiter, the retry discipline, and the rule that nothing lands at its
 * final name until it is complete.
 *
 * Resume needs no journal of its own. Each finished piece is written to a temp
 * name and renamed into place, so a piece file existing *is* the record that it
 * finished; anything interrupted mid-write leaves a `.tmp` that is ignored and
 * overwritten. That is one fewer file that can disagree with reality.
 */

export interface HlsRunnerConfig {
  maxConnections: number
  retryLimit: number
  timeoutMs: number
}

export interface HlsRunnerDeps {
  limiter: RateLimiter
  onUpdate(task: DownloadTask): void
  onFinished(task: DownloadTask, error: Error | null): void
  onProbed?(task: DownloadTask): void | Promise<void>
}

const SPEED_WINDOW_MS = 3000
/** Enough finished pieces for an average size to mean anything. */
const ESTIMATE_AFTER = 3

interface ActiveFetch {
  bytes: number
}

export class HlsRunner implements Runner {
  private controller = new AbortController()
  private tracks: Array<{
    type: 'video' | 'audio'
    segments: HlsSegment[]
    initSegment: string | null
    mediaSequence: number
  }> = []

  private received = 0
  private completed = 0
  private samples: Array<{ t: number; received: number }> = []
  private active = new Map<number, ActiveFetch>()
  private keys = new Map<string, Buffer>()
  private inFlight: Promise<void> | null = null
  private restarted = false

  running = false

  readonly task: DownloadTask
  private config: HlsRunnerConfig
  private deps: HlsRunnerDeps

  constructor(task: DownloadTask, config: HlsRunnerConfig, deps: HlsRunnerDeps) {
    this.task = task
    this.config = config
    this.deps = deps
  }

  private get partsDir(): string {
    return join(this.task.dir, this.task.filename + '.dracoparts')
  }

  private get joinedVideoPath(): string {
    return join(this.task.dir, this.task.filename + '.dracodl')
  }

  private get joinedAudioPath(): string {
    return join(this.task.dir, this.task.filename + '.dracodl.audio')
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.controller = new AbortController()
    this.samples = []

    try {
      this.inFlight = this.run()
      await this.inFlight
      this.deps.onFinished(this.task, null)
    } catch (err) {
      const error = err as Error

      if (error instanceof AbortedError || this.controller.signal.aborted) {
        this.task.speed = 0
        this.task.eta = null
        this.deps.onFinished(this.task, null)
      } else {
        this.task.status = 'error'
        this.task.error = error.message
        this.task.speed = 0
        this.task.eta = null
        this.deps.onFinished(this.task, error)
      }
    } finally {
      this.inFlight = null
      this.active.clear()
      this.running = false
    }
  }

  async pause(): Promise<void> {
    this.task.status = 'paused'
    this.task.speed = 0
    this.task.eta = null
    this.controller.abort()

    // Waiting matters: the manager deletes the parts directory straight after a
    // pause when the task is being removed, and a worker still mid-write would
    // recreate files underneath it.
    await this.inFlight?.catch(() => {})

    this.task.speed = 0
    this.deps.onUpdate(this.task)
  }

  tick(): void {
    if (!this.running) return

    const now = Date.now()
    this.samples.push({ t: now, received: this.received })
    while (this.samples.length > 2 && now - this.samples[0].t > SPEED_WINDOW_MS) {
      this.samples.shift()
    }

    const oldest = this.samples[0]
    const elapsed = (now - oldest.t) / 1000
    if (elapsed >= 0.25) {
      this.task.speed = Math.max(0, (this.received - oldest.received) / elapsed)
    }

    this.task.received = this.received

    const totalSegments = this.tracks.reduce((acc, t) => acc + t.segments.length, 0)
    if (this.completed >= ESTIMATE_AFTER && totalSegments > 0) {
      this.task.size = Math.round((this.received / this.completed) * totalSegments)
    }

    this.task.segments = this.snapshot()

    this.task.eta =
      this.task.size !== null && this.task.speed > 1
        ? Math.max(0, Math.round((this.task.size - this.received) / this.task.speed))
        : null
  }

  /**
   * One row per live connection. HLS pieces have no meaningful offset within
   * the finished file until they are concatenated, so `end` stays -1 and the
   * detail dialog shows bytes pulled rather than a byte range.
   */
  private snapshot(): Segment[] {
    return [...this.active.values()].map((fetchState) => ({
      start: 0,
      end: -1,
      position: fetchState.bytes,
      active: true
    }))
  }

  /* ---------------------------------------------------------------- */

  private async run(): Promise<void> {
    this.task.status = 'probing'
    this.task.error = null
    this.task.detail = null
    this.deps.onUpdate(this.task)

    const playlist = await loadMediaPlaylist(this.task.url, this.task.headers)
    this.throwIfAborted()

    if (playlist.isLive) {
      throw new Error('This is a live stream, which has no end to download to')
    }
    if (playlist.segments.length === 0) {
      throw new Error('The playlist contained no media segments')
    }

    this.tracks.push({
      type: 'video',
      segments: playlist.segments,
      initSegment: playlist.initSegment,
      mediaSequence: playlist.mediaSequence
    })

    if (this.task.audioUrl) {
      try {
        const audioPlaylist = await loadMediaPlaylist(this.task.audioUrl, this.task.headers)
        this.throwIfAborted()
        if (!audioPlaylist.isLive && audioPlaylist.segments.length > 0) {
          this.tracks.push({
            type: 'audio',
            segments: audioPlaylist.segments,
            initSegment: audioPlaylist.initSegment,
            mediaSequence: audioPlaylist.mediaSequence
          })
        }
      } catch (err) {
        log.warn(`Failed to fetch audio playlist: ${err}`)
      }
    }

    this.task.finalUrl = this.task.url
    this.task.resumable = true
    this.task.mimeType = this.task.mimeType ?? 'video/mp4'

    await this.deps.onProbed?.(this.task)
    await mkdir(this.partsDir, { recursive: true })

    const totalSegments = this.tracks.reduce((acc, t) => acc + t.segments.length, 0)
    
    // Pieces already on disk from an earlier run
    let totalBytes = 0
    let totalCompleted = 0
    const pendingTasks: Array<() => Promise<void>> = []

    for (const track of this.tracks) {
      const done = await this.existingPieces(track.type, track.segments.length)
      totalBytes += done.bytes
      totalCompleted += done.indices.size

      if (track.initSegment) {
        pendingTasks.push(() => this.fetchInit(track.type, track.initSegment!))
      }
      
      pendingTasks.push(() => this.fetchAll(track, done.indices))
    }

    this.received = totalBytes
    this.completed = totalCompleted
    this.task.received = this.received

    this.task.connections = Math.min(this.config.maxConnections, totalSegments)
    this.task.status = 'downloading'
    this.task.startedAt = this.task.startedAt ?? Date.now()
    this.task.detail = `${totalSegments} pieces`
    this.deps.onUpdate(this.task)

    // Run track fetchers concurrently (they share the active connections pool)
    await Promise.all(pendingTasks.map(fn => fn()))
    this.throwIfAborted()

    await this.assemble()
  }

  /* ---------------------------------------------------------------- */
  /* Fetching                                                          */
  /* ---------------------------------------------------------------- */

  private piecePath(trackType: string, index: number): string {
    return join(this.partsDir, `${trackType}_${String(index).padStart(6, '0')}.part`)
  }

  private initPath(trackType: string): string {
    return join(this.partsDir, `${trackType}_init.part`)
  }

  private async existingPieces(trackType: string, totalSegments: number): Promise<{ indices: Set<number>; bytes: number }> {
    const indices = new Set<number>()
    let bytes = 0

    let entries: string[]
    try {
      entries = await readdir(this.partsDir)
    } catch {
      return { indices, bytes }
    }

    for (const name of entries) {
      const match = new RegExp(`^${trackType}_(\\d{6})\\.part$`).exec(name)
      if (!match) continue

      const index = Number(match[1])
      if (index >= totalSegments) continue

      const info = await stat(join(this.partsDir, name)).catch(() => null)
      if (!info || info.size === 0) continue

      indices.add(index)
      bytes += info.size
    }

    return { indices, bytes }
  }

  private async fetchInit(trackType: string, url: string): Promise<void> {
    const existing = await stat(this.initPath(trackType)).catch(() => null)
    if (existing && existing.size > 0) return

    const body = await this.download(url, null, -1)
    await writeAtomic(this.initPath(trackType), body)
  }

  /** A fixed pool of workers pulling from a shared index cursor. */
  private async fetchAll(track: { type: string; segments: HlsSegment[]; mediaSequence: number }, alreadyDone: Set<number>): Promise<void> {
    let cursor = 0
    const workers: Promise<void>[] = []
    const poolSize = Math.min(this.config.maxConnections, track.segments.length)

    const worker = async (slot: number): Promise<void> => {
      for (;;) {
        if (this.controller.signal.aborted) return

        const index = cursor++
        if (index >= track.segments.length) return
        if (alreadyDone.has(index)) continue

        this.active.set(slot, { bytes: 0 })
        try {
          await this.fetchPiece(track, index, slot)
        } finally {
          this.active.delete(slot)
        }
      }
    }

    for (let slot = 0; slot < poolSize; slot++) workers.push(worker(slot))

    // allSettled, then rethrow: one worker failing should not leave the others
    // writing into a directory that is about to be torn down.
    const results = await Promise.allSettled(workers)
    this.throwIfAborted()

    const failure = results.find((r) => r.status === 'rejected')
    if (failure && failure.status === 'rejected') {
      throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason))
    }
  }

  private async fetchPiece(track: { type: string; segments: HlsSegment[]; mediaSequence: number }, index: number, slot: number): Promise<void> {
    const segment = track.segments[index]
    const raw = await this.download(segment.url, segment.byteRange, slot)
    const body = segment.key ? await this.decrypt(raw, segment.key, track.mediaSequence + index) : raw

    await writeAtomic(this.piecePath(track.type, index), body)

    this.completed++
    this.deps.onUpdate(this.task)
  }

  /** One piece, with the same backoff discipline the byte-range worker uses. */
  private async download(
    url: string,
    byteRange: { offset: number; length: number } | null,
    slot: number
  ): Promise<Buffer> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < this.config.retryLimit; attempt++) {
      this.throwIfAborted()

      if (attempt > 0) {
        // Exponential with jitter, so a stream whose CDN hiccups does not have
        // every connection retry in lockstep.
        const backoff = Math.min(15_000, 500 * 2 ** attempt) * (0.5 + Math.random())
        await delay(backoff, this.controller.signal)
      }

      try {
        const headers = buildHeaders(this.task.headers)
        if (byteRange) {
          headers.range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`
        }

        const res = await fetch(url, {
          headers,
          redirect: 'follow',
          signal: this.controller.signal,
          dispatcher: getDispatcher(this.config.timeoutMs)
        } as RequestInit)

        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)

        const body = Buffer.from(await res.arrayBuffer())

        this.received += body.length
        const state = this.active.get(slot)
        if (state) state.bytes = body.length
        await this.deps.limiter.consume(body.length)

        return body
      } catch (err) {
        if (this.controller.signal.aborted) throw new AbortedError()
        lastError = err instanceof Error ? err : new Error(String(err))
      }
    }

    throw new Error(`Segment failed after ${this.config.retryLimit} attempts: ${lastError?.message}`)
  }

  private async decrypt(
    body: Buffer,
    key: { url: string; iv: string | null },
    index: number
  ): Promise<Buffer> {
    let material = this.keys.get(key.url)

    if (!material) {
      const res = await fetch(key.url, {
        headers: buildHeaders(this.task.headers),
        redirect: 'follow',
        signal: this.controller.signal,
        dispatcher: getDispatcher(this.config.timeoutMs)
      } as RequestInit)

      if (!res.ok) throw new Error(`Could not fetch the decryption key (HTTP ${res.status})`)
      material = Buffer.from(await res.arrayBuffer())
      if (material.length !== 16) throw new Error('Decryption key was not 16 bytes')
      this.keys.set(key.url, material)
    }

    const decipher = createDecipheriv('aes-128-cbc', material, ivFor(key.iv, index))
    return Buffer.concat([decipher.update(body), decipher.final()])
  }

  /* ---------------------------------------------------------------- */
  /* Assembly                                                          */
  /* ---------------------------------------------------------------- */

  private async assemble(): Promise<void> {
    await rm(this.joinedVideoPath, { force: true })
    await rm(this.joinedAudioPath, { force: true })

    let totalJoinedSize = 0

    for (const track of this.tracks) {
      const outPath = track.type === 'video' ? this.joinedVideoPath : this.joinedAudioPath
      const handle = await open(outPath, 'w')
      try {
        if (track.initSegment) await appendPiece(handle, this.initPath(track.type))
        for (let index = 0; index < track.segments.length; index++) {
          this.throwIfAborted()
          await appendPiece(handle, this.piecePath(track.type, index))
        }
      } finally {
        await handle.close()
      }

      const joined = await stat(outPath)
      totalJoinedSize += joined.size
    }

    this.received = totalJoinedSize
    this.task.received = totalJoinedSize

    const target = await this.finalize()

    await rm(this.partsDir, { recursive: true, force: true }).catch(() => {})

    this.task.filename = basename(target)
    this.task.status = 'done'
    this.task.completedAt = Date.now()
    this.task.speed = 0
    this.task.eta = null
    this.task.segments = []
    this.task.detail = null
    // The estimate is gone; this is the real number.
    this.task.size = this.task.received
  }

  /**
   * Remuxes into the requested container. If ffmpeg cannot be obtained the
   * stream is still kept - as the raw transport stream it already is, under a
   * name that says so. Throwing here would discard a download that finished.
   */
  private async finalize(): Promise<string> {
    const target = await uniquePath(this.task.dir, this.task.filename)

    try {
      /*
       * Fetching ffmpeg is a large download that happens once, on the first
       * stream ever downloaded. Without saying so the task sits at 100% for
       * several minutes looking hung, which is indistinguishable from broken.
       */
      const ffmpegPath = await ensureFfmpeg((progress) => {
        this.task.detail =
          progress.stage === 'downloading'
            ? 'Fetching ffmpeg' +
              (progress.percent === null ? '…' : ` ${Math.round(progress.percent)}%`)
            : 'Unpacking ffmpeg…'
        this.deps.onUpdate(this.task)
      })
      this.throwIfAborted()

      this.task.detail = 'Muxing…'
      this.deps.onUpdate(this.task)

      const hasAudio = this.tracks.some((t) => t.type === 'audio')
      await mux({
        ffmpegPath,
        inputPath: this.joinedVideoPath,
        audioInputPath: hasAudio ? this.joinedAudioPath : undefined,
        outputPath: target,
        signal: this.controller.signal
      })

      await rm(this.joinedVideoPath, { force: true }).catch(() => {})
      await rm(this.joinedAudioPath, { force: true }).catch(() => {})
      this.task.detail = null
      return target
    } catch (err) {
      if (this.controller.signal.aborted) throw new AbortedError()

      const reason = err instanceof Error ? err.message : String(err)
      log.warn(`mux unavailable or failed, keeping the raw stream: ${reason}`)
      this.task.detail = null

      const fallback = await uniquePath(
        this.task.dir,
        this.task.filename.replace(/\.([a-z0-9]+)$/i, '.ts')
      )
      await rename(this.joinedVideoPath, fallback)
      await rm(this.joinedAudioPath, { force: true }).catch(() => {})

      this.task.description = this.task.description
        ? this.task.description
        : 'Kept as a transport stream: ' + reason
      return fallback
    }
  }

  /* ---------------------------------------------------------------- */

  async resetForRestart(): Promise<boolean> {
    if (this.restarted) return false
    this.restarted = true

    await rm(this.partsDir, { recursive: true, force: true }).catch(() => {})
    await rm(this.joinedVideoPath, { force: true }).catch(() => {})
    await rm(this.joinedAudioPath, { force: true }).catch(() => {})
    this.received = 0
    this.completed = 0
    this.task.received = 0
    this.task.segments = []
    return true
  }

  private throwIfAborted(): void {
    if (this.controller.signal.aborted) throw new AbortedError()
  }
}

/* ------------------------------------------------------------------ */

/**
 * The IV for a piece: whatever EXT-X-KEY declared, or the media sequence number
 * as a 16-byte big-endian counter.
 */
function ivFor(declared: string | null, sequenceNumber: number): Buffer {
  if (declared) {
    const hex = declared.replace(/^0x/i, '')
    if (hex.length === 32) return Buffer.from(hex, 'hex')
  }

  const iv = Buffer.alloc(16)
  iv.writeUInt32BE(sequenceNumber, 12)
  return iv
}

/** Write to a temp name and rename, so a piece file only ever exists complete. */
async function writeAtomic(path: string, body: Buffer): Promise<void> {
  const tmp = path + '.tmp'
  await writeFile(tmp, body)
  await rename(tmp, path)
}

/**
 * Whole-piece reads rather than a stream: HLS segments are a few seconds of
 * video each, and the handle keeps its own write position, so this is an
 * ordinary sequential append with no offset arithmetic to get wrong.
 */
async function appendPiece(handle: FileHandle, path: string): Promise<void> {
  await handle.write(await readFile(path))
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new AbortedError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
