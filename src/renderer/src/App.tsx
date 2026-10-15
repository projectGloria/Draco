import { playCompletionSound } from './lib/completion-sound'
import { useEffect, useMemo, useCallback, useState } from 'react'
import { filterTasks, sortTasks, useApp } from './store/app'
import { reportError, toast } from './store/toasts'
import AddUrlDialog from './components/AddUrlDialog'
import ClipboardPanel from './components/ClipboardPanel'
import ConfirmDialog, { type ConfirmRequest } from './components/ConfirmDialog'
import DownloadTable from './components/DownloadTable'
import OptionsDialog from './components/OptionsDialog'
import PendingActionBar from './components/PendingActionBar'
import SaveAsDialog from './components/SaveAsDialog'
import SchedulerDialog from './components/SchedulerDialog'
import SiteGrabberDialog from './components/SiteGrabberDialog'
import Sidebar from './components/Sidebar'
import StatusBar from './components/StatusBar'
import TaskDetailDialog from './components/TaskDetailDialog'
import GroupDetailDialog from './components/GroupDetailDialog'
import TitleBar from './components/TitleBar'
import Toasts from './components/Toasts'
import ToolUpdateDialog from './components/ToolUpdateDialog'
import Toolbar, { type ToolbarActions } from './components/Toolbar'
import Dropzone from './components/Dropzone'
import PlaylistDialog from './components/PlaylistDialog'
import { useT } from './i18n'
import { useAppearance } from './lib/use-appearance'
import { buildDisplayRows } from '@shared/groups'
import { orderedQueueIds } from '@shared/queue-order'
import { looksLikePlaylistInput, looksLikeTorrentInput, looksLikeYouTubeInput } from './lib/format'
import type { ClipboardItem, ToolStatus } from '@shared/types'

/**
 * Drag types worth lighting the window up for. `Files` is what Explorer offers
 * for a dropped `.torrent`; the two text flavours are what a browser offers for
 * a dragged link.
 */
const DROPPABLE_TYPES = new Set(['Files', 'text/uri-list', 'text/plain'])

/**
 * The on-disk paths behind a drop. A `File` no longer carries its own path, so
 * the preload has to ask Chromium for each one; anything it will not name - a
 * dragged selection from a web page, say - drops out here.
 */
function droppedPaths(transfer: DataTransfer): string[] {
  return [...transfer.files]
    .map((file) => window.api.pathForDroppedFile(file))
    .filter((path) => path.length > 0)
}

export default function App(): React.ReactElement {
  if (window.location.hash === '#dropzone') {
    return <Dropzone />
  }

  const init = useApp((s) => s.init)
  const ready = useApp((s) => s.ready)
  const initializing = useApp((s) => s.initializing)
  const initError = useApp((s) => s.initError)
  const tasks = useApp((s) => s.tasks)
  const categories = useApp((s) => s.categories)
  const queues = useApp((s) => s.queues)
  const taskListVersion = useApp((s) => s.taskListVersion)
  const settings = useApp((s) => s.settings)
  const sidebar = useApp((s) => s.sidebar)
  const setSidebar = useApp((s) => s.setSidebar)
  const activeQueue = queues.find((queue) => sidebar === `queue:${queue.id}`)
  const selection = useApp((s) => s.selection)
  const setSelection = useApp((s) => s.setSelection)
  const pending = useApp((s) => s.pending)

  const [addOpen, setAddOpen] = useState(false)
  const [saveAsUrl, setSaveAsUrl] = useState<string | null>(null)
  /** A playlist or channel link, which stands for many downloads rather than one. */
  const [playlistUrl, setPlaylistUrl] = useState<string | null>(null)
  /**
   * Torrents Windows asked Draco to open, beyond the one on screen. Selecting
   * several `.torrent` files and pressing Enter launches one process per file,
   * and a dialog per file all at once would be unusable - so they queue, and
   * the next opens as the current one is closed.
   */
  const [openQueue, setOpenQueue] = useState<string[]>([])
  const [clipboardDownload, setClipboardDownload] = useState<ClipboardItem | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [groupDetailId, setGroupDetailId] = useState<string | null>(null)
  const [schedulerOpen, setSchedulerOpen] = useState(false)
  const [schedulerQueueId, setSchedulerQueueId] = useState<string | undefined>()
  const [siteGrabberOpen, setSiteGrabberOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [toolUpdates, setToolUpdates] = useState<ToolStatus[] | null>(null)
  const [draggingUrl, setDraggingUrl] = useState(false)
  const t = useT()
  useAppearance(settings)

  useEffect(() => {
    void init()

    // Toasts raised by the main process - a browser handoff arriving, a queue
    // starting - are the only way those events are visible from in here.
    const offCompletionSound = window.api.onDownloadComplete(playCompletionSound)
    const offToast = window.api.onToast((incoming) => {
      toast(incoming.kind === 'error' ? 'danger' : incoming.kind, incoming.message)
    })

    // ffmpeg and yt-dlp are fetched, not shipped, and yt-dlp in particular goes
    // stale against YouTube. Main only ever announces; the dialog is where the
    // user decides.
    const offTools = window.api.onToolUpdates((tools) => setToolUpdates(tools))

    // A double-clicked `.torrent` or a clicked magnet link. Main holds them
    // until they are drained, so one that arrived during startup - the whole
    // reason this window exists - is still here by the time it can be shown.
    const drainShellOpens = (): void => {
      void window.api
        .takePendingOpens()
        .then((urls) => {
          if (urls.length === 0) return
          // Enqueue every item, including the first. A dialog already on
          // screen must not cause the first item of a later shell event to be
          // discarded while its remaining siblings are queued.
          setOpenQueue((queue) => [...queue, ...urls])
        })
        .catch((err) => reportError('Could not open that torrent', err))
    }
    drainShellOpens()
    const offShellOpen = window.api.onShellOpen(drainShellOpens)

    return () => {
      offCompletionSound()
      offToast()
      offTools()
      offShellOpen()
    }
  }, [init])

  useEffect(() => {
    if (saveAsUrl || playlistUrl || openQueue.length === 0) return
    const next = openQueue[0]
    setOpenQueue((queue) => queue.slice(1))
    if (looksLikePlaylistInput(next)) setPlaylistUrl(next)
    else setSaveAsUrl(next)
  }, [openQueue, saveAsUrl, playlistUrl])

  const hasActiveTasks = useMemo(
    () => tasks.some((t) => t.status === 'downloading' || t.status === 'probing' || t.status === 'processing' || t.status === 'scanning'),
    [tasks]
  )

  const progressSensitiveSort = hasActiveTasks && ['progress', 'status', 'eta', 'speed'].includes(
    settings.sortColumn
  )

  const [dynamicSortTick, setDynamicSortTick] = useState(0)

  useEffect(() => {
    if (!progressSensitiveSort) return
    const timer = setInterval(() => {
      setDynamicSortTick((tick) => tick + 1)
    }, 1500)
    return () => clearInterval(timer)
  }, [progressSensitiveSort])

  const orderedIds = useMemo(
    () => activeQueue ? orderedQueueIds(activeQueue.taskIds, filterTasks(tasks, sidebar).map((task) => task.id)) : sortTasks(
      filterTasks(tasks, sidebar),
      settings.sortColumn,
      settings.sortDirection
    ).map((task) => task.id),
    // Static sort keys only need a new order after a structural task event.
    // Dynamic keys recompute smoothly on a throttled timer to prevent table jumping and UI thread churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeQueue, progressSensitiveSort ? dynamicSortTick : taskListVersion, taskListVersion, sidebar, settings.sortColumn, settings.sortDirection]
  )
  const rows = useMemo(() => {
    const byId = new Map(tasks.map((task) => [task.id, task]))
    const ordered = orderedIds.map((id) => byId.get(id)).filter((task): task is NonNullable<typeof task> => Boolean(task))
    if (activeQueue) return ordered

    const groups = new Map<string, typeof ordered>()
    for (const task of ordered) {
      if (!task.groupId) continue
      let list = groups.get(task.groupId)
      if (!list) groups.set(task.groupId, (list = []))
      list.push(task)
    }

    const emittedGroups = new Set<string>()
    const grouped: typeof ordered = []
    for (const task of ordered) {
      if (!task.groupId) {
        grouped.push(task)
      } else if (!emittedGroups.has(task.groupId)) {
        emittedGroups.add(task.groupId)
        const members = groups.get(task.groupId)
        if (members) grouped.push(...members)
      }
    }
    return grouped
  }, [tasks, orderedIds, activeQueue])

  /**
   * The rows the table and the status bar both draw.
   *
   * Built once here rather than independently in each. A group is one row in
   * both places, so two separate grouping passes could only ever agree by
   * accident, and they cost twice as much while doing it.
   */
  const displayRows = useMemo(() => activeQueue ? rows.map((task) => ({ kind: 'task' as const, task })) : buildDisplayRows(rows), [rows, activeQueue])

  /**
   * Opens whatever a URL actually stands for.
   *
   * A playlist or channel link is many downloads, not one, and the Save As
   * dialog resolves it with `--no-playlist` - so sending one there either
   * silently fetched the single video the link happened to also name, or failed
   * with a message about PO tokens that had nothing to do with what happened.
   *
   * Every route a user-supplied URL can arrive on goes through here: the
   * toolbar's Add button, a dropped link, the clipboard inbox, and whatever the
   * shell handed us. `AddUrlDialog` used to be the only one that checked, which
   * is why the playlist dialog was very nearly unreachable.
   */
  const openUrl = useCallback((value: string): void => {
    if (looksLikePlaylistInput(value)) setPlaylistUrl(value)
    else setSaveAsUrl(value)
  }, [])

  const addUrls = useCallback((urls: string[], source: 'paste' | 'drop'): void => {
    // A page URL is not a media file. Keep the normal file batch fast, while
    // each YouTube link goes through the same quality/playlist picker as a
    // single pasted link instead of saving the watch page's HTML.
    const media = urls.filter(looksLikeYouTubeInput)
    const direct = urls.filter((url) => !looksLikeYouTubeInput(url))
    if (media.length > 0) setOpenQueue((queue) => [...queue, ...media])
    if (direct.length === 0) return
    void window.api.addDownloads(direct.map((url) => ({ url })))
      .then(() => toast('success', t(source === 'drop' ? 'droppedLinksAdded' : 'downloadsAdded', { count: direct.length })))
      .catch((error) => reportError(t(source === 'drop' ? 'addDroppedFailed' : 'addFailed'), error))
  }, [t])

  /* ---------------------------------------------------------------- */
  /* Commands                                                          */
  /* ---------------------------------------------------------------- */

  const requestDelete = useCallback((ids: string[]): void => {
    const targets = ids.map((id) => tasks.find((t) => t.id === id)).filter((t) => t != null)
    if (targets.length === 0) return
    setSelection([])

    const finished = targets.filter((t) => t?.status === 'done')

    const remove = (deleteFiles: boolean): void => {
      void window.api
        .removeTasks(ids, deleteFiles)
        .catch((err) => reportError('Could not delete', err))
    }

    // Partial data is always discarded - it is Draco's own scratch file. What
    // needs asking about is a finished file the user may still want.
    if (!settings.confirmDelete && finished.length === 0) {
      remove(false)
      return
    }

    setConfirm({
      title: ids.length === 1 ? t('confirmDeleteOne') : t('confirmDeleteMany', { count: ids.length }),
      message:
        finished.length > 0
          ? t('confirmDeleteFinished', { count: finished.length })
          : t('confirmDeletePartial'),
      confirmLabel: t('delete'),
      danger: true,
      checkbox: finished.length > 0 ? t('confirmDeleteFiles') : undefined,
      onConfirm: remove
    })
  }, [tasks, settings.confirmDelete, setSelection, t])

  const actions: ToolbarActions = useMemo(() => ({
    onAdd: () => {
      void window.api.readClipboard()
        .then((value) => {
          const candidate = value.trim()
          if (looksLikeTorrentInput(candidate) || looksLikeYouTubeInput(candidate)) {
            // Through `openUrl`, not straight to Save As: a playlist link on
            // the clipboard is a YouTube link, and this button was the most
            // common way of sending one to the dialog that cannot handle it.
            openUrl(candidate)
          }
          else setAddOpen(true)
        })
        .catch(() => setAddOpen(true))
    },
    onResume: () => {
      void window.api.startTasks(selection).catch((err) => reportError(t('resumeFailed'), err))
    },
    onPause: () => {
      void window.api.pauseTasks(selection).catch((err) => reportError(t('stopFailed'), err))
    },
    onPauseAll: () => {
      void window.api.pauseAll().catch((err) => reportError(t('stopFailed'), err))
    },
    onDelete: () => requestDelete(selection),
    onDeleteCompleted: () =>
      setConfirm({
        title: t('removeCompletedTitle'),
        message: t('removeCompletedBody'),
        confirmLabel: t('removeCompletedConfirm'),
        onConfirm: () => {
          void window.api
            .removeCompleted()
            .catch((err) => reportError(t('removeFailed'), err))
        }
      }),
    onDetails: () => selection[0] && setDetailId(selection[0]),
    onScheduler: () => setSchedulerOpen(true),
    onOptions: () => setOptionsOpen(true),
    onSiteGrabber: () => setSiteGrabberOpen(true)
  }), [selection, requestDelete, openUrl, t])

  if (!ready) {
    return (
      <div className="app-bg h-full flex flex-col overflow-hidden">
        <TitleBar />
        <main className="flex-1 grid place-items-center p-6">
          {initError ? (
            <section role="alert" className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-xl">
              <h1 className="font-display text-lg font-semibold text-ink">{t('startupErrorTitle')}</h1>
              <p className="mt-2 text-sm text-muted">{t('startupErrorHint')}</p>
              <p className="mt-3 break-words rounded-lg bg-black/10 p-3 text-xs text-muted">{initError}</p>
              <button
                type="button"
                onClick={() => void init()}
                disabled={initializing}
                className="mt-5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
              >
                {t('retry')}
              </button>
            </section>
          ) : (
            <div role="status" className="text-sm text-muted">{t('startupLoading')}</div>
          )}
        </main>
        <Toasts />
      </div>
    )
  }

  return (
    <div
      className="app-bg h-full flex flex-col overflow-hidden"
      onDragEnter={(event) => {
        if ([...event.dataTransfer.types].some((type) => DROPPABLE_TYPES.has(type))) {
          event.preventDefault()
          setDraggingUrl(true)
        }
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDraggingUrl(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDraggingUrl(false)
        // Files first: a drop carrying real files never also means a link, and
        // Chromium puts a `text/plain` copy of the file name next to them.
        const paths = droppedPaths(event.dataTransfer)
        if (paths.length > 0) {
          void window.api
            .openTorrentFiles(paths)
            .then((opened) => {
              if (opened === 0) toast('info', t('dropTorrentHint'))
            })
            .catch((error) => reportError(t('openDroppedFailed'), error))
          return
        }

        const raw = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
        const urls = [...new Set(raw.split(/[\r\n\s]+/).filter((value) => /^https?:\/\//i.test(value)))]
        if (urls.length === 1) openUrl(urls[0])
        else if (urls.length > 1) addUrls(urls, 'drop')
        else toast('info', t('dropTorrentHint'))
      }}
    >
      <span
        className="bloom w-[420px] h-[420px] -top-[180px] -left-[120px] opacity-[0.16]"
        style={{ background: 'var(--accent)' }}
      />
      <span
        className="bloom w-[360px] h-[360px] -bottom-[200px] right-[10%] opacity-[0.10]"
        style={{ background: 'var(--accent-2)' }}
      />

      <TitleBar />
      <Toolbar actions={actions} />
      <div className="hidden max-[720px]:flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <label htmlFor="compact-view" className="text-xs text-muted">{t('view')}</label>
        <select
          id="compact-view"
          value={sidebar}
          onChange={(event) => setSidebar(event.target.value)}
          className="field min-w-0 flex-1 text-sm"
        >
          <option value="all">{t('allDownloads')}</option>
          <option value="active">{t('activeDownloads')}</option>
          <option value="queued">{t('queuedDownloads')}</option>
          <option value="attention">{t('needsAttention')}</option>
          <option value="finished">{t('finished')}</option>
          <option value="unfinished">{t('unfinished')}</option>
          <option value="clipboard">{t('clipboard')}</option>
          {categories.length > 0 && <optgroup label={t('categories')}>
            {categories.map((category) => <option key={category.id} value={`cat:${category.id}`}>{category.name}</option>)}
          </optgroup>}
          {queues.length > 0 && <optgroup label={t('queues')}>
            {queues.map((queue) => <option key={queue.id} value={`queue:${queue.id}`}>{queue.name}</option>)}
          </optgroup>}
        </select>
      </div>
      <div className="flex-1 min-h-0 flex">
        <Sidebar onEditQueues={(id) => { setSchedulerQueueId(id); setSchedulerOpen(true) }} />

        <main className="flex-1 min-w-0 flex flex-col">
          {sidebar === 'clipboard' ? (
            <ClipboardPanel
              onDownload={(item) => {
                // A playlist copied to the clipboard reaches the inbox like any
                // other link and must still open as a playlist from here.
                if (looksLikePlaylistInput(item.url)) {
                  setPlaylistUrl(item.url)
                  return
                }
                setClipboardDownload(item)
                setSaveAsUrl(item.url)
              }}
            />
          ) : (
            <DownloadTable
              rows={rows}
              display={displayRows}
              onDetails={setDetailId}
              onGroupDetails={setGroupDetailId}
              onDelete={requestDelete}
            />
          )}
        </main>
      </div>

      <StatusBar rows={displayRows} onOpenOptions={() => setOptionsOpen(true)} />

      {addOpen && (
        <AddUrlDialog
          onClose={() => setAddOpen(false)}
          onSubmit={(urls) => {
            // One URL gets the Save As step; a pasted list would turn that into
            // a dialog per line, so those are filed by category and started.
            if (urls.length === 1) {
              // A playlist link is not one download and must not go through a
              // dialog that would silently resolve it to a single video.
              openUrl(urls[0])
              return
            }
            addUrls(urls, 'paste')
          }}
        />
      )}

      {playlistUrl && (
        <PlaylistDialog
          key={playlistUrl}
          url={playlistUrl}
          onClose={() => setPlaylistUrl(null)}
          onSingleVideo={(single) => setSaveAsUrl(single)}
        />
      )}

      {saveAsUrl && (
        <SaveAsDialog
          key={`${saveAsUrl}:${clipboardDownload?.id ?? ''}`}
          url={saveAsUrl}
          clipboardItem={clipboardDownload ?? undefined}
          onAdded={clipboardDownload ? () => {
            void window.api.removeClipboardItem(clipboardDownload.id)
            setClipboardDownload(null)
          } : undefined}
          onPlaylist={(playlist) => {
            setClipboardDownload(null)
            setPlaylistUrl(playlist)
          }}
          onClose={() => {
            setClipboardDownload(null)
            setSaveAsUrl(null)
          }}
        />
      )}
      {detailId && <TaskDetailDialog key={detailId} id={detailId} onClose={() => setDetailId(null)} />}
      {groupDetailId && (
        <GroupDetailDialog key={groupDetailId} groupId={groupDetailId} onClose={() => setGroupDetailId(null)} />
      )}
      {schedulerOpen && <SchedulerDialog initialQueueId={schedulerQueueId} onClose={() => { setSchedulerOpen(false); setSchedulerQueueId(undefined) }} />}
      {siteGrabberOpen && <SiteGrabberDialog onClose={() => setSiteGrabberOpen(false)} />}
      {optionsOpen && (
        <OptionsDialog onClose={() => setOptionsOpen(false)} />
      )}
      {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}
      {toolUpdates && (
        <ToolUpdateDialog
          tools={toolUpdates}
          onClose={() => setToolUpdates(null)}
          onUpdated={(next) =>
            setToolUpdates((current) =>
              current ? current.map((tool) => (tool.id === next.id ? next : tool)) : current
            )
          }
        />
      )}

      {pending && <PendingActionBar pending={pending} />}
      <Toasts />
      {draggingUrl && (
        <div className="pointer-events-none fixed inset-3 z-[95] grid place-items-center rounded-2xl border-2 border-dashed border-[var(--accent)] bg-black/70 backdrop-blur-sm">
          <div className="text-center">
            <div className="text-lg font-semibold text-ink">{t('dropTitle')}</div>
            <div className="text-xs text-muted mt-1">{t('dropHint')}</div>
          </div>
        </div>
      )}
    </div>
  )
}
