import type { Torrent } from 'webtorrent'
import type { DownloadTask } from '../../shared/types.ts'
import type { Runner, SeedSession } from './runner.ts'
import type { RunnerContext } from './manager.ts'
import { DEFAULT_TORRENT_TRACKERS } from './create.ts'
import { fetchCachedTorrentDescriptor } from './probe.ts'
import { localTorrentDescriptor } from './torrent-store.ts'

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

/** How often the details panel may be rebuilt while it is being watched. */
const INFO_REFRESH_MS = 1000
const TORRENT_QUOTA_UNSUPPORTED = 'Torrent downloads cannot honor the active transfer quota because WebTorrent receives pieces before Draco can count their network bytes. Turn off the quota before retrying this torrent.'

export class TorrentRunner implements Runner {
  public running = false
  private client: any | null = null
  private torrent: Torrent | null = null
  private controller = new AbortController()
  private cleanupPromise: Promise<void> | null = null

  public readonly task: DownloadTask
  private readonly context: RunnerContext
  /** When the diagnostics panel was last rebuilt - see `updateTorrentInfo`. */
  private lastInfoAt = 0

  constructor(
    task: DownloadTask,
    context: RunnerContext
  ) {
    this.task = task
    this.context = context
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.controller = new AbortController()
    this.task.status = 'downloading'
    this.task.detail = 'Finding torrent metadata…'
    this.context.onUpdate(this.task)

    try {
      if (this.context.limiter.hasTransferQuota) throw new Error(TORRENT_QUOTA_UNSUPPORTED)
      await this.startClient()
    } catch (err) {
      // The runner contract (engine/runner.ts): every stop path must end in
      // onFinished, or the manager's concurrency slot leaks and schedule()
      // skips this task forever. A failed webtorrent import, a throwing
      // constructor, or a synchronous client.add() all land here.
      if (!this.running) return
      this.running = false
      this.task.status = 'error'
      this.task.detail = null
      this.task.error = err instanceof Error ? err.message : String(err)
      this.context.onUpdate(this.task)
      await this.cleanup()
      this.context.onFinished(this.task, err instanceof Error ? err : new Error(String(err)))
    }
  }

  private async startClient(): Promise<void> {
    // Bypass Vite's CommonJS transpilation so we use the real Node.js dynamic import
    const wt = await (new Function("return import('webtorrent')")())
    if (!this.running) return
    if (this.context.limiter.hasTransferQuota) throw new Error(TORRENT_QUOTA_UNSUPPORTED)
    const WebTorrentModule = wt.default || wt
    this.client = new (WebTorrentModule as any)()
    // Discovery can emit an error while descriptor lookup is awaiting HTTP.
    // Install the observer before the first asynchronous startup operation.
    this.client.on('error', (err: Error | string) => {
      if (!this.running) return
      this.running = false
      this.task.status = 'error'
      this.task.detail = null
      this.task.error = typeof err === 'string' ? err : err.message
      this.context.onUpdate(this.task)
      void this.cleanup().then(() => this.context.onFinished(this.task, typeof err === 'string' ? new Error(err) : err))
    })
    if (!this.running) {
      this.cleanup()
      return
    }
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
          (await fetchCachedTorrentDescriptor(this.task.url, this.controller.signal))
        if (!this.running) {
          this.cleanup()
          return
        }
        if (cached) torrentId = cached.torrentId
      } catch {}
    }

    if (!this.running) return
    if (this.context.limiter.hasTransferQuota) throw new Error(TORRENT_QUOTA_UNSUPPORTED)

    this.attachTorrent(this.client.add(
      torrentId,
      { ...torrentDownloadOptions(this.task.dir), announce: [...DEFAULT_TORRENT_TRACKERS] }
    ) as Torrent)
  }

  private attachTorrent(torrent: Torrent): void {
    this.torrent = torrent
    this.torrent.on('metadata', () => {
      if (!this.running || !this.torrent) return
      const roots = this.torrent.files.map((file) => file.path.split(/[\\/]/)[0])
      const root = roots[0]
      if (root && root !== '.' && root !== '..' && roots.every((name) => name === root)) {
        // WebTorrent writes metadata paths; an arbitrary display name cannot
        // rename those files and makes Open/Show-in-folder point nowhere.
        this.task.filename = root
        this.task.filenameLocked = true
      }
      this.task.torrentFiles = this.torrent.files.map((file) => ({ path: file.path, size: file.length }))
      
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
        // The client starts with no pieces selected, including full downloads.
        // Explicitly select every file once its metadata is available.
        for (const file of this.torrent.files) file.select()
        this.task.size = this.torrent.length
      }

      this.task.resumable = true
      this.task.received = this.selectedDownloaded()
      this.task.detail = this.torrent.wires.length > 0 ? null : 'Metadata ready · waiting for peers…'
      this.updateTorrentInfo(true)
      if (this.selectedComplete()) void this.complete()
      else this.context.onUpdate(this.task)
    })

    this.torrent.on('done', () => { void this.complete() })
    // Idempotent on purpose. `onUpdate` is a full task-list broadcast plus a
    // persist, and a torrent finding eighty peers fires this eighty times in a
    // few seconds - seventy-nine of which had nothing left to say, because the
    // detail was already null after the first.
    this.torrent.on('wire', () => {
      if (!this.running || this.task.detail === null) return
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
      this.running = false
      this.task.status = 'error'
      this.task.detail = null
      this.task.error = typeof err === 'string' ? err : err.message
      this.context.onUpdate(this.task)
      void this.cleanup().then(() => this.context.onFinished(this.task, typeof err === 'string' ? new Error(err) : err))
    })

  }

  async pause(): Promise<void> {
    if (!this.running) {
      await this.cleanupPromise
      return
    }
    this.running = false
    this.task.status = 'paused'
    this.task.detail = null
    this.task.speed = 0
    this.task.eta = null
    this.context.onUpdate(this.task)
    await this.cleanup()

    /*
     * `onFinished` is how a runner gives its slot back: it is what makes the
     * manager drop this entry from `runners`. Every other runner reaches it
     * through its own `start()` unwinding on abort; this one cannot, because
     * `start()` returned the moment the torrent was added and there is nothing
     * left to unwind.
     *
     * Without it a paused torrent held its concurrency slot for the life of the
     * process - and `schedule()` skips any task already in `runners`, so
     * pressing Start again left the row sitting at "queued" forever.
     *
     */
    this.context.onFinished(this.task, null)
  }

  tick(): void {
    if (!this.running || !this.torrent) return

    // WebTorrent has already received bytes by the time its counters change.
    // Charging those counters cannot enforce a hard transfer quota.
    if (this.context.limiter.hasTransferQuota) {
      this.failUnsupportedQuota()
      return
    }

    this.applyThrottles()

    const downloaded = this.selectedDownloaded()

    this.task.received = Math.min(downloaded, this.task.size ?? downloaded)
    if (this.selectedComplete()) {
      void this.complete()
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
   * WebTorrent has its own per-client throttle. Apply the tightest app/queue
   * rate to this client; multiple torrent clients still need a shared throttle
   * before the app-wide rate can be guaranteed in aggregate. Upload has its
   * own setting, so seeding does not consume the download rate.
   */
  private applyThrottles(): void {
    if (!this.client) return
    if (typeof this.client.throttleDownload === 'function') {
      this.client.throttleDownload(this.context.limiter.effectiveSpeedLimit ?? -1)
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
    this.updateTorrentInfo(true)

    if (this.running && this.selectedComplete()) void this.complete()
    else this.context.onUpdate(this.task)
  }

  /** WebTorrent's torrent-level counter includes pieces for unselected files. */
  private selectedDownloaded(): number {
    if (!this.torrent) return 0
    return selectedTorrentDownloaded(this.torrent.files, this.task.selectedFiles)
  }

  private failUnsupportedQuota(): void {
    if (!this.running) return
    this.running = false
    const error = new Error(TORRENT_QUOTA_UNSUPPORTED)
    this.task.status = 'error'
    this.task.error = error.message
    this.task.detail = null
    this.task.speed = 0
    this.task.eta = null
    this.context.onUpdate(this.task)
    void this.cleanup().then(() => this.context.onFinished(this.task, error))
  }

  private selectedComplete(): boolean {
    if (!this.torrent) return false
    return selectedTorrentComplete(this.torrent.files, this.task.selectedFiles)
  }

  /**
   * Rebuilds the diagnostics panel, at most once a second and only when
   * something is showing it.
   *
   * `torrentInfoOf` allocates an object per file and per peer and calls into
   * every wire for its rates. Doing that on all four ticks a second - for a
   * panel that is only drawn while the details dialog is open - was the single
   * most expensive thing in the main process on a large torrent, and it was
   * paid on the same event loop that drains the sockets.
   *
   * `force` is for the transitions that must be exact whether or not anybody is
   * watching: metadata arriving, a selection change, completion.
   */
  private updateTorrentInfo(force = false): void {
    if (!this.torrent) return

    if (!force) {
      if (!this.context.isWatched?.()) return
      const now = Date.now()
      if (now - this.lastInfoAt < INFO_REFRESH_MS) return
      this.lastInfoAt = now
    } else {
      this.lastInfoAt = Date.now()
    }

    this.task.torrentInfo = torrentInfoOf(this.torrent, this.task.selectedFiles)
  }

  private async complete(): Promise<void> {
    if (!this.running || !this.torrent) return
    this.running = false
    this.task.status = 'done'
    this.task.completedAt = Date.now()
    this.task.detail = null
    this.task.received = this.task.size ?? this.selectedDownloaded()
    this.task.speed = 0
    this.task.eta = null
    this.updateTorrentInfo(true)

    // Hand the live swarm connection to the manager instead of destroying it.
    // The download is over either way - `onFinished` still runs, the row still
    // goes green, the queue still starts the next task - but the peers who made
    // this download possible keep an upload to talk to.
    if (!this.handOverForSeeding()) await this.cleanup()

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
    let stopping: Promise<void> | null = null

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
        if (stopping) return stopping
        stopped = true
        stopping = new Promise<void>((resolve, reject) => {
          try { client.destroy((error?: Error | null) => error ? reject(error) : resolve()) }
          catch (error) { reject(error) }
        })
        return stopping
      }
    }

    this.context.onSeed(task, session)
    return true
  }

  private cleanup(): Promise<void> {
    this.controller.abort()
    const client = this.client
    this.client = null
    this.torrent = null
    if (!client) return this.cleanupPromise ?? Promise.resolve()
    const pending = new Promise<void>((resolve) => {
      // WebTorrent's callback follows store and socket teardown. A remove must
      // not delete the payload until outstanding piece writes have stopped.
      try { client.destroy(() => resolve()) } catch { resolve() }
    })
    this.cleanupPromise = pending
    void pending.finally(() => {
      if (this.cleanupPromise === pending) this.cleanupPromise = null
    })
    return pending
  }
}
