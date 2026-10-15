import type { DownloadTask } from '../../shared/types.ts'

/**
 * What the manager needs from anything that downloads.
 *
 * Five implementations, with almost nothing in common internally, which is why
 * the manager is written against this rather than against any of them:
 * `TaskRunner` for a single ranged HTTP resource, `HlsRunner` for a playlist
 * (many small resources plus a mux), `MpdRunner` for a DASH manifest (ffmpeg
 * drives the whole pull), `DashRunner` for a video+audio pair fetched as two
 * child `TaskRunner`s and merged, and `TorrentRunner` for a swarm.
 */
export interface Runner {
  readonly task: DownloadTask
  running: boolean
  start(): Promise<void>
  /**
   * Stops cleanly, and **must** reach `onFinished` before it resolves.
   *
   * That callback is the only thing that drops this runner from the manager's
   * `runners` map, which is both the concurrency accounting and the guard
   * `schedule()` checks before launching a task. A `pause()` that returns
   * without it leaks the slot for the life of the process and leaves the task
   * permanently unstartable - `TorrentRunner` did exactly that, because its
   * `start()` had already returned and had no unwinding left to do it.
   */
  pause(): Promise<void>
  /** Called on the manager's shared ticker to recompute speed, ETA and progress. */
  tick(): void
  /**
   * Wipe partial data so a retry can start clean. Returns false when this runner
   * has already had its one restart, so the manager cannot loop forever.
   */
  resetForRestart(): Promise<boolean>
}

/**
 * A torrent that has finished downloading and is still giving back.
 *
 * The manager holds these outside `runners`, because a seed is not a download:
 * it must not occupy a concurrency slot, must not stop the next queued task
 * from starting, and must survive the runner that produced it.
 */
export interface SeedSession {
  readonly taskId: string
  /** Bytes uploaded and the ratio a tracker would judge. */
  progress(): { uploaded: number; ratio: number; uploadSpeed: number; peers: number }
  /** Refreshes the task's live torrent panel from the seeding client. */
  refreshInfo(): void
  /** Applies a changed upload cap without restarting the session. */
  applyUploadLimit(bytesPerSecond: number | null): void
  /** Resolves after the client has closed its sockets and file store. */
  stop(): void | Promise<void>
}
