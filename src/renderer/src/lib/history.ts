/**
 * A 60-second rolling speed history per task, for the sparkline in the detail
 * dialog.
 *
 * Deliberately kept out of the Zustand store. Progress arrives four times a
 * second for every running task; pushing that into reactive state would
 * re-render the whole table to animate one chart that is usually not even open.
 * The dialog polls this on its own timer instead.
 */

/** 60 s at the engine's 4 Hz progress feed. */
const SAMPLES = 240

const series = new Map<string, number[]>()

export function recordSpeed(id: string, speed: number): void {
  let samples = series.get(id)
  if (!samples) {
    samples = []
    series.set(id, samples)
  }

  samples.push(speed)
  if (samples.length > SAMPLES) samples.splice(0, samples.length - SAMPLES)
}

/** A copy, padded at the front so the chart starts at the right edge. */
export function speedHistory(id: string): number[] {
  const samples = series.get(id)
  if (!samples || samples.length === 0) return []
  return samples.slice()
}

export function clearHistory(id: string): void {
  series.delete(id)
}

/** Drops series for tasks that no longer exist, so the map cannot grow forever. */
export function pruneHistory(liveIds: Set<string>): void {
  for (const id of series.keys()) {
    if (!liveIds.has(id)) series.delete(id)
  }
}

export const HISTORY_SAMPLES = SAMPLES
