import { useMemo } from 'react'
import type { DisplayRow } from '@shared/groups'
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
  rows,
  onOpenOptions
}: {
  /**
   * The same display rows the table draws, passed in rather than rebuilt.
   *
   * `buildDisplayRows` used to be called here *and* in `DownloadTable`, so a
   * grouping pass over the whole list ran twice on every progress tick for one
   * footer line and one table.
   */
  rows: DisplayRow[]
  onOpenOptions(): void
}): React.ReactElement {
  const tasks = useApp((s) => s.tasks)
  const settings = useApp((s) => s.settings)
  const integration = useApp((s) => s.integration)
  const playlists = useApp((s) => s.playlists)
  const t = useT()

  // Only one is shown; more than one at a time is rare and the line has room
  // for exactly one of them.
  const expanding = Object.values(playlists)[0]

  /*
   * Every figure in this bar, from one pass over each list.
   *
   * Only the grouping used to be memoised; the seven scans that followed it -
   * two filters over the rows, two over the tasks, two reduces and a `some` -
   * ran on every render, and this component re-renders whenever the progress
   * feed touches anything. On a few hundred rows that was several thousand
   * iterations a second to draw one line of text.
   */
  const totals = useMemo(() => {
    // One entry per row in the table above: groups collapse to their summary.
    let active = 0
    let queued = 0
    for (const row of rows) {
      const item = row.kind === 'group' ? row.group.summary : row.task
      if (item.status === 'downloading' || item.status === 'probing') active++
      else if (item.status === 'queued') queued++
    }

    let activeFiles = 0
    let queuedFiles = 0
    // Summed over every task, not just the ones labelled `downloading`: a
    // stream fetched as separate video and audio parts reports its speed while
    // the parent is still `probing`. Idle tasks contribute zero.
    let speed = 0
    // `expectedSize` counts too. A queued file has no confirmed size until it
    // is probed, so a total built from `size` alone leaves out everything that
    // has not started - which is most of a fresh batch, and makes the figure
    // read as though an album of fifteen tracks had ten megabytes to go.
    let remaining = 0
    // Anything still unsized is missing from the total, so say "at least".
    let partial = false
    let nextInQueue: (typeof tasks)[number] | undefined

    for (const task of tasks) {
      speed += task.speed
      if (task.status === 'downloading' || task.status === 'probing') activeFiles++
      else if (task.status === 'queued') {
        queuedFiles++
        if (!nextInQueue) nextInQueue = task
      }

      if (task.status !== 'done') {
        const size = task.size ?? task.expectedSize ?? null
        if (size) remaining += Math.max(0, size - task.received)
        else partial = true
      }
    }

    return { active, queued, activeFiles, queuedFiles, speed, remaining, partial, nextInQueue }
  }, [rows, tasks])

  const { active, queued, activeFiles, queuedFiles, speed, remaining, partial, nextInQueue } = totals

  const bridge = integration?.bridgeListening === true
  const anyBrowser =
    integration !== null &&
    Object.values(integration.registered).some(Boolean)

  return (
    <footer className="h-7 shrink-0 flex items-center gap-4 px-3 border-t border-line bg-white/[0.02] text-[11.5px] text-faint">
      <span
        className="tnum flex items-center gap-1"
        title={t('statusTooltip', { active: activeFiles, queued: queuedFiles })}
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

      {/* A playlist expansion is minutes of work with no rows of its own until
          each entry resolves, so it takes this slot while it is running. */}
      {expanding ? (
        <div className="flex-1 min-w-0 flex items-center justify-center gap-2 px-2">
          <span className="w-3 h-3 rounded-full border-2 border-faint border-t-[var(--accent)] animate-spin shrink-0" />
          <span className="truncate" title={expanding.groupName}>
            {t('resolvingStatus', { done: expanding.done, total: expanding.total, group: expanding.groupName })}
            {expanding.failed > 0 ? ` · ${t('resolveFailedCount', { count: expanding.failed })}` : ''}
          </span>
          <button
            type="button"
            onClick={() => void window.api.cancelPlaylist(expanding.groupId)}
            className="shrink-0 underline underline-offset-2 hover:text-ink"
          >
            {t('cancel')}
          </button>
        </div>
      ) : (
        <div className="flex-1 text-center truncate px-2 text-faint/70">
          {nextInQueue ? t('nextInQueue', { name: nextInQueue.filename }) : ''}
        </div>
      )}

      {settings.speedLimit && (
        <span className="tnum" title={t('speedLimitHint')}>
          {t('limit')} {formatSpeed(settings.speedLimit)}
        </span>
      )}

      <button
        onClick={onOpenOptions}
        title={
          bridge && anyBrowser
            ? t('browserBridgeReady')
            : t('browserBridgeSetup')
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
