import { createDecipheriv, createHash } from 'node:crypto'
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
import { QuotaExceededError, type RateLimiter } from '../engine/limiter.ts'
import { discardReservedPath, moveFile, uniquePath } from '../engine/naming.ts'
import { mapConcurrent } from '../engine/concurrency.ts'
import { buildHeaders } from '../engine/probe.ts'
import type { Runner } from '../engine/runner.ts'
import { workspaceDir } from '../engine/workspace.ts'
import { quotaDetail } from '../engine/task.ts'
import { AbortedError } from '../engine/worker.ts'
import { logger } from '../log.ts'
import { ensureFfmpeg } from './ffmpeg.ts'
import { mux } from './mux.ts'
import { loadMediaPlaylist, resolveVariants, type HlsSegment } from './playlist.ts'
import { streamResponseBody } from './stream.ts'

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
  tempDir?: string
  checkDiskSpace?: boolean
  exponentialBackoff?: boolean
}

export interface HlsRunnerDeps {
  limiter: RateLimiter
  onUpdate(task: DownloadTask): void
  onFinished(task: DownloadTask, error: Error | null): void
  onProbed?(task: DownloadTask): void | Promise<void>
}

const SPEED_WINDOW_MS = 3000
/** Enough finished pieces from each track for its average to mean anything. */
const ESTIMATE_AFTER_PER_TRACK = 3
const FILE_SCAN_CONCURRENCY = 8

interface ActiveFetch {
  bytes: number
}

interface TrackProgress {
  bytes: number
  completed: number
}

interface ResolvedTrack {
  id: string
  role: 'video' | 'audio'
  label: string | null
  language: string | null
  isDefault: boolean
  segments: HlsSegment[]
  initSegment: { url: string; byteRange: { offset: number; length: number } | null } | null
  mediaSequence: number
}

export class HlsRunner implements Runner {
  private controller = new AbortController()
  private tracks: ResolvedTrack[] = []

  private received = 0
  private completed = 0
  private samples: Array<{ t: number; received: number }> = []
  private active = new Map<number, ActiveFetch>()
  private trackProgress = new Map<string, TrackProgress>()
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

  private get tempDir(): string {
    return workspaceDir(this.task.dir, this.config.tempDir)
  }

  private get partsDir(): string {
    return join(this.tempDir, this.task.filename + '.dracoparts')
  }

  private get joinedVideoPath(): string {
    return join(this.tempDir, this.task.filename + '.dracodl')
  }

  private joinedAudioPath(index: number): string {
    return join(this.tempDir, this.task.filename + `.dracodl.audio${index === 0 ? '' : `.${index}`}`)
  }

  private get manifestPath(): string {
    return join(this.partsDir, '.playlist.json')
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.controller = new AbortController()
    this.samples = []
    this.tracks = []
    this.received = 0
    this.completed = 0
    this.active.clear()
    this.trackProgress.clear()
    this.keys.clear()

    try {
      this.inFlight = this.run()
      await this.inFlight
      this.deps.onFinished(this.task, null)
    } catch (err) {
      const error = err as Error

      if (error instanceof QuotaExceededError) {
        // The pieces already on disk are the record, so this costs nothing but
        // the wait; the manager starts the stream again when the window turns.
        this.task.status = 'paused'
        this.task.error = null
        this.task.speed = 0
        this.task.eta = null
        this.task.detail = quotaDetail(error.resumesAt)
        this.deps.onFinished(this.task, error)
      } else if (error instanceof AbortedError || this.controller.signal.aborted) {
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
    // `received` contains atomically completed pieces. Large HLS pieces can
    // take several seconds, so using only that number makes an active transfer
    // look stopped until a whole piece lands. Include the bytes currently
    // streaming on every connection for smooth, truthful speed reporting.
    const activeBytes = [...this.active.values()].reduce((sum, fetchState) => sum + fetchState.bytes, 0)
    const liveReceived = this.received + activeBytes
    this.samples.push({ t: now, received: liveReceived })
    while (this.samples.length > 2 && now - this.samples[0].t > SPEED_WINDOW_MS) {
      this.samples.shift()
    }

    const oldest = this.samples[0]
    const elapsed = (now - oldest.t) / 1000
    if (elapsed >= 0.25) {
      this.task.speed = Math.max(0, (liveReceived - oldest.received) / elapsed)
    }

    this.task.received = liveReceived

    // Video and alternate-audio pieces can differ in size by orders of
    // magnitude, and the work queue processes tracks in order. Extrapolating
    // the first video pieces across every audio piece made an 11 GB download
    // jump to 36 GB. Refine only after every track has its own sample.
    const trackEstimates = this.tracks.map((track) => {
      const progress = this.trackProgress.get(track.id)
      const required = Math.min(ESTIMATE_AFTER_PER_TRACK, track.segments.length)
      if (!progress || progress.completed < required || progress.completed === 0) return null
      return (progress.bytes / progress.completed) * track.segments.length
    })
    if (trackEstimates.length > 0 && trackEstimates.every((size): size is number => size !== null)) {
      this.task.size = Math.max(this.received, Math.round(trackEstimates.reduce((sum, size) => sum + size, 0)))
    }

    this.task.segments = this.snapshot()

    this.task.eta =
      this.task.size !== null && this.task.speed > 1
        ? Math.max(0, Math.round((this.task.size - liveReceived) / this.task.speed))
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

    let videoUrl = this.task.url
    if ((!this.task.audioTracks || this.task.audioTracks.length === 0) && !this.task.audioUrl) {
      const variants = await resolveVariants(this.task.url, this.task.headers)
      const selected = variants[0]
      if (selected) {
        videoUrl = selected.url
        this.task.audioUrl = selected.audioUrl ?? null
        this.task.audioTracks = selected.audioTracks?.map((track) => ({ ...track })) ?? []
        if (this.task.audioTracks.length > 1 && !this.task.filenameLocked) {
          this.task.filename = this.task.filename.replace(/\.[a-z0-9]+$/i, '.mkv')
        }
      }
    }

    const playlist = await loadMediaPlaylist(videoUrl, this.task.headers)
    this.throwIfAborted()

    if (playlist.isLive) {
      throw new Error('This is a live stream, which has no end to download to')
    }
    if (playlist.segments.length === 0) {
      throw new Error('The playlist contained no media segments')
    }

    this.tracks.push({
      id: 'video',
      role: 'video',
      label: null,
      language: null,
      isDefault: false,
      segments: playlist.segments,
      initSegment: playlist.initSegment,
      mediaSequence: playlist.mediaSequence
    })

    const declaredAudio = this.task.audioTracks && this.task.audioTracks.length > 0
      ? this.task.audioTracks
      : this.task.audioUrl
        ? [{ url: this.task.audioUrl, label: 'Audio', language: null, isDefault: true }]
        : []
    const uniqueAudio = declaredAudio.filter((track, index, tracks) =>
      tracks.findIndex((candidate) => candidate.url === track.url) === index
    )

    for (let index = 0; index < uniqueAudio.length; index++) {
      const declared = uniqueAudio[index]
      const audioPlaylist = await loadMediaPlaylist(declared.url, this.task.headers)
      this.throwIfAborted()
      if (audioPlaylist.isLive) throw new Error(`Audio track “${declared.label}” is a live stream`)
      if (audioPlaylist.segments.length === 0) throw new Error(`Audio track “${declared.label}” contained no media segments`)
      this.tracks.push({
        id: `audio_${String(index).padStart(3, '0')}`,
        role: 'audio',
        label: declared.label,
        language: declared.language,
        isDefault: declared.isDefault,
        segments: audioPlaylist.segments,
        initSegment: audioPlaylist.initSegment,
        mediaSequence: audioPlaylist.mediaSequence
      })
    }

    this.task.finalUrl = videoUrl
    this.task.resumable = true
    this.task.mimeType = this.task.mimeType ?? 'video/mp4'

    await this.deps.onProbed?.(this.task)
    await mkdir(this.partsDir, { recursive: true })

    // A VOD playlist can change while keeping the same URL. Reusing pieces by
    // index alone can silently splice an old recording into a new one. Keep a
    // compact fingerprint of the resolved playlist inputs and discard stale
    // pieces before resuming.
    const playlistIdentity = buildPlaylistIdentity(this.tracks)
    const storedManifest = await readPlaylistManifest(this.manifestPath)
    if (storedManifest) {
      if (storedManifest.version === PLAYLIST_MANIFEST_VERSION && storedManifest.identity === playlistIdentity) {
        // Current format and identical identity; resume on-disk pieces.
      } else if (
        storedManifest.version === 1 &&
        storedManifest.identity === buildLegacyPlaylistIdentity(this.tracks)
      ) {
        // Migrating from legacy manifest format (v1). Audio pieces were renamed
        // from audio_NNNNNN.part to audio_000_NNNNNN.part for multi-track support.
        await migrateLegacyPlaylistParts(this.partsDir)
        await writeFile(
          this.manifestPath,
          JSON.stringify({ version: PLAYLIST_MANIFEST_VERSION, identity: playlistIdentity }),
          'utf8'
        )
      } else {
        log.warn(`HLS playlist identity changed for ${this.task.filename}, restarting stream`)
        await clearPlaylistParts(this.partsDir)
        await writeFile(
          this.manifestPath,
          JSON.stringify({ version: PLAYLIST_MANIFEST_VERSION, identity: playlistIdentity }),
          'utf8'
        )
      }
    } else {
      await writeFile(
        this.manifestPath,
        JSON.stringify({ version: PLAYLIST_MANIFEST_VERSION, identity: playlistIdentity }),
        'utf8'
      )
    }

    const totalSegments = this.tracks.reduce((acc, t) => acc + t.segments.length, 0)
    
    // Pieces already on disk from an earlier run. Build one global work queue:
    // separate per-track pools would otherwise create up to 2x the configured
    // connection count for video+audio streams.
    let totalBytes = 0
    let totalCompleted = 0
    const sampleJobs: Array<(slot: number) => Promise<void>> = []
    const jobs: Array<(slot: number) => Promise<void>> = []

    for (const track of this.tracks) {
      const done = await this.existingPieces(track.id, track.segments.length)
      this.trackProgress.set(track.id, { bytes: done.bytes, completed: done.indices.size })
      totalBytes += done.bytes
      totalCompleted += done.indices.size

      if (track.initSegment) {
        const initPath = this.initPath(track.id)
        const existing = await stat(initPath).catch(() => null)
        if (!existing || existing.size === 0) {
          sampleJobs.push(async (slot) => {
            const bytes = await this.downloadAtomic(
              initPath,
              track.initSegment!.url,
              track.initSegment!.byteRange,
              slot
            )
            this.creditCompletedBytes(slot, bytes)
          })
        } else {
          totalBytes += existing.size
        }
      }

      let samplesQueued = 0
      for (let index = 0; index < track.segments.length; index++) {
        if (done.indices.has(index)) continue
        const job = (slot: number): Promise<void> => this.fetchPiece(track, index, slot)
        if (samplesQueued < ESTIMATE_AFTER_PER_TRACK) {
          sampleJobs.push(job)
          samplesQueued++
        } else {
          jobs.push(job)
        }
      }
    }

    // Seed every track before bulk downloading the first one. Besides making
    // the size estimate honest, this prevents progress from briefly reaching
    // 100% while alternate audio is still waiting at the back of the queue.
    jobs.unshift(...sampleJobs)

    this.received = totalBytes
    this.completed = totalCompleted
    this.task.received = this.received

    this.task.connections = Math.min(this.config.maxConnections, totalSegments)
    this.task.status = 'downloading'
    this.task.startedAt = this.task.startedAt ?? Date.now()
    this.task.detail = `${totalSegments} pieces`
    this.deps.onUpdate(this.task)

    await this.runSharedPool(jobs)
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

    const candidates: Array<{ name: string; index: number }> = []
    const pattern = new RegExp(`^${trackType}_(\\d{6})\\.part$`)
    for (const name of entries) {
      const match = pattern.exec(name)
      if (!match) continue

      const index = Number(match[1])
      if (index >= totalSegments) continue
      candidates.push({ name, index })
    }

    const found = await mapConcurrent(candidates, FILE_SCAN_CONCURRENCY, async (candidate) => ({
      index: candidate.index,
      size: (await stat(join(this.partsDir, candidate.name)).catch(() => null))?.size ?? 0
    }))
    for (const piece of found) {
      if (piece.size === 0) continue
      indices.add(piece.index)
      bytes += piece.size
    }

    return { indices, bytes }
  }

  /** Runs init segments and media pieces through one global connection pool. */
  private async runSharedPool(jobs: Array<(slot: number) => Promise<void>>): Promise<void> {
    if (jobs.length === 0) return

    let cursor = 0
    let failed = false
    let firstError: Error | null = null
    const workerCount = Math.min(this.config.maxConnections, jobs.length)
    const workers: Promise<void>[] = []

    const worker = async (slot: number): Promise<void> => {
      for (;;) {
        this.throwIfAborted()
        if (failed) return
        const index = cursor++
        if (index >= jobs.length) return

        this.active.set(slot, { bytes: 0 })
        try {
          await jobs[index](slot)
        } catch (err) {
          failed = true
          if (!firstError) firstError = err instanceof Error ? err : new Error(String(err))
          return
        } finally {
          this.active.delete(slot)
        }
      }
    }

    for (let slot = 0; slot < workerCount; slot++) workers.push(worker(slot))

    await Promise.all(workers)
    this.throwIfAborted()
    if (firstError) throw firstError
  }

  private async fetchPiece(
    track: { id: string; segments: HlsSegment[]; mediaSequence: number },
    index: number,
    slot: number
  ): Promise<void> {
    const segment = track.segments[index]
    const path = this.piecePath(track.id, index)
    let bytes: number
    if (segment.key) {
      const raw = await this.download(segment.url, segment.byteRange, slot)
      const body = await this.decrypt(raw, segment.key, track.mediaSequence + index)
      await writeAtomic(path, body)
      bytes = body.length
    } else {
      // Plain pieces go straight to their temp file. This keeps memory bounded
      // to one network chunk per connection instead of one complete HLS piece.
      bytes = await this.downloadAtomic(path, segment.url, segment.byteRange, slot)
    }

    // Count bytes only after the complete piece has been renamed into place. A
    // failed write must never make progress jump forward and report a false ETA.
    // The completed byte count now owns these bytes. Clear the live slot first
    // so a tick between completion and worker cleanup cannot count them twice.
    this.creditCompletedBytes(slot, bytes, track.id)
  }

  private creditCompletedBytes(slot: number, bytes: number, trackId?: string): void {
    const active = this.active.get(slot)
    if (active) active.bytes = 0
    this.received += bytes
    if (trackId) {
      this.completed++
      const progress = this.trackProgress.get(trackId) ?? { bytes: 0, completed: 0 }
      progress.bytes += bytes
      progress.completed++
      this.trackProgress.set(trackId, progress)
    }
  }

  /** Buffers an encrypted piece while still throttling each incoming chunk. */
  private async download(
    url: string,
    byteRange: { offset: number; length: number } | null,
    slot: number
  ): Promise<Buffer> {
    let chunks: Buffer[] = []
    await this.transfer(url, byteRange, slot, {
      reset: () => { chunks = [] },
      write: (chunk) => { chunks.push(chunk) }
    })
    return Buffer.concat(chunks)
  }

  /** Streams an unencrypted piece to a temp name and atomically publishes it. */
  private async downloadAtomic(
    path: string,
    url: string,
    byteRange: { offset: number; length: number } | null,
    slot: number
  ): Promise<number> {
    const tmp = temporaryPath(path)
    const handle = await open(tmp, 'w')
    let offset = 0
    let buf: Buffer[] = []
    let bufLen = 0

    const flush = async () => {
      if (bufLen === 0) return
      await writeAtFully(handle, Buffer.concat(buf), offset)
      offset += bufLen
      buf = []
      bufLen = 0
    }

    try {
      const bytes = await this.transfer(url, byteRange, slot, {
        reset: async () => {
          buf = []
          bufLen = 0
          offset = 0
          await handle.truncate(0)
        },
        write: async (chunk) => {
          buf.push(chunk)
          bufLen += chunk.length
          if (bufLen >= 65536) await flush()
        }
      })
      await flush()
      await handle.close()
      await rename(tmp, path)
      return bytes
    } catch (err) {
      // On success the rename already consumed the temp file - only clean it
      // up when the transfer, close or rename actually failed.
      await handle.close().catch(() => {})
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }

  /** One piece, with the same backoff discipline the byte-range worker uses. */
  private async transfer(
    url: string,
    byteRange: { offset: number; length: number } | null,
    slot: number,
    sink: { reset(): void | Promise<void>; write(chunk: Buffer): void | Promise<void> }
  ): Promise<number> {
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
        await sink.reset()
        const state = this.active.get(slot)
        if (state) state.bytes = 0
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
        if (byteRange) {
          if (res.status !== 206) {
            throw new Error('HLS byte-range request was not honoured by the server')
          }

          const contentRange = res.headers.get('content-range') ?? ''
          const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange)
          const rangeStart = match ? Number(match[1]) : NaN
          const rangeEnd = match ? Number(match[2]) : NaN
          const total = match && match[3] !== '*' ? Number(match[3]) : null
          const expectedEnd = byteRange.offset + byteRange.length - 1
          if (
            !match ||
            !Number.isSafeInteger(rangeStart) ||
            !Number.isSafeInteger(rangeEnd) ||
            (total !== null && (!Number.isSafeInteger(total) || total < rangeEnd + 1)) ||
            rangeStart !== byteRange.offset ||
            rangeEnd !== expectedEnd
          ) {
            throw new Error('HLS byte-range response did not match the requested range')
          }
        }

        if (!res.body) throw new Error('HLS response had no body')
        // Applying the budget per chunk propagates backpressure to the body
        // stream instead of downloading a whole piece in an unbounded burst.
        const received = await streamResponseBody(
          res.body,
          (chunk) => sink.write(chunk),
          (bytes) => this.deps.limiter.consume(bytes, this.controller.signal),
          this.controller.signal,
          (bytes) => { if (state) state.bytes = bytes }
        )

        if (byteRange && received !== byteRange.length) {
          throw new Error(`HLS byte-range returned ${received} bytes, expected ${byteRange.length}`)
        }
        return received
      } catch (err) {
        if (this.controller.signal.aborted) throw new AbortedError()
        // Retrying cannot conjure budget that is already spent, and burning the
        // attempts here would turn the hold into "failed after 5 attempts".
        if (err instanceof QuotaExceededError) throw err
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
      let lastError: Error | null = null
      for (let attempt = 0; attempt < this.config.retryLimit; attempt++) {
        this.throwIfAborted()
        if (attempt > 0) {
          const backoff = Math.min(15_000, 500 * 2 ** attempt) * (0.5 + Math.random())
          await delay(backoff, this.controller.signal)
        }
        try {
          const res = await fetch(key.url, {
            headers: buildHeaders(this.task.headers),
            redirect: 'follow',
            signal: this.controller.signal,
            dispatcher: getDispatcher(this.config.timeoutMs)
          } as RequestInit)

          if (!res.ok) throw new Error(`Could not fetch the decryption key (HTTP ${res.status})`)
          const candidate = Buffer.from(await res.arrayBuffer())
          if (candidate.length !== 16) throw new Error('Decryption key was not 16 bytes')
          material = candidate
          this.keys.set(key.url, material)
          lastError = null
          break
        } catch (err) {
          if (this.controller.signal.aborted) throw new AbortedError()
          lastError = err instanceof Error ? err : new Error(String(err))
        }
      }
      if (!material) {
        throw new Error(`Decryption key failed after ${this.config.retryLimit} attempts: ${lastError?.message ?? 'unknown error'}`)
      }
    }

    const decipher = createDecipheriv('aes-128-cbc', material, ivFor(key.iv, index))
    return Buffer.concat([decipher.update(body), decipher.final()])
  }

  /* ---------------------------------------------------------------- */
  /* Assembly                                                          */
  /* ---------------------------------------------------------------- */

  private async assemble(): Promise<void> {
    await rm(this.joinedVideoPath, { force: true })
    const audioTracks = this.tracks.filter((track) => track.role === 'audio')
    await Promise.all(audioTracks.map((_track, index) => rm(this.joinedAudioPath(index), { force: true })))

    let totalJoinedSize = 0

    let audioIndex = 0
    for (const track of this.tracks) {
      const outPath = track.role === 'video' ? this.joinedVideoPath : this.joinedAudioPath(audioIndex++)
      const handle = await open(outPath, 'w')
      try {
        if (track.initSegment) await appendPiece(handle, this.initPath(track.id))
        for (let index = 0; index < track.segments.length; index++) {
          this.throwIfAborted()
          await appendPiece(handle, this.piecePath(track.id, index))
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
    const muxTemp = muxTempPath(target)

    try {
      // Never let ffmpeg write the user's final filename. A process crash during
      // muxing must leave only a disposable temp artifact, not a file that looks
      // successfully completed to the next launch.
      await rm(muxTemp, { force: true }).catch(() => {})
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

      const audioTracks = this.tracks.filter((track) => track.role === 'audio')
      await mux({
        ffmpegPath,
        inputPath: this.joinedVideoPath,
        audioInputs: audioTracks.map((track, index) => ({
          path: this.joinedAudioPath(index),
          language: track.language,
          title: track.label,
          isDefault: track.isDefault
        })),
        outputPath: muxTemp,
        signal: this.controller.signal
      })

      this.throwIfAborted()
      await moveFile(muxTemp, target)
      await rm(this.joinedVideoPath, { force: true }).catch(() => {})
      await Promise.all(audioTracks.map((_track, index) => rm(this.joinedAudioPath(index), { force: true }).catch(() => {})))
      this.task.detail = null
      return target
    } catch (err) {
      await rm(muxTemp, { force: true }).catch(() => {})
      // The target name was reserved before the mux was attempted; hand it back
      // rather than leaving an empty file holding it.
      await discardReservedPath(target)
      if (this.controller.signal.aborted) throw new AbortedError()

      const reason = err instanceof Error ? err.message : String(err)

      /*
       * With a separate audio track there is no raw stream to fall back to: the
       * video half alone is a silent file, and deleting the audio to produce it
       * throws away a track that downloaded perfectly. Keep both joined halves
       * *and* the pieces - `assemble` only clears those on success - and report
       * the failure, so Start re-runs the merge rather than the download.
       */
      if (this.tracks.some((track) => track.role === 'audio')) {
        this.task.detail = null
        throw new Error(`Could not merge the video and audio tracks: ${reason}`)
      }

      log.warn(`mux unavailable or failed, keeping the raw stream: ${reason}`)
      this.task.detail = null

      const fallback = await uniquePath(
        this.task.dir,
        this.task.filename.replace(/\.([a-z0-9]+)$/i, '.ts')
      )
      await moveFile(this.joinedVideoPath, fallback)
      const audioTracks = this.tracks.filter((track) => track.role === 'audio')
      await Promise.all(audioTracks.map((_track, index) => rm(this.joinedAudioPath(index), { force: true }).catch(() => {})))

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
    const audioCount = Math.max(1, this.task.audioTracks?.length ?? (this.task.audioUrl ? 1 : 0))
    await Promise.all(Array.from({ length: audioCount }, (_value, index) =>
      rm(this.joinedAudioPath(index), { force: true }).catch(() => {})
    ))
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

export const PLAYLIST_MANIFEST_VERSION = 2

export interface PlaylistManifest {
  version: number
  identity: string
}

function buildPlaylistIdentity(tracks: ResolvedTrack[]): string {
  const canonical = tracks.map((track) => ({
    id: track.id,
    role: track.role,
    label: track.label,
    language: track.language,
    isDefault: track.isDefault,
    initSegment: track.initSegment,
    mediaSequence: track.mediaSequence,
    segments: track.segments.map((segment) => ({
      url: segment.url,
      byteRange: segment.byteRange,
      key: segment.key,
      duration: segment.duration
    }))
  }))
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

function buildLegacyPlaylistIdentity(tracks: ResolvedTrack[]): string {
  const canonical = tracks.map((track) => ({
    type: track.role,
    initSegment: track.initSegment,
    mediaSequence: track.mediaSequence,
    segments: track.segments.map((segment) => ({
      url: segment.url,
      byteRange: segment.byteRange,
      key: segment.key,
      duration: segment.duration
    }))
  }))
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

async function readPlaylistManifest(path: string): Promise<PlaylistManifest | null> {
  try {
    const raw = (await readFile(path, 'utf8')).trim()
    if (/^[0-9a-f]{64}$/i.test(raw)) {
      return { version: 1, identity: raw }
    }
    const parsed = JSON.parse(raw) as PlaylistManifest
    if (parsed && typeof parsed.version === 'number' && typeof parsed.identity === 'string') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

async function migrateLegacyPlaylistParts(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [])
  for (const name of entries) {
    const match = /^audio_(\d{6})\.part$/.exec(name)
    if (match) {
      await rename(join(dir, name), join(dir, `audio_000_${match[1]}.part`)).catch(() => {})
    } else if (name === 'audio_init.part') {
      await rename(join(dir, name), join(dir, 'audio_000_init.part')).catch(() => {})
    }
  }
}

async function clearPlaylistParts(dir: string): Promise<void> {
  const entries = await readdir(dir).catch(() => [])
  for (const name of entries) {
    if (name === '.playlist.json') continue
    await rm(join(dir, name), { recursive: false, force: true }).catch(() => {})
  }
}

/**
 * The IV for a piece: whatever EXT-X-KEY declared, or the media sequence number
 * as a 16-byte big-endian counter.
 */
function ivFor(declared: string | null, sequenceNumber: number): Buffer {
  if (declared) {
    const hex = declared.replace(/^0x/i, '')
    if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('Invalid HLS IV')
    return Buffer.from(hex, 'hex')
  }

  if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 0) throw new Error('Invalid HLS media sequence')
  const iv = Buffer.alloc(16)
  iv.writeBigUInt64BE(BigInt(sequenceNumber), 8)
  return iv
}

function muxTempPath(target: string): string {
  const dot = target.lastIndexOf('.')
  return dot > target.lastIndexOf('\\') && dot > target.lastIndexOf('/')
    ? `${target.slice(0, dot)}.draco-mux-temp${target.slice(dot)}`
    : `${target}.draco-mux-temp.mp4`
}

/** Write to a temp name and rename, so a piece file only ever exists complete. */
async function writeAtomic(path: string, body: Buffer): Promise<void> {
  const tmp = temporaryPath(path)
  const handle = await open(tmp, 'w')
  try {
    await writeAtFully(handle, body, 0)
  } finally {
    await handle.close().catch(() => {})
  }

  try {
    await rename(tmp, path)
  } catch (err) {
    // On success the rename already consumed the temp file - only clean it up
    // when the rename itself failed and left it behind.
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

function temporaryPath(path: string): string {
  return `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
}

async function writeAtFully(handle: FileHandle, body: Buffer, position: number): Promise<void> {
  let offset = 0
  while (offset < body.length) {
    const result = await handle.write(body, offset, body.length - offset, position + offset)
    const written = result.bytesWritten
    if (!Number.isSafeInteger(written) || written <= 0) throw new Error('File write made no progress')
    offset += written
  }
}

/**
 * Whole-piece reads rather than a stream: HLS segments are a few seconds of
 * video each, and the handle keeps its own write position, so this is an
 * ordinary sequential append with no offset arithmetic to get wrong.
 */
async function appendPiece(handle: FileHandle, path: string): Promise<void> {
  const body = await readFile(path)
  let offset = 0
  while (offset < body.length) {
    const result = await handle.write(body, offset, body.length - offset, null)
    const written = result.bytesWritten
    if (!Number.isSafeInteger(written) || written <= 0) throw new Error('File write made no progress')
    offset += written
  }
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

