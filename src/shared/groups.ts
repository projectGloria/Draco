/**
 * Turning a flat list of downloads into a list with groups in it.
 *
 * A group is not a task the engine knows about - it is several ordinary
 * downloads that were added together, from one album page, one playlist, one
 * inspected web page. The list still holds every one of them; this decides
 * which of them the table draws, and what the single row standing in for the
 * whole group should say.
 *
 * A group is one row and stays one row. Its members are read in the properties
 * window, not unfolded into the list - the list is for the things the user
 * asked for, and an album is one of those.
 */

import type { DownloadTask, TaskStatus } from './types.ts'

export interface TaskGroup {
  id: string
  name: string
  tasks: DownloadTask[]
  /** The group as one row: totals, worst status, combined speed. */
  summary: DownloadTask
}

export type DisplayRow =
  | { kind: 'group'; group: TaskGroup }
  | { kind: 'task'; task: DownloadTask }

/**
 * The rows to actually draw: every ungrouped download, plus one row per group
 * in place of its members.
 *
 * Members are gathered by id rather than by adjacency, so sorting by size or
 * status cannot scatter half an album through the list. The group row takes the
 * position of its first member in whatever order the list is in.
 */
export function buildDisplayRows(rows: DownloadTask[]): DisplayRow[] {
  const members = new Map<string, DownloadTask[]>()
  for (const task of rows) {
    if (!task.groupId) continue
    const existing = members.get(task.groupId)
    if (existing) existing.push(task)
    else members.set(task.groupId, [task])
  }

  const out: DisplayRow[] = []
  const seen = new Set<string>()
  for (const task of rows) {
    const groupId = task.groupId
    const tasks = groupId ? members.get(groupId) ?? [] : []
    // A group with one visible member is just a download. A header row over it
    // would cost a line and hide nothing.
    if (!groupId || tasks.length < 2) {
      out.push({ kind: 'task', task })
      continue
    }
    if (seen.has(groupId)) continue
    seen.add(groupId)
    out.push({
      kind: 'group',
      group: { id: groupId, name: task.groupName || 'Page downloads', tasks, summary: summarizeGroup(groupId, tasks) }
    })
  }
  return out
}

/**
 * What the group is doing, in the order that matters to somebody watching it:
 * anything still moving outranks anything finished, and one failure is worth
 * saying even when the other forty-eight files arrived.
 */
const GROUP_STATUS_ORDER: TaskStatus[] = ['downloading', 'probing', 'error', 'queued', 'paused', 'missing', 'done']

export function summarizeGroup(groupId: string, tasks: DownloadTask[]): DownloadTask {
  // The confirmed size when there is one, the advertised size until then. A
  // total built only from what has been probed climbs as the batch runs, and
  // the percentage against it swings - 30%, 69%, 65% - which is worse than
  // saying nothing.
  const known = tasks
    .map((task) => task.size ?? task.expectedSize ?? null)
    .filter((size): size is number => typeof size === 'number')
  const size = known.length > 0 ? known.reduce((total, value) => total + value, 0) : null
  const received = tasks.reduce((total, task) => total + task.received, 0)
  const speed = tasks.reduce((total, task) => total + task.speed, 0)
  const status = GROUP_STATUS_ORDER.find((candidate) => tasks.some((task) => task.status === candidate)) ?? 'queued'
  const done = tasks.filter((task) => task.status === 'done').length
  const remaining = size !== null ? Math.max(0, size - received) : null
  const failed = tasks.filter((task) => task.status === 'error').length

  return {
    ...tasks[0],
    id: `group:${groupId}`,
    filename: tasks[0].groupName || 'Page downloads',
    size,
    received,
    speed,
    status,
    eta: remaining !== null && speed > 0 ? Math.round(remaining / speed) : null,
    error: failed > 0 ? `${failed} of ${tasks.length} failed` : null,
    detail: `${done} of ${tasks.length} files`,
    createdAt: Math.min(...tasks.map((task) => task.createdAt)),
    completedAt: done === tasks.length
      ? tasks.reduce((latest, task) => Math.max(latest, task.completedAt ?? 0), 0) || null
      : null
  }
}
