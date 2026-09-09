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
import { resolvedLanguage, useT } from './i18n'
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
  const tasks = useApp((s) => s.tasks)
  const taskListVersion = useApp((s) => s.taskListVersion)
  const settings = useApp((s) => s.settings)
  const sidebar = useApp((s) => s.sidebar)
  const selection = useApp((s) => s.selection)
  const setSelection = useApp((s) => s.setSelection)
  const pending = useApp((s) => s.pending)

  const [search, setSearch] = useState('')
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
  const [siteGrabberOpen, setSiteGrabberOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [toolUpdates, setToolUpdates] = useState<ToolStatus[] | null>(null)
  const [draggingUrl, setDraggingUrl] = useState(false)
  const t = useT()

  useEffect(() => {
    void init()

    // Toasts raised by the main process - a browser handoff arriving, a queue
    // starting - are the only way those events are visible from in here.
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
          setSaveAsUrl((current) => current ?? urls[0])
          setOpenQueue((queue) => [...queue, ...urls.slice(1)])
        })
        .catch((err) => reportError('Could not open that torrent', err))
    }
    drainShellOpens()
    const offShellOpen = window.api.onShellOpen(drainShellOpens)

    return () => {
      offToast()
      offTools()
      offShellOpen()
    }
  }, [init])

  useEffect(() => {
    document.documentElement.lang = resolvedLanguage(settings.language)
  }, [settings.language])

  useEffect(() => {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    document.documentElement.dataset.theme = settings.theme === 'system'
      ? (systemDark ? 'dark' : 'light')
      : settings.theme
  }, [settings.theme])

  const progressSensitiveSort = ['size', 'progress', 'status', 'eta', 'speed'].includes(
    settings.sortColumn
  )
  const orderSource = progressSensitiveSort ? tasks : taskListVersion
  const orderedIds = useMemo(
    () => sortTasks(
      filterTasks(tasks, sidebar, search),
      settings.sortColumn,
      settings.sortDirection
    ).map((task) => task.id),
    // Static sort keys only need a new order after a structural task event.
    // Dynamic keys deliberately recompute from the 4 Hz progress snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orderSource, sidebar, search, settings.sortColumn, settings.sortDirection]
  )
  const rows = useMemo(() => {
    const byId = new Map(tasks.map((task) => [task.id, task]))
    const ordered = orderedIds.map((id) => byId.get(id)).filter((task): task is NonNullable<typeof task> => Boolean(task))

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
  }, [tasks, orderedIds])

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
      title: ids.length === 1 ? 'Delete this download?' : `Delete ${ids.length} downloads?`,
      message:
        finished.length > 0
          ? `${finished.length} of them finished. Their downloaded files stay on disk unless you say otherwise.`
          : 'Any partly downloaded data is discarded.',
      confirmLabel: 'Delete',
      danger: true,
      checkbox: finished.length > 0 ? 'Also delete the downloaded files' : undefined,
      onConfirm: remove
    })
  }, [tasks, settings.confirmDelete, setSelection])

  const actions: ToolbarActions = useMemo(() => ({
    onAdd: () => {
      void window.api.readClipboard()
        .then((value) => {
          const candidate = value.trim()
          if (looksLikeTorrentInput(candidate) || looksLikeYouTubeInput(candidate)) {
            setSaveAsUrl(candidate)
          }
          else setAddOpen(true)
        })
        .catch(() => setAddOpen(true))
    },
    onResume: () => {
      void window.api.startTasks(selection).catch((err) => reportError('Could not resume', err))
    },
    onPause: () => {
      void window.api.pauseTasks(selection).catch((err) => reportError('Could not stop', err))
    },
    onPauseAll: () => {
      void window.api.pauseAll().catch((err) => reportError('Could not stop', err))
    },
    onDelete: () => requestDelete(selection),
    onDeleteCompleted: () =>
      setConfirm({
        title: 'Remove completed downloads?',
        message: 'They disappear from the list. The files themselves are left where they are.',
        confirmLabel: 'Remove',
        onConfirm: () => {
          void window.api
            .removeCompleted()
            .catch((err) => reportError('Could not remove', err))
        }
      }),
    onDetails: () => selection[0] && setDetailId(selection[0]),
    onScheduler: () => setSchedulerOpen(true),
    onOptions: () => setOptionsOpen(true),
    onSiteGrabber: () => setSiteGrabberOpen(true)
  }), [selection, requestDelete])

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
              if (opened === 0) toast('info', 'Drop a .torrent file, or an HTTP link')
            })
            .catch((error) => reportError('Could not open the dropped files', error))
          return
        }

        const raw = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
        const urls = [...new Set(raw.split(/[\r\n\s]+/).filter((value) => /^https?:\/\//i.test(value)))]
        if (urls.length === 1) setSaveAsUrl(urls[0])
        else if (urls.length > 1) {
          void window.api.addDownloads(urls.map((url) => ({ url })))
            .then(() => toast('success', `${urls.length} dropped links added`))
            .catch((error) => reportError('Could not add dropped links', error))
        } else toast('info', 'Drop a .torrent file, or an HTTP link')
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
      <Toolbar actions={actions} search={search} onSearch={setSearch} />

      <div className="flex-1 min-h-0 flex">
        <Sidebar onEditQueues={() => setSchedulerOpen(true)} />

        <main className="flex-1 min-w-0 flex flex-col">
          {sidebar === 'clipboard' ? (
            <ClipboardPanel
              onDownload={(item) => {
                setClipboardDownload(item)
                setSaveAsUrl(item.url)
              }}
            />
          ) : (
            <DownloadTable
              rows={rows}
              onDetails={setDetailId}
              onGroupDetails={setGroupDetailId}
              onDelete={requestDelete}
            />
          )}
        </main>
      </div>

      <StatusBar onOpenOptions={() => setOptionsOpen(true)} />

      {addOpen && (
        <AddUrlDialog
          onClose={() => setAddOpen(false)}
          onSubmit={(urls) => {
            // One URL gets the Save As step; a pasted list would turn that into
            // a dialog per line, so those are filed by category and started.
            if (urls.length === 1) {
              // A playlist link is not one download and must not go through a
              // dialog that would silently resolve it to a single video.
              if (looksLikePlaylistInput(urls[0])) setPlaylistUrl(urls[0])
              else setSaveAsUrl(urls[0])
              return
            }
            void window.api.addDownloads(urls.map((url) => ({ url })))
              .then(() => toast('success', `${urls.length} downloads added`))
              .catch((err) => reportError('Could not add the downloads', err))
          }}
        />
      )}

      {playlistUrl && (
        <PlaylistDialog
          url={playlistUrl}
          onClose={() => setPlaylistUrl(null)}
          onSingleVideo={(single) => setSaveAsUrl(single)}
        />
      )}

      {saveAsUrl && (
        <SaveAsDialog
          url={saveAsUrl}
          clipboardItem={clipboardDownload ?? undefined}
          onAdded={clipboardDownload ? () => {
            void window.api.removeClipboardItem(clipboardDownload.id)
            setClipboardDownload(null)
          } : undefined}
          onClose={() => {
            setClipboardDownload(null)
            // Whatever the shell handed us next, rather than nothing.
            setSaveAsUrl(openQueue[0] ?? null)
            setOpenQueue((queue) => queue.slice(1))
          }}
        />
      )}
      {detailId && <TaskDetailDialog id={detailId} onClose={() => setDetailId(null)} />}
      {groupDetailId && (
        <GroupDetailDialog groupId={groupDetailId} onClose={() => setGroupDetailId(null)} />
      )}
      {schedulerOpen && <SchedulerDialog onClose={() => setSchedulerOpen(false)} />}
      {siteGrabberOpen && <SiteGrabberDialog onClose={() => setSiteGrabberOpen(false)} />}
      {optionsOpen && (
        <OptionsDialog onClose={() => setOptionsOpen(false)} onShowTools={setToolUpdates} />
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
