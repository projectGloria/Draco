import type { DownloadTask } from '../shared/types.ts'

/** Task state sent to renderer windows. Request headers belong to main's runners. */
export function publicTask(task: DownloadTask): DownloadTask {
  return { ...task, headers: {} }
}

export function publicTasks(tasks: readonly DownloadTask[]): DownloadTask[] {
  return tasks.map(publicTask)
}
