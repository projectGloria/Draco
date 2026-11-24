import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DownloadTask, Segment } from '../../shared/types.ts'
import { isPlayableMediaTask, mimeTypeForMediaFilename } from '../../shared/playable-media.ts'
import type { DownloadManager } from '../engine/manager.ts'
import { readJournal } from '../engine/journal.ts'
import { halfSuffix } from '../engine/naming.ts'
import { Segmenter } from '../engine/segmenter.ts'
import { TaskRunner } from '../engine/task.ts'
import { TorrentRunner } from '../engine/torrent.ts'
import { resolveTorrentItemPath } from '../engine/torrent-path.ts'
import { partPathFor, taskWorkspaceDir } from '../engine/workspace.ts'
import { DashRunner } from '../hls/dash.ts'
import { HlsRunner } from '../hls/runner.ts'

const READ_CHUNK_SIZE = 256 * 1024
const POLL_INTERVAL_MS = 120
const MAX_WAIT_MS = 45_000

export interface ByteSource {
  filePath(): Promise<string | null>
  totalSize(): Promise<number | null>
  availableBytesAt(offset: number, prioritize: boolean): Promise<number>
  mimeType(): string
}

function parseHttpRange(rangeHeader: string | null, totalSize: number): { start: number; end: number } | null {
  if (!rangeHeader) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim())
  if (!match) return null

  const rawStart = match[1]
  const rawEnd = match[2]
  if (!rawStart && !rawEnd) return null

  if (!rawStart) {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
    const start = Math.max(0, totalSize - suffixLength)
    return { start, end: Math.max(start, totalSize - 1) }
  }

  const start = Number(rawStart)
  const end = rawEnd ? Math.min(totalSize - 1, Number(rawEnd)) : totalSize - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalSize || end < start) {
    return null
  }
  return { start, end }
}

/**
 * Computes contiguous written bytes starting at `offset` from a snapshot of segments.
 */
export function contiguousWrittenBytesFromSegments(
  segments: readonly Segment[],
  size: number | null,
  offset: number
): number {
  if (offset < 0 || (size !== null && offset >= size)) return 0
  if (segments.length === 0) return 0
  const segmenter = Segmenter.restore([...segments], size, 64 * 1024)
  return segmenter.contiguousBytesAt(offset)
}

/**
 * Resolves a live byte source for a single HTTP download, one half of a dual-stream
 * download, or a torrent payload file.
 */
export function createTaskByteSource(
  manager: DownloadManager,
  taskId: string,
  tempDir?: string,
  options?: { track?: 'video' | 'audio'; torrentFilePath?: string }
): ByteSource | null {
  const task = manager.get(taskId)
  if (!task) return null

  const track = options?.track ?? 'video'

  if (task.kind === 'torrent') {
    const runner = manager.getRunner(taskId)
    const torrentRunner = runner instanceof TorrentRunner ? runner : null
    const chosen = torrentRunner?.prioritizeSequentialFile(options?.torrentFilePath)
    const files = task.torrentInfo?.files ?? task.torrentFiles ?? []
    const allowedPaths = files.map((f) => f.path)
    const targetRelPath =
      chosen?.path ??
      options?.torrentFilePath ??
      files.find((f) => isPlayableMediaTask({ filename: f.path }))?.path ??
      files[0]?.path
    if (!targetRelPath) return null

    return {
      async filePath(): Promise<string | null> {
        return resolveTorrentItemPath(task.dir, targetRelPath, allowedPaths)
      },
      async totalSize(): Promise<number | null> {
        const currentTask = manager.get(taskId)
        const fileEntry =
          currentTask?.torrentInfo?.files.find((f) => f.path === targetRelPath) ??
          currentTask?.torrentFiles?.find((f) => f.path === targetRelPath)
        if (fileEntry && fileEntry.size > 0) return fileEntry.size
        const fullPath = resolveTorrentItemPath(task.dir, targetRelPath, allowedPaths)
        if (!fullPath) return null
        const info = await stat(fullPath).catch(() => null)
        return info?.isFile() ? info.size : null
      },
      async availableBytesAt(offset: number, prioritize: boolean): Promise<number> {
        const currentTask = manager.get(taskId)
        if (!currentTask) return 0
        if (currentTask.status === 'done') {
          const total = await this.totalSize()
          return total !== null ? Math.max(0, total - offset) : 0
        }
        const liveRunner = manager.getRunner(taskId)
        if (liveRunner instanceof TorrentRunner) {
          return liveRunner.readTorrentFileProgressAt(targetRelPath, offset, prioritize)
        }
        const fileEntry = currentTask.torrentInfo?.files.find((f) => f.path === targetRelPath)
        if (fileEntry) {
          return offset < fileEntry.downloaded ? fileEntry.downloaded - offset : 0
        }
        return 0
      },
      mimeType(): string {
        return mimeTypeForMediaFilename(targetRelPath, task.mimeType)
      }
    }
  }

  // Dual-stream task (video + separate audio, e.g. YouTube 1080p+)
  if (task.audioUrl) {
    const isAudio = track === 'audio'
    const childId = isAudio ? `${task.id}-a` : `${task.id}-v`
    const suffix = isAudio
      ? halfSuffix('a', 'm4a', task.youtube?.audioFormatId)
      : halfSuffix('v', 'mp4', task.youtube?.videoFormatId)
    const childFilename = task.filename + suffix

    return {
      async filePath(): Promise<string | null> {
        const currentTask = manager.get(taskId)
        if (!currentTask) return null
        // If overall muxed task is done and track === 'video' (or single stream), check final file
        const finalMerged = join(currentTask.dir, currentTask.filename)
        if (currentTask.status === 'done') {
          const s = await stat(finalMerged).catch(() => null)
          if (s?.isFile()) return finalMerged
        }
        const finishedHalf = join(currentTask.dir, childFilename)
        const halfStat = await stat(finishedHalf).catch(() => null)
        if (halfStat?.isFile() && halfStat.size > 0) return finishedHalf

        const partPath = partPathFor(currentTask.dir, childFilename, childId, tempDir)
        const partStat = await stat(partPath).catch(() => null)
        return partStat?.isFile() ? partPath : null
      },
      async totalSize(): Promise<number | null> {
        const currentTask = manager.get(taskId)
        if (!currentTask) return null
        if (currentTask.status === 'done') {
          const finalStat = await stat(join(currentTask.dir, currentTask.filename)).catch(() => null)
          if (finalStat?.isFile()) return finalStat.size
        }
        const liveRunner = manager.getRunner(taskId)
        if (liveRunner instanceof DashRunner) {
          const childRunner = isAudio ? liveRunner.audioTaskRunner : liveRunner.videoTaskRunner
          if (childRunner.task.size !== null) return childRunner.task.size
        }
        const finishedHalf = join(currentTask.dir, childFilename)
        const halfStat = await stat(finishedHalf).catch(() => null)
        if (halfStat?.isFile() && halfStat.size > 0) return halfStat.size

        const partPath = partPathFor(currentTask.dir, childFilename, childId, tempDir)
        const journal = await readJournal(partPath + '.json').catch(() => null)
        if (journal?.size) return journal.size
        const partStat = await stat(partPath).catch(() => null)
        return partStat?.isFile() && partStat.size > 0 ? partStat.size : null
      },
      async availableBytesAt(offset: number, prioritize: boolean): Promise<number> {
        const currentTask = manager.get(taskId)
        if (!currentTask) return 0
        if (currentTask.status === 'done') {
          const total = await this.totalSize()
          return total !== null ? Math.max(0, total - offset) : 0
        }
        const finishedHalf = join(currentTask.dir, childFilename)
        const halfStat = await stat(finishedHalf).catch(() => null)
        if (halfStat?.isFile() && halfStat.size > 0) {
          return Math.max(0, halfStat.size - offset)
        }
        const liveRunner = manager.getRunner(taskId)
        if (liveRunner instanceof DashRunner) {
          const childRunner = isAudio ? liveRunner.audioTaskRunner : liveRunner.videoTaskRunner
          return childRunner.readProgressAt(offset, prioritize)
        }
        const partPath = partPathFor(currentTask.dir, childFilename, childId, tempDir)
        const journal = await readJournal(partPath + '.json').catch(() => null)
        if (journal && journal.segments.length > 0) {
          return contiguousWrittenBytesFromSegments(
            journal.segments.map((s) => ({ ...s, active: false })),
            journal.size,
            offset
          )
        }
        return 0
      },
      mimeType(): string {
        return isAudio ? 'audio/mp4' : mimeTypeForMediaFilename(task.filename, task.mimeType)
      }
    }
  }

  // Standard single-file HTTP download
  return {
    async filePath(): Promise<string | null> {
      const currentTask = manager.get(taskId)
      if (!currentTask) return null
      const finalPath = join(currentTask.dir, currentTask.filename)
      const finalStat = await stat(finalPath).catch(() => null)
      if (finalStat?.isFile() && (currentTask.status === 'done' || finalStat.size > 0)) {
        return finalPath
      }
      const partPath = partPathFor(currentTask.dir, currentTask.filename, currentTask.id, tempDir)
      const partStat = await stat(partPath).catch(() => null)
      return partStat?.isFile() ? partPath : null
    },
    async totalSize(): Promise<number | null> {
      const currentTask = manager.get(taskId)
      if (!currentTask) return null
      if (currentTask.size !== null && currentTask.size > 0) return currentTask.size
      const path = await this.filePath()
      if (!path) return null
      const info = await stat(path).catch(() => null)
      return info?.isFile() && info.size > 0 ? info.size : null
    },
    async availableBytesAt(offset: number, prioritize: boolean): Promise<number> {
      const currentTask = manager.get(taskId)
      if (!currentTask) return 0
      if (currentTask.status === 'done') {
        const total = await this.totalSize()
        return total !== null ? Math.max(0, total - offset) : 0
      }
      const finalPath = join(currentTask.dir, currentTask.filename)
      const finalStat = await stat(finalPath).catch(() => null)
      if (finalStat?.isFile() && finalStat.size > 0) {
        return Math.max(0, finalStat.size - offset)
      }
      const liveRunner = manager.getRunner(taskId)
      if (liveRunner instanceof TaskRunner) {
        return liveRunner.readProgressAt(offset, prioritize)
      }
      if (currentTask.segments.length > 0) {
        return contiguousWrittenBytesFromSegments(currentTask.segments, currentTask.size, offset)
      }
      const partPath = partPathFor(currentTask.dir, currentTask.filename, currentTask.id, tempDir)
      const journal = await readJournal(partPath + '.json').catch(() => null)
      if (journal && journal.segments.length > 0) {
        return contiguousWrittenBytesFromSegments(
          journal.segments.map((s) => ({ ...s, active: false })),
          journal.size,
          offset
        )
      }
      return offset < currentTask.received ? currentTask.received - offset : 0
    },
    mimeType(): string {
      return mimeTypeForMediaFilename(task.filename, task.mimeType)
    }
  }
}

/**
 * Serves an HTTP request (including `Range: bytes=start-end`) against a live
 * `ByteSource`. If the requested byte offset lies in an unwritten hole while the
 * download is running, this stream waits for the downloader to fill that region
 * (having nudged the segmenter to prioritize it) and streams bytes smoothly as
 * they land on disk.
 */
export async function serveByteSourceResponse(
  source: ByteSource,
  request: Request,
  isDownloadActive: () => boolean
): Promise<Response> {
  let filePath = await source.filePath()
  let totalSize = await source.totalSize()

  // If the download was just started or probing, give it up to a few seconds to create the part file
  const waitStart = Date.now()
  while ((!filePath || totalSize === null || totalSize <= 0) && isDownloadActive() && Date.now() - waitStart < 10_000) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    if (request.signal.aborted) return new Response(null, { status: 499 })
    filePath = await source.filePath()
    totalSize = await source.totalSize()
  }

  if (!filePath || totalSize === null || totalSize <= 0) {
    return new Response('Media file is not available on disk yet', { status: 404 })
  }

  const rangeHeader = request.headers.get('range')
  const parsedRange = parseHttpRange(rangeHeader, totalSize)
  if (rangeHeader && !parsedRange) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${totalSize}` }
    })
  }

  const start = parsedRange ? parsedRange.start : 0
  const end = parsedRange ? parsedRange.end : totalSize - 1
  const contentLength = end - start + 1

  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': source.mimeType(),
    'Content-Length': String(contentLength),
    'Cache-Control': 'no-store'
  }
  if (parsedRange) {
    headers['Content-Range'] = `bytes ${start}-${end}/${totalSize}`
  }

  if (request.method === 'HEAD') {
    return new Response(null, { status: parsedRange ? 206 : 200, headers })
  }

  let cursor = start
  let cancelled = false

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!cancelled && !request.signal.aborted) {
        const remaining = end - cursor + 1
        if (remaining <= 0) {
          controller.close()
          return
        }

        let available = await source.availableBytesAt(cursor, true)
        if (available <= 0) {
          const stallStart = Date.now()
          while (available <= 0 && !cancelled && !request.signal.aborted) {
            if (!isDownloadActive() && Date.now() - stallStart > 1500) {
              // Task is paused/stopped and the requested range has not been downloaded yet.
              controller.close()
              return
            }
            if (Date.now() - stallStart > MAX_WAIT_MS) {
              controller.close()
              return
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
            available = await source.availableBytesAt(cursor, true)
          }
        }

        if (cancelled || request.signal.aborted) return

        const currentPath = (await source.filePath()) ?? filePath!
        const toRead = Math.min(remaining, available, READ_CHUNK_SIZE)
        const buffer = Buffer.allocUnsafe(toRead)
        let bytesRead = 0
        const handle = await open(currentPath, 'r').catch(() => null)
        if (!handle) {
          controller.close()
          return
        }
        try {
          const res = await handle.read(buffer, 0, toRead, cursor)
          bytesRead = res.bytesRead
        } finally {
          await handle.close().catch(() => {})
        }

        if (bytesRead <= 0) {
          if (!isDownloadActive()) {
            controller.close()
            return
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
          continue
        }

        cursor += bytesRead
        controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead))
        return
      }
    },
    cancel() {
      cancelled = true
    }
  })

  return new Response(stream, {
    status: parsedRange ? 206 : 200,
    headers
  })
}

/**
 * Concatenates already-completed HLS pieces on the fly so an in-progress HLS
 * download can be watched smoothly up to the latest downloaded piece.
 */
async function serveHlsProgressiveResponse(
  manager: DownloadManager,
  task: DownloadTask,
  trackRole: 'video' | 'audio',
  request: Request,
  tempDir?: string
): Promise<Response> {
  // If task already finished and muxed, serve the completed file directly
  if (task.status === 'done') {
    const source = createTaskByteSource(manager, task.id, tempDir, { track: 'video' })
    if (source) return serveByteSourceResponse(source, request, () => false)
  }

  const partsDir = join(taskWorkspaceDir(task.dir, task.id, tempDir), task.filename + '.dracoparts')
  const entries: string[] = await readdir(partsDir).catch((): string[] => [])
  const prefix = trackRole === 'audio' ? 'audio_000_' : 'video_'
  const initName = `${prefix}init.part`
  const hasInit = entries.includes(initName)

  const pieceFiles = entries
    .filter((name) => name.startsWith(prefix) && name !== initName && name.endsWith('.part'))
    .sort()

  // Only include contiguous completed pieces starting from index 0
  const contiguousPieces: string[] = []
  for (let i = 0; i < pieceFiles.length; i++) {
    const expected = `${prefix}${String(i).padStart(6, '0')}.part`
    if (pieceFiles[i] !== expected) break
    contiguousPieces.push(join(partsDir, expected))
  }

  if (contiguousPieces.length === 0) {
    return new Response('Waiting for first video segments to finish downloading…', { status: 404 })
  }

  const allFiles = hasInit ? [join(partsDir, initName), ...contiguousPieces] : contiguousPieces
  let fileIndex = 0
  let cancelled = false

  const contentType = hasInit ? (trackRole === 'audio' ? 'audio/mp4' : 'video/mp4') : 'video/mp2t'
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (!cancelled && !request.signal.aborted) {
        if (fileIndex >= allFiles.length) {
          // Check if newer contiguous pieces have landed while the user was watching!
          const nextPieceIndex = hasInit ? fileIndex - 1 : fileIndex
          const nextPiecePath = join(partsDir, `${prefix}${String(nextPieceIndex).padStart(6, '0')}.part`)
          const exists = await stat(nextPiecePath).catch(() => null)
          if (exists?.isFile() && exists.size > 0) {
            allFiles.push(nextPiecePath)
          } else {
            controller.close()
            return
          }
        }

        const currentFile = allFiles[fileIndex++]
        const handle = await open(currentFile, 'r').catch(() => null)
        if (!handle) {
          controller.close()
          return
        }
        try {
          const info = await handle.stat()
          const buf = Buffer.allocUnsafe(info.size)
          const { bytesRead } = await handle.read(buf, 0, info.size, 0)
          if (bytesRead > 0) {
            controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead))
            return
          }
        } finally {
          await handle.close().catch(() => {})
        }
      }
    },
    cancel() {
      cancelled = true
    }
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store'
    }
  })
}

/** Resolves the title and any separate audio track for the external player. */
export async function resolveWatchSession(
  manager: DownloadManager,
  taskId: string,
  torrentFilePath?: string
): Promise<{ title: string; hasDualTrack: boolean }> {
  const task = manager.get(taskId)
  if (!task) throw new Error('Download was not found')
  if (!isPlayableMediaTask(task)) {
    throw new Error('This download is not a playable video or audio file')
  }

  // Check if final muxed file already exists on disk
  const finalPath = join(task.dir, task.filename)
  const finalStat = await stat(finalPath).catch(() => null)
  const isFinalOnDisk = Boolean(finalStat?.isFile() && finalStat.size > 0 && task.status === 'done')

  let hasDualTrack = false
  if (task.audioUrl && !isFinalOnDisk) {
    hasDualTrack = true
  } else if (task.kind === 'hls' && !isFinalOnDisk) {
    const runner = manager.getRunner(taskId)
    if (runner instanceof HlsRunner) {
      const hls = runner.liveHlsState()
      hasDualTrack = Boolean(hls?.audio)
    } else {
      hasDualTrack = Boolean(task.audioUrl || (task.audioTracks && task.audioTracks.length > 0))
    }
  }

  let selectedTorrentFile: string | undefined
  if (task.kind === 'torrent') {
    const runner = manager.getRunner(taskId)
    if (runner instanceof TorrentRunner) {
      const chosen = runner.prioritizeSequentialFile(torrentFilePath)
      selectedTorrentFile = chosen?.path
    }
    if (!selectedTorrentFile) {
      const files = task.torrentInfo?.files ?? task.torrentFiles ?? []
      selectedTorrentFile =
        torrentFilePath ??
        files.find((f) => isPlayableMediaTask({ filename: f.path }))?.path ??
        files[0]?.path
    }
  }

  return {
    title: selectedTorrentFile ? `${task.filename} — ${selectedTorrentFile}` : task.filename,
    hasDualTrack
  }
}

/**
 * Serves byte-range requests forwarded by the external player's loopback server.
 */
export async function handleMediaProtocolRequest(
  request: Request,
  manager: DownloadManager,
  tempDir?: string
): Promise<Response> {
  let parsed: URL
  try {
    parsed = new URL(request.url)
  } catch {
    return new Response('Invalid media URL', { status: 400 })
  }

  const rawId = parsed.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
  const taskId = decodeURIComponent(rawId)
  if (!taskId) return new Response('Missing task ID', { status: 400 })

  const task = manager.get(taskId)
  if (!task) return new Response('Task not found', { status: 404 })

  const track = parsed.searchParams.get('track') === 'audio' ? 'audio' : 'video'
  const torrentFilePath = parsed.searchParams.get('file') ?? undefined

  if (task.kind === 'hls') {
    return serveHlsProgressiveResponse(manager, task, track, request, tempDir)
  }

  const source = createTaskByteSource(manager, taskId, tempDir, { track, torrentFilePath })
  if (!source) return new Response('Media source unavailable', { status: 404 })

  const isDownloadActive = (): boolean => {
    const current = manager.get(taskId)
    return Boolean(
      current &&
      (current.status === 'downloading' ||
        current.status === 'probing' ||
        current.status === 'queued' ||
        current.status === 'processing')
    )
  }

  return serveByteSourceResponse(source, request, isDownloadActive)
}
