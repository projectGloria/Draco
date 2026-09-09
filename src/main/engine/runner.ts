import type { DownloadTask } from '../../shared/types.ts'

/**
 * What the manager needs from anything that downloads.
 *
 * There are two implementations: `TaskRunner` for a single ranged HTTP resource,
 * and `HlsRunner` for a playlist, which is a list of small resources plus a mux
 * at the end. They have almost nothing in common internally, so the manager is
 * written against this instead of against either of them.
 */
export interface Runner {
  readonly task: DownloadTask
  running: boolean
  start(): Promise<void>
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
  stop(): void
}
