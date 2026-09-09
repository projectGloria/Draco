/**
 * A speed limit that only applies at certain hours.
 *
 * One global cap is the wrong shape for the machine a download manager
 * actually runs on: the reason to throttle at all is usually "while I am using
 * this computer", and the reason to stop throttling is "while I am asleep". A
 * setting you have to remember to flip twice a day is one you stop flipping.
 *
 * Pure, and separate from the queue scheduler's own windows, because the two
 * answer different questions - which tasks may run, versus how fast anything
 * may go - and only this one is consulted on every tick.
 */

export interface ScheduledLimit {
  /** "HH:MM" local time. */
  startTime: string
  stopTime: string
  /** Bytes per second while the window is open. */
  bytesPerSecond: number
}

/** Minutes since midnight, or null when the value is not a time. */
export function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/**
 * Whether `now` falls inside the window.
 *
 * A stop time earlier than the start means the window crosses midnight, which
 * is the common case for this setting - 08:00 to 23:00 is one shape of the
 * request, 23:00 to 08:00 is the other. The start minute is inside and the stop
 * minute is outside, so two windows can meet without overlapping.
 */
export function withinWindow(startTime: unknown, stopTime: unknown, now: Date): boolean {
  const start = parseClock(startTime)
  const stop = parseClock(stopTime)
  if (start === null || stop === null) return false
  // A window that starts and stops at the same minute has no hours in it. It is
  // read as "never" rather than "always": an accidental 00:00-00:00 must not
  // throttle the app around the clock.
  if (start === stop) return false

  const minutes = now.getHours() * 60 + now.getMinutes()
  return stop > start ? minutes >= start && minutes < stop : minutes >= start || minutes < stop
}

/**
 * The cap in force right now: the scheduled one while its window is open,
 * otherwise the ordinary one.
 *
 * The scheduled limit replaces rather than combines. Two numbers that both
 * apply would need a rule for which wins, and the honest reading of "limit to
 * 200 KB/s between 9 and 5" is that between 9 and 5 the limit is 200 KB/s.
 */
export function effectiveSpeedLimit(
  settings: { speedLimit: number | null; scheduledLimit?: ScheduledLimit | null },
  now: Date = new Date()
): number | null {
  const scheduled = settings.scheduledLimit
  if (
    scheduled &&
    Number.isFinite(scheduled.bytesPerSecond) &&
    scheduled.bytesPerSecond > 0 &&
    withinWindow(scheduled.startTime, scheduled.stopTime, now)
  ) {
    return scheduled.bytesPerSecond
  }
  return settings.speedLimit
}
