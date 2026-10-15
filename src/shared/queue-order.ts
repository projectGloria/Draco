export function orderedQueueIds(saved: readonly string[], members: readonly string[]): string[] {
  const live = new Set(members)
  return [...new Set([...saved.filter((id) => live.has(id)), ...members])]
}

/** Move onto the target's position, e.g. fifth onto second becomes second. */
export function moveQueueItem(ids: readonly string[], from: string, to: string): string[] {
  const source = ids.indexOf(from)
  const target = ids.indexOf(to)
  if (source < 0 || target < 0 || source === target) return [...ids]
  const next = [...ids]
  next.splice(source, 1)
  next.splice(target, 0, from)
  return next
}

export const QUEUE_ICONS = ['layers', 'folder', 'download', 'video', 'music', 'archive'] as const
export type QueueIconName = typeof QUEUE_ICONS[number]
export function queueIcon(value: unknown): QueueIconName {
  return QUEUE_ICONS.includes(value as QueueIconName) ? value as QueueIconName : 'layers'
}
