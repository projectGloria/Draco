/**
 * Formatting for a dense table. Every function here returns something that
 * fits in a narrow column and never changes width mid-download - a size that
 * flips between "1000 KB" and "1.0 MB" every second is a size nobody can read.
 */

const EMPTY = '—'

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return EMPTY
  if (bytes < 1024) return bytes + ' B'

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0) + ' ' + units[unit]
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || bytesPerSecond < 1) return ''
  return formatBytes(bytesPerSecond) + '/s'
}

/** Terse countdown for the ETA column: 47s, 2m 04s, 1h 12m. */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return ''
  }

  const total = Math.round(seconds)
  if (total < 60) return total + 's'

  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return m + 'm ' + String(s).padStart(2, '0') + 's'

  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm'

  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h'
}

/** Clock format for stream length: 3:07 or 1:04:22. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return ''

  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')

  return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s)
}

export function percent(received: number, size: number | null): number {
  if (!size || size <= 0) return 0
  return Math.min(100, (received / size) * 100)
}

export function formatPercent(received: number, size: number | null): string {
  if (!size || size <= 0) return ''
  return percent(received, size).toFixed(1) + '%'
}

export function looksLikeUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

/**
 * Date for the "Added" column: the clock alone for today, the day for anything
 * older. A column where every row says the same date tells you nothing.
 */
export function formatWhen(epochMs: number): string {
  const date = new Date(epochMs)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  if (epochMs >= startOfToday()) return time
  if (epochMs >= startOfToday() - 86_400_000) return 'Yesterday ' + time

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time
}

/** "in 47s" for the pending shutdown countdown. */
export function formatCountdown(msRemaining: number): string {
  const s = Math.max(0, Math.ceil(msRemaining / 1000))
  if (s < 60) return s + 's'
  return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return ''
  return filename.slice(dot + 1).toLowerCase()
}
