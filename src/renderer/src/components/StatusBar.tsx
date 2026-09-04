import { useApp } from '../store/app'
import { formatBytes, formatSpeed } from '../lib/format'
import { useT } from '../i18n'

/**
 * The one-line summary along the bottom: what is running, how fast in total,
 * and how much is left. Speed is summed from the engine's own per-task figures
 * rather than measured here, so it agrees with the rows above it.
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

  const active = tasks.filter((t) => t.status === 'downloading')
  const queued = tasks.filter((t) => t.status === 'queued').length
  // Summed over every task, not just the ones labelled `downloading`: a stream
  // fetched as separate video and audio parts reports its speed while the parent
  // is still `probing`. Idle tasks contribute zero.
  const speed = tasks.reduce((sum, t) => sum + t.speed, 0)

  const remaining = tasks.reduce((sum, t) => {
    if (t.status === 'done' || !t.size) return sum
    return sum + Math.max(0, t.size - t.received)
  }, 0)

  const bridge = integration?.bridgeListening === true
  const anyBrowser =
    integration !== null &&
    Object.values(integration.registered).some(Boolean)

  const nextInQueue = tasks.find((t) => t.status === 'queued')

  return (
    <footer className="h-7 shrink-0 flex items-center gap-4 px-3 border-t border-line bg-white/[0.02] text-[11.5px] text-faint">
      <span className="tnum flex items-center gap-1">
        <span className="text-blue-500 font-semibold">{active.length}</span> {t('active')}
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
          <span className="text-pink-500 font-semibold">{formatBytes(remaining)}</span> {t('remaining')}
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
