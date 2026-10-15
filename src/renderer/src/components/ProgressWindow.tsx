import { useEffect, useState } from 'react'
import type { DownloadTask, Settings } from '@shared/types'
import { displaySource } from '@shared/display-source'
import { youtubeThumbnailUrl } from '@shared/youtube-link'
import { recoveryHint } from '@shared/recovery'
import { formatBytes, formatEta, formatPercent, formatSpeed, hostOf, percent } from '../lib/format'
import { useThumbnail } from '../lib/icons'
import { useT } from '../i18n'
import { useApp } from '../store/app'
import { useAppearance } from '../lib/use-appearance'
import { SiteIcon } from './FileIcon'
import { CloseGlyph, FolderIcon, MinimizeGlyph, PauseIcon, PlayIcon, TorrentIcon } from './Icons'
import { GhostButton, PrimaryButton } from './Dialog'
import ProgressBar from './ProgressBar'

/**
 * IDM's per-download window: one download, its numbers, and the three buttons
 * that apply to it - and then, when it finishes, the completion card.
 *
 * It owns no state of its own. The task arrives once over IPC and is then kept
 * current by the same `tasks:progress` and `tasks:changed` feeds the main list
 * watches, so this window and the list can never disagree about what a download
 * is doing. When the task disappears from the list - deleted from the main
 * window - this closes itself, because there is nothing left to be about.
 */

export default function ProgressWindow({ id }: { id: string }): React.ReactElement {
  const [task, setTask] = useState<DownloadTask | null>(null)
  const [gone, setGone] = useState(false)
  const settings = useApp((state) => state.settings)
  useAppearance(settings)

  useEffect(() => {
    let active = true
    let taskEventReceived = false
    let latestProgress: Partial<DownloadTask> = {}
    setTask(null)
    setGone(false)
    void window.api
      .getSettings()
      .then((settings: Settings) => {
        if (!active) return
        useApp.setState({ settings })
      })
      .catch(() => {})

    void window.api
      .getTask(id)
      .then((found) => {
        if (!active || taskEventReceived) return
        if (found) setTask({ ...found, ...latestProgress })
        else setGone(true)
      })
      .catch(() => { if (active && !taskEventReceived) setGone(true) })

    const offProgress = window.api.onProgress((updates) => {
      const update = updates.find((entry) => entry.id === id)
      if (!update) return
      latestProgress = update
      setTask((current) => (current ? { ...current, ...update } : current))
    })

    // The list feed carries the fields progress does not - the filename settled
    // by the probe, the folder the task was re-filed into - and is also how this
    // window learns the download was deleted somewhere else.
    const offTasks = window.api.onTasksChanged((tasks) => {
      taskEventReceived = true
      const found = tasks.find((entry) => entry.id === id)
      if (found) {
        setTask(found)
        setGone(false)
      }
      else setGone(true)
    })

    return () => {
      active = false
      offProgress()
      offTasks()
    }
  }, [id])

  useEffect(() => {
    if (gone) void window.api.closeSelf()
  }, [gone])

  const close = (): void => {
    void window.api.closeSelf()
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const done = task?.status === 'done'

  useEffect(() => {
    if (!task) return
    const progress = task.size && task.size > 0
      ? `${Math.floor(Math.min(1, task.received / task.size) * 100)}%`
      : null
    const value = task.status === 'done'
      ? 'Complete'
      : task.status === 'processing'
        ? 'Processing'
        : task.status === 'scanning'
          ? 'Scanning'
      : task.status === 'paused'
        ? progress ? `Paused · ${progress}` : 'Paused'
        : task.status === 'error' || task.status === 'missing'
          ? 'Failed'
          : progress ?? 'Downloading'
    document.title = `${value} · ${task.filename || 'Preparing download'} — Draco`
  }, [task])

  return (
    <div className="app-bg h-full flex flex-col overflow-hidden border border-line-strong">
      <span
        className="bloom w-[280px] h-[280px] -top-[150px] -right-[60px] opacity-[0.16]"
        style={{ background: done ? 'var(--color-ok)' : 'var(--accent)' }}
      />

      <header className="drag h-9 shrink-0 flex items-center gap-2.5 pl-3 pr-1 border-b border-line bg-white/[0.02]">
        {task?.kind === 'torrent' ? (
          <TorrentIcon className="w-4 h-4" />
        ) : (
          <SiteIcon url={task?.sourceUrl ?? task?.youtube?.pageUrl ?? task?.url} className="w-4 h-4" />
        )}
        <span className="font-display text-[12.5px] font-bold tracking-[0.3px]">
          {done ? 'Download complete' : task?.status === 'processing' ? 'Processing download' : task?.status === 'scanning' ? 'Scanning download' : 'Downloading'}
        </span>
        <div className="flex-1" />
        <div className="no-drag flex">
          <button
            onClick={() => void window.api.minimizeSelf()}
            aria-label="Minimize"
            title="Minimize"
            className="w-9 h-9 grid place-items-center text-muted hover:bg-white/[0.07] hover:text-ink transition-colors"
          >
            <MinimizeGlyph />
          </button>
          <button
            onClick={close}
            aria-label="Close"
            title="Close"
            className="w-9 h-9 grid place-items-center text-muted hover:bg-[#e81123] hover:text-white transition-colors"
          >
            <CloseGlyph />
          </button>
        </div>
      </header>

      {!task ? (
        <div className="flex-1 grid place-items-center px-8 text-center">
          <p className="text-[12.5px] text-faint">
            {gone ? 'This download is no longer in the list.' : 'Loading…'}
          </p>
        </div>
      ) : (
        <Body task={task} onClose={close} />
      )}
    </div>
  )
}

function Body({ task, onClose }: { task: DownloadTask; onClose(): void }): React.ReactElement {
  const [pausing, setPausing] = useState(false)
  const [commandError, setCommandError] = useState<string | null>(null)
  const t = useT()
  const running = task.status === 'downloading' || task.status === 'probing' || task.status === 'queued' || task.status === 'processing' || task.status === 'scanning'
  const done = task.status === 'done'
  const failed = task.status === 'error' || task.status === 'missing'
  const hint = recoveryHint(task)
  const sourceUrl = task.youtube?.pageUrl ?? task.sourceUrl ?? task.url
  const thumbnailUrl = task.thumbnailUrl ?? youtubeThumbnailUrl(sourceUrl)
  const thumbnail = useThumbnail(thumbnailUrl)

  const bar = task.size ? percent(task.received, task.size) : done ? 100 : null
  const retry = (): void => {
    if (pausing) return
    setPausing(true)
    setCommandError(null)
    const action = task.status === 'missing'
      ? window.api.redownload(task.id)
      : window.api.startTasks([task.id])
    void action.catch((error) => setCommandError(`${t('commandFailed')}: ${String(error)}`))
      .finally(() => setPausing(false))
  }

  const pause = (closeAfter: boolean): void => {
    if (pausing) return
    setPausing(true)
    setCommandError(null)
    void window.api.pauseTasks([task.id])
      .then(() => { if (closeAfter) onClose() })
      .catch((error) => setCommandError(`${t('stopFailed')}: ${String(error)}`))
      .finally(() => setPausing(false))
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-hidden px-5 py-3.5 space-y-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-[112px] h-[72px] shrink-0 overflow-hidden rounded-lg border border-line bg-white/[0.04] grid place-items-center">
            {thumbnail ? (
              <img src={thumbnail} alt="Download preview" className="w-full h-full object-cover" />
            ) : (
              <SiteIcon url={sourceUrl} className="w-7 h-7" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold line-clamp-2 break-words" title={task.filename}>
              {task.filename || 'Waiting for a name…'}
            </div>
            <div className="text-[11px] text-faint truncate mt-1" title={displaySource(sourceUrl)}>
              {hostOf(sourceUrl) || displaySource(sourceUrl)}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <ProgressBar percent={bar} status={task.status} height={8} />
          <span className="tnum text-[11.5px] w-[46px] text-right shrink-0">
            {task.size ? formatPercent(task.received, task.size) : ''}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-y-2 rounded-lg px-3 py-2.5 border border-line bg-white/[0.02]">
          <Fact
            label="Transferred"
            value={
              formatBytes(task.received) + (task.size ? ' of ' + formatBytes(task.size) : '')
            }
          />
          <Fact label="Speed" value={formatSpeed(task.speed) || '—'} />
          <Fact label="Time left" value={formatEta(task.eta) || '—'} />
        </div>

        {failed && hint ? (
          <div
            role="alert"
            className="max-h-16 overflow-hidden rounded-lg px-3 py-2 text-[11.5px] leading-relaxed border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.08)] text-err"
          >
            {t(hint)}
          </div>
        ) : (
          <div className="text-[11.5px] text-faint truncate" title={task.dir}>
            {task.detail ??
              (done
                ? task.dir
                : task.status === 'paused'
                  ? 'Paused — nothing is being fetched.'
                  : task.kind === 'torrent'
                    ? 'BitTorrent downloads can resume from verified pieces.'
                    : task.resumable
                    ? 'This server supports resuming.'
                    : 'This server does not support resuming.')}
          </div>
        )}
        {commandError && <div role="alert" className="text-[11.5px] text-err">{commandError}</div>}
      </div>

      <div className="shrink-0 px-5 py-3 border-t border-line flex items-center justify-end gap-2 bg-white/[0.02]">
        {done ? (
          <>
            <GhostButton onClick={onClose}>Close</GhostButton>
            <GhostButton onClick={() => void openThen(window.api.revealFile(task.id), onClose)}>
              <span className="flex items-center gap-1.5">
                <FolderIcon className="w-3.5 h-3.5" />
                Open folder
              </span>
            </GhostButton>
            <PrimaryButton onClick={() => void openThen(window.api.openFile(task.id), onClose)}>
              Open
            </PrimaryButton>
          </>
        ) : (
          <>
            {running && <GhostButton
              disabled={pausing}
              onClick={() => pause(true)}
            >
              {task.status === 'processing' || task.status === 'scanning' ? 'Stop checks and close' : 'Pause and close'}
            </GhostButton>}
            <GhostButton onClick={onClose}>Hide</GhostButton>
            {running ? (
              <PrimaryButton onClick={() => pause(false)} disabled={pausing}>
                <span className="flex items-center gap-1.5">
                  <PauseIcon className="w-3.5 h-3.5" />
                  {task.status === 'processing' || task.status === 'scanning' ? 'Stop checks' : 'Pause'}
                </span>
              </PrimaryButton>
            ) : (
              <PrimaryButton onClick={retry} disabled={pausing}>
                <span className="flex items-center gap-1.5">
                  <PlayIcon className="w-3.5 h-3.5" />
                  {task.status === 'missing' ? t('redownload') : failed ? t('retry') : t('resume')}
                </span>
              </PrimaryButton>
            )}
          </>
        )}
      </div>
    </>
  )
}

/**
 * Handing the file to the shell is the end of this window's job, so it leaves.
 *
 * Only on success, though: a file that has been moved or deleted since it
 * finished resolves false, and main has just flipped the task to `missing`.
 * Closing then would take away the one card that says so, leaving a click that
 * looks like it did nothing at all.
 */
function openThen(opened: Promise<boolean>, close: () => void): Promise<void> {
  return opened.then((ok) => {
    if (ok) close()
  }).catch(() => {})
}

function Fact({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="min-w-0">
      <div className="text-faint text-[10px] uppercase tracking-[0.4px]">{label}</div>
      <div className="truncate tnum text-[11.5px]" title={value}>
        {value}
      </div>
    </div>
  )
}
