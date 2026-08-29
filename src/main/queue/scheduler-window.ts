import type { Queue } from '../../shared/types.ts'

export function isInQueueWindow(queue: Queue, now: Date): boolean {
  if (!queue.startTime) return false

  const minutes = now.getHours() * 60 + now.getMinutes()
  const start = parseHHMM(queue.startTime)
  if (start === null) return false

  if (!queue.stopTime) {
    if (queue.mode === 'periodic' && queue.days.length > 0 && !queue.days.includes(now.getDay())) return false
    return minutes >= start
  }

  const stop = parseHHMM(queue.stopTime)
  if (stop === null) return false

  if (stop >= start) {
    if (queue.mode === 'periodic' && queue.days.length > 0 && !queue.days.includes(now.getDay())) return false
    return minutes >= start && minutes < stop
  }

  if (minutes >= start) {
    if (queue.mode === 'periodic' && queue.days.length > 0 && !queue.days.includes(now.getDay())) return false
    return true
  }

  const previousDay = (now.getDay() + 6) % 7
  if (queue.mode === 'periodic' && queue.days.length > 0 && !queue.days.includes(previousDay)) return false
  return minutes < stop
}

function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return h * 60 + m
}
