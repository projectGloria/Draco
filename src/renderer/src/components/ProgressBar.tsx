import type { TaskStatus } from '@shared/types'

/**
 * One bar, used for whole tasks in the table and for individual segments in the
 * detail dialog. A null percentage means the server never said how big the file
 * is, which is a different thing from zero and has to look different.
 */

export function barColor(status: TaskStatus): string {
  switch (status) {
    case 'done':
      return 'var(--color-ok)'
    case 'error':
    case 'missing':
      return 'var(--color-err)'
    case 'paused':
      return 'var(--color-faint)'
    default:
      return 'var(--grad)'
  }
}

export default function ProgressBar({
  percent,
  status,
  height = 6
}: {
  percent: number | null
  status: TaskStatus
  height?: number
}): React.ReactElement {
  const live = status === 'downloading' || status === 'probing'

  return (
    <div
      className="relative w-full rounded-full overflow-hidden bg-white/[0.07]"
      style={{ height }}
      role="progressbar"
      aria-valuenow={percent ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {percent === null ? (
        <div
          className="indeterminate h-full w-full rounded-full"
          style={{ background: barColor(status) }}
        />
      ) : (
        // scaleX rather than a width change: width triggers layout on every
        // tick of the 4 Hz progress feed, while transform runs on the
        // compositor. The clamped value doubles as the scale factor.
        <div
          className="h-full w-full rounded-full origin-left transition-transform duration-200 ease-out"
          style={{
            transform: `scaleX(${Math.max(0, Math.min(100, percent)) / 100})`,
            background: barColor(status)
          }}
        />
      )}

      {live && percent !== null && percent > 0 && (
        // A moving sheen over the filled part, so a slow download still reads as
        // running rather than stuck.
        <div
          className="absolute inset-y-0 left-0 w-full origin-left pointer-events-none overflow-hidden rounded-full"
          style={{ transform: `scaleX(${Math.max(0, Math.min(100, percent)) / 100})` }}
        >
          <div
            className="shimmer h-full w-1/3"
            style={{
              background:
                'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)'
            }}
          />
        </div>
      )}
    </div>
  )
}
