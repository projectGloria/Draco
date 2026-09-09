import type { Torrent } from 'webtorrent'
import type { DownloadTask } from '../../shared/types.ts'
import type { Runner, SeedSession } from './runner.ts'
import type { RunnerContext } from './manager.ts'
import { DEFAULT_TORRENT_TRACKERS } from './create.ts'
import { fetchCachedTorrentDescriptor } from './probe.ts'
import { localTorrentDescriptor } from './torrent-store.ts'
import { QuotaExceededError } from './limiter.ts'

interface TorrentProgressFile {
  path: string
  length: number
  downloaded: number
}

export function selectedTorrentDownloaded(
  files: TorrentProgressFile[],
  selectedFiles?: string[]
): number {
  const selected = selectedFiles ? new Set(selectedFiles) : null
  return files
    .filter((file) => !selected || selected.has(file.path))
    .reduce((total, file) => total + Math.min(file.length, Math.max(0, file.downloaded)), 0)
}

export function selectedTorrentComplete(
  files: TorrentProgressFile[],
  selectedFiles?: string[]
): boolean {
  const selected = selectedFiles ? new Set(selectedFiles) : null
  const relevant = files.filter((file) => !selected || selected.has(file.path))
  if (relevant.length === 0 || (selected && relevant.length !== selected.size)) return false
  return relevant.every((file) => file.downloaded >= file.length)
}

export function torrentDownloadOptions(path: string): { path: string; deselect: true } {
  return { path, deselect: true }
}

/**
 * The live torrent panel the details dialog reads. Built out here rather than
 * inside the runner because a seeding session outlives the runner that produced
 * it and has to keep the same panel up to date.
 */
function torrentInfoOf(torrent: Torrent, selectedFiles?: string[]): DownloadTask['torrentInfo'] {
  const selected = selectedFiles ? new Set(selectedFiles) : null
  return {
    infoHash: torrent.infoHash,
    files: torrent.files.map((file) => ({
      path: file.path,
      size: file.length,
      downloaded: Math.min(file.length, Math.max(0, file.downloaded)),
      selected: !selected || selected.has(file.path)
    })),
    peers: torrent.wires.slice(0, 250).map((wire: any) => ({
      address: wire.remoteAddress && wire.remotePort
        ? `${wire.remoteAddress}:${wire.remotePort}`
        : wire.type || 'Connected peer',
      client: String(wire.peerExtendedHandshake?.v || wire.peerId || 'Unknown'),
      type: String(wire.type || 'peer'),
      downloadSpeed: Number(wire.downloadSpeed?.() || 0),
      uploadSpeed: Number(wire.uploadSpeed?.() || 0)
    })),
    trackers: [...torrent.announce],
    sources: [...torrent.urlList],
    uploaded: torrent.uploaded,
    ratio: Number.isFinite(torrent.ratio) ? torrent.ratio : 0
  }
}

export class TorrentRunner implements Runner {
  public running = false
  private client: any | null = null
  private torrent: Torrent | null = null

  public readonly task: DownloadTask
  private readonly context: RunnerContext
  private lastReportedDownloaded = 0

  constructor(
    task: DownloadTask,
    context: RunnerContext
  ) {
    this.task = task
    this.context = context
    this.lastReportedDownloaded = task.received || 0
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.task.status = 'downloading'
    this.task.detail = 'Finding torrent metadata…'
    this.context.onUpdate(this.task)

    // Bypass Vite's CommonJS transpilation so we use the real Node.js dynamic import
    const wt = await (new Function("return import('webtorrent')")())
    const WebTorrentModule = wt.default || wt
    this.client = new (WebTorrentModule as any)()
    this.applyThrottles()

    // Start with no pieces selected. WebTorrent otherwise selects the entire
    // payload before its metadata event, which can queue hundreds of megabytes
    // before Draco gets a chance to deselect unwanted files.
    let torrentId: string | Uint8Array = this.task.url
    if (this.task.url.startsWith('magnet:')) {
      try {
        // Draco's own copy first: a torrent added from a file needs no
        // discovery at all, and its descriptor is authoritative where a public
        // cache is merely convenient.
        const cached =
          (await localTorrentDescriptor(this.task.url)) ??
          (await fetchCachedTorrentDescriptor(this.task.url, undefined))
        if (!this.running) {
          this.cleanup()
          return
        }
        if (cached) torrentId = cached.torrentId
      } catch {}
    }


    this.torrent = this.client.add(
      torrentId,
      { ...torrentDownloadOptions(this.task.dir), announce: [...DEFAULT_TORRENT_TRACKERS] }
    ) as Torrent

    this.torrent.on('metadata', () => {
      if (!this.running || !this.torrent) return
      
      if (this.task.selectedFiles) {
        const selected = new Set(this.task.selectedFiles)
        this.torrent.files.forEach((file: any) => {
          if (!selected.has(file.path)) {
            file.deselect()
          } else {
            file.select()
          }
        })
        this.task.size = this.torrent.files
          .filter((f: any) => selected.has(f.path))
          .reduce((sum: number, f: any) => sum + f.length, 0)
      } else {
        this.task.size = this.torrent.length
      }

      this.task.resumable = true
      this.task.received = this.selectedDownloaded()
      this.task.detail = this.torrent.wires.length > 0 ? null : 'Metadata ready · waiting for peers…'
      this.updateTorrentInfo()
      if (this.selectedComplete()) this.complete()
      else this.context.onUpdate(this.task)
    })

    this.torrent.on('done', () => this.complete())
    this.torrent.on('wire', () => {
      if (!this.running) return
      this.task.detail = null
      this.context.onUpdate(this.task)
    })
    this.torrent.on('noPeers', () => {
      if (!this.running) return
      this.task.detail = this.torrent?.metadata
        ? 'Metadata ready · waiting for peers…'
        : 'Finding torrent metadata…'
      this.context.onUpdate(this.task)
    })

    this.torrent.on('error', (err: Error | string) => {
      if (!this.running) return
      this.task.status = 'error'
      this.task.detail = null
      this.task.error = typeof err === 'string' ? err : err.message
      this.context.onUpdate(this.task)
      this.context.onFinished(this.task, typeof err === 'string' ? new Error(err) : err)
      this.cleanup()
    })

    this.client.on('error', (err: Error | string) => {
      if (!this.running) return
      this.task.status = 'error'
      this.task.detail = null
      this.task.error = typeof err === 'string' ? err : err.message
      this.context.onUpdate(this.task)
      this.context.onFinished(this.task, typeof err === 'string' ? new Error(err) : err)
      this.cleanup()
    })
  }

  async pause(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.task.status = 'paused'
    this.task.detail = null
    this.task.speed = 0
    this.task.eta = null
    this.context.onUpdate(this.task)
    this.cleanup()
  }

  tick(): void {
    if (!this.running || !this.torrent) return

    this.applyThrottles()

    const downloaded = this.selectedDownloaded()
    const delta = downloaded - this.lastReportedDownloaded
    if (delta > 0) {
      this.lastReportedDownloaded = downloaded
      void this.context.limiter.consume(delta).catch((err) => {
        if (err instanceof QuotaExceededError) {
          void this.pause()
          this.task.detail = 'Transfer quota reached'
          this.context.onUpdate(this.task)
        }
      })
    }

    this.task.received = Math.min(downloaded, this.task.size ?? downloaded)
    if (this.selectedComplete()) {
      this.complete()
      return
    }
    this.task.speed = this.torrent.downloadSpeed
    this.task.detail = this.torrent.metadata
      ? this.torrent.wires.length === 0
        ? 'Metadata ready · waiting for peers…'
        : this.task.speed > 0 ? null : `Connected to ${this.torrent.wires.length} peer${this.torrent.wires.length === 1 ? '' : 's'} · waiting for data…`
      : 'Finding torrent metadata…'
    this.updateTorrentInfo()

    const remaining = this.task.size ? Math.max(0, this.task.size - this.task.received) : 0
    if (this.task.speed > 0 && remaining > 0) {
      this.task.eta = remaining / this.task.speed
    } else {
      this.task.eta = null
    }
  }

  async resetForRestart(): Promise<boolean> {
    return false
  }

  /**
   * Pushes the current caps at the client.
   *
   * Download follows the app-wide limiter every other runner obeys. Upload is a
   * separate setting on purpose: sharing one cap would make giving back cost
   * the user the speed they set for getting, and then nobody leaves seeding on.
   */
  private applyThrottles(): void {
    if (!this.client) return
    if (typeof this.client.throttleDownload === 'function') {
      this.client.throttleDownload(this.context.limiter.limit ?? -1)
    }
    if (typeof this.client.throttleUpload === 'function') {
      this.client.throttleUpload(this.context.uploadLimit ?? -1)
    }
  }

  /**
   * Changes which files this torrent is fetching, while it is running.
   *
   * Deselecting is not the same as never having selected: pieces already on
   * disk stay where they are, so unticking a file stops it growing rather than
   * deleting it. Size and received are recomputed from the new selection,
   * because a progress bar measured against files nobody is fetching any more
   * would never reach the end.
   */
  setSelectedFiles(paths: string[] | undefined): void {
    this.task.selectedFiles = paths
    if (!this.torrent || !this.torrent.metadata) return

    const selected = paths ? new Set(paths) : null
    for (const file of this.torrent.files as any[]) {
      if (!selected || selected.has(file.path)) file.select()
      else file.deselect()
    }

    this.task.size = selected
      ? (this.torrent.files as any[])
          .filter((file) => selected.has(file.path))
          .reduce((sum: number, file: any) => sum + file.length, 0)
      : this.torrent.length

    const downloaded = this.selectedDownloaded()
    this.task.received = Math.min(downloaded, this.task.size ?? downloaded)
    // The limiter was already charged for whatever arrived; re-baseline so a
    // shrunken selection is not read as a negative delta on the next tick.
    this.lastReportedDownloaded = downloaded
    this.updateTorrentInfo()

    if (this.running && this.selectedComplete()) this.complete()
    else this.context.onUpdate(this.task)
  }

  /** WebTorrent's torrent-level counter includes pieces for unselected files. */
  private selectedDownloaded(): number {
    if (!this.torrent) return 0
    return selectedTorrentDownloaded(this.torrent.files, this.task.selectedFiles)
  }

  private selectedComplete(): boolean {
    if (!this.torrent) return false
    return selectedTorrentComplete(this.torrent.files, this.task.selectedFiles)
  }

  private updateTorrentInfo(): void {
    if (!this.torrent) return
    this.task.torrentInfo = torrentInfoOf(this.torrent, this.task.selectedFiles)
  }

  private complete(): void {
    if (!this.running || !this.torrent) return
    this.running = false
    this.task.status = 'done'
    this.task.detail = null
    this.task.received = this.task.size ?? this.selectedDownloaded()
    this.task.speed = 0
    this.task.eta = null
    this.updateTorrentInfo()
    this.context.onUpdate(this.task)

    // Hand the live swarm connection to the manager instead of destroying it.
    // The download is over either way - `onFinished` still runs, the row still
    // goes green, the queue still starts the next task - but the peers who made
    // this download possible keep an upload to talk to.
    if (!this.handOverForSeeding()) this.cleanup()

    this.context.onFinished(this.task, null)
  }

  /**
   * Detaches the client from this runner and registers it as a seed.
   *
   * Ownership moves wholesale: the runner drops its references first, so a
   * later `pause` or `cleanup` here can never destroy a client the manager is
   * still ticking. Returns false when nothing took it on, in which case the
   * caller tears the client down as before.
   */
  private handOverForSeeding(): boolean {
    const client = this.client
    const torrent = this.torrent
    if (!client || !torrent || !this.context.onSeed) return false

    this.client = null
    this.torrent = null

    const task = this.task
    let stopped = false

    const session: SeedSession = {
      taskId: task.id,
      progress: () => ({
        uploaded: Number(torrent.uploaded) || 0,
        ratio: Number.isFinite(torrent.ratio) ? torrent.ratio : 0,
        uploadSpeed: Number(torrent.uploadSpeed) || 0,
        peers: torrent.wires?.length ?? 0
      }),
      refreshInfo: () => {
        if (stopped) return
        task.torrentInfo = torrentInfoOf(torrent, task.selectedFiles)
      },
      applyUploadLimit: (bytesPerSecond) => {
        if (stopped || typeof (client as any).throttleUpload !== 'function') return
        ;(client as any).throttleUpload(bytesPerSecond ?? -1)
      },
      stop: () => {
        if (stopped) return
        stopped = true
        try {
          client.destroy()
        } catch {
          // A client that is already gone is the outcome this wanted anyway.
        }
      }
    }

    this.context.onSeed(task, session)
    return true
  }

  private cleanup(): void {
    if (this.client) {
      this.client.destroy()
      this.client = null
    }
    this.torrent = null
  }
}
