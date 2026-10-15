import type { TaskStatus } from './types.ts'

/** Stages that a Stop command can interrupt, including work after transfer. */
export function canPauseTask(status: TaskStatus): boolean {
  return status === 'queued' || status === 'probing' || status === 'downloading' ||
    status === 'processing' || status === 'scanning'
}
