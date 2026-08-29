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
