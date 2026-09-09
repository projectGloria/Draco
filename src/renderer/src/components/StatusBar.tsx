import { useMemo } from 'react'
import { buildDisplayRows } from '@shared/groups'
import { useApp } from '../store/app'
import { formatBytes, formatSpeed } from '../lib/format'
import { useT } from '../i18n'

/**
 * The one-line summary along the bottom: what is running, how fast in total,
 * and how much is left. Speed is summed from the engine's own per-task figures
 * rather than measured here, so it agrees with the rows above it.
 *
 * The counts are counted in the same unit the list draws: an album fetched as
 * forty-nine files is one active download, not three, because one row is what
 * the user is looking at. The file-level breakdown is still there on hover,
 * which is where it belongs - it answers a question nobody asked until they do.
 */

export default function StatusBar({
  onOpenOptions
}: {
  onOpenOptions(): void
}): React.ReactElement {
  const tasks = useApp((s) => s.tasks)
  const settings = useApp((s) => s.settings)
  const integration = useApp((s) => s.integration)
  const t = useT()

  // One entry per row in the table above: groups collapse to their summary.
  const items = useMemo(
    () => buildDisplayRows(tasks).map((row) => (row.kind === 'group' ? row.group.summary : row.task)),
    [tasks]
  )
  const active = items.filter((t) => t.status === 'downloading' || t.status === 'probing').length
  const queued = items.filter((t) => t.status === 'queued').length
  const activeFiles = tasks.filter((t) => t.status === 'downloading' || t.status === 'probing').length
  const queuedFiles = tasks.filter((t) => t.status === 'queued').length
  // Summed over every task, not just the ones labelled `downloading`: a stream
  // fetched as separate video and audio parts reports its speed while the parent
  // is still `probing`. Idle tasks contribute zero.
  const speed = tasks.reduce((sum, t) => sum + t.speed, 0)

  // `expectedSize` counts too. A queued file has no confirmed size until it is
  // probed, so a total built from `size` alone leaves out everything that has
  // not started - which is most of a fresh batch, and makes the figure read as
  // though an album of fifteen tracks had ten megabytes to go.
  const remaining = tasks.reduce((sum, t) => {
    if (t.status === 'done') return sum
    const size = t.size ?? t.expectedSize ?? null
    if (!size) return sum
    return sum + Math.max(0, size - t.received)
  }, 0)
  // Anything still unsized is missing from the total, so say "at least".
  const partial = tasks.some((t) => t.status !== 'done' && !(t.size ?? t.expectedSize))

  const bridge = integration?.bridgeListening === true
  const anyBrowser =
    integration !== null &&
    Object.values(integration.registered).some(Boolean)

  const nextInQueue = tasks.find((t) => t.status === 'queued')

  return (
    <footer className="h-7 shrink-0 flex items-center gap-4 px-3 border-t border-line bg-white/[0.02] text-[11.5px] text-faint">
      <span
        className="tnum flex items-center gap-1"
        title={`${activeFiles} file${activeFiles === 1 ? '' : 's'} downloading, ${queuedFiles} queued`}
      >
        <span className="text-blue-500 font-semibold">{active}</span> {t('active')}
        {queued > 0 && (
          <span className="text-faint/70 flex items-center gap-1">
            {' '}&bull;{' '}
            <span className="text-yellow-500 font-semibold">{queued}</span> {t('queued')}
          </span>
        )}
      </span>

      {speed > 0 && (
        <span className="tnum font-semibold" style={{ color: 'var(--accent)' }}>
          ↓ {formatSpeed(speed)}
        </span>
      )}

      {remaining > 0 && (
        <span className="tnum flex items-center gap-1">
          <span className="text-pink-500 font-semibold">
            {partial ? '≥ ' : ''}
            {formatBytes(remaining)}
          </span>{' '}
          {t('remaining')}
        </span>
      )}

      <div className="flex-1 text-center truncate px-2 text-faint/70">
        {nextInQueue ? `Next: ${nextInQueue.filename}` : ''}
      </div>

      {settings.speedLimit && (
        <span className="tnum" title="Global speed limit, from Options">
          {t('limit')} {formatSpeed(settings.speedLimit)}
        </span>
      )}

      <button
        onClick={onOpenOptions}
        title={
          bridge && anyBrowser
            ? 'The browser bridge is listening and at least one browser is registered'
            : 'Open Options to finish setting up the browser extension'
        }
        className="flex items-center gap-1.5 hover:text-ink transition-colors shrink-0"
      >
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: bridge && anyBrowser ? 'var(--color-ok)' : 'var(--color-warn)' }}
        />
        {t('browser')}
      </button>
    </footer>
  )
}
