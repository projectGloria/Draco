import type { Torrent } from 'webtorrent'
import type { DownloadTask } from '../../shared/types.ts'
import type { Runner } from './runner.ts'
import type { RunnerContext } from './manager.ts'
import { DEFAULT_TORRENT_TRACKERS } from './create.ts'
import { fetchCachedTorrentDescriptor } from './probe.ts'
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
    if (typeof this.client.throttleDownload === 'function') {
      const limit = this.context.limiter.limit ?? -1
      this.client.throttleDownload(limit)
    }

    // Start with no pieces selected. WebTorrent otherwise selects the entire
    // payload before its metadata event, which can queue hundreds of megabytes
    // before Draco gets a chance to deselect unwanted files.
    let torrentId: string | Uint8Array = this.task.url
    if (this.task.url.startsWith('magnet:')) {
      try {
        const cached = await fetchCachedTorrentDescriptor(this.task.url, undefined)
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

    if (typeof this.client?.throttleDownload === 'function') {
      const limit = this.context.limiter.limit ?? -1
      this.client.throttleDownload(limit)
    }

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
    const selected = this.task.selectedFiles ? new Set(this.task.selectedFiles) : null
    this.task.torrentInfo = {
      infoHash: this.torrent.infoHash,
      files: this.torrent.files.map((file) => ({
        path: file.path,
        size: file.length,
        downloaded: Math.min(file.length, Math.max(0, file.downloaded)),
        selected: !selected || selected.has(file.path)
      })),
      peers: this.torrent.wires.slice(0, 250).map((wire: any) => ({
        address: wire.remoteAddress && wire.remotePort
          ? `${wire.remoteAddress}:${wire.remotePort}`
          : wire.type || 'Connected peer',
        client: String(wire.peerExtendedHandshake?.v || wire.peerId || 'Unknown'),
        type: String(wire.type || 'peer'),
        downloadSpeed: Number(wire.downloadSpeed?.() || 0),
        uploadSpeed: Number(wire.uploadSpeed?.() || 0)
      })),
      trackers: [...this.torrent.announce],
      sources: [...this.torrent.urlList],
      uploaded: this.torrent.uploaded,
      ratio: Number.isFinite(this.torrent.ratio) ? this.torrent.ratio : 0
    }
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
    this.cleanup()
    this.context.onFinished(this.task, null)
  }

  private cleanup(): void {
    if (this.client) {
      this.client.destroy()
      this.client = null
    }
    this.torrent = null
  }
}
