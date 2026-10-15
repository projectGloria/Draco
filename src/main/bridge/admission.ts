import { createHash } from 'node:crypto'

/**
 * Browser ownership changes only after the accepted tasks have reached disk.
 * Callers add them paused first, then use this gate to start or roll them back.
 */
export function committedBrowserTaskCount(
  manager: { list(): Array<{ handoffId?: string }> },
  requestId: string | undefined
): number {
  if (!requestId) return 0
  return manager.list().filter((task) => task.handoffId === requestId).length
}

/** Each bulk item needs its own receipt: a crash can persist part of a batch. */
export function batchHandoffId(requestId: string | undefined, index: number): string | undefined {
  return requestId ? `batch:${createHash('sha256').update(requestId).digest('hex')}:${index}` : undefined
}

export async function commitBrowserTasks(
  manager: { start(ids: string[]): void; remove(ids: string[], deleteFiles: boolean): Promise<void> },
  ids: string[],
  flush: () => Promise<void>
): Promise<void> {
  if (ids.length === 0) return
  try {
    await flush()
  } catch (error) {
    await manager.remove(ids, false)
    throw error
  }
  manager.start(ids)
}
