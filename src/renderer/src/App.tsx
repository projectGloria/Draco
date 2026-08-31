import { useEffect, useMemo, useCallback, useState } from 'react'
import { filterTasks, sortTasks, useApp } from './store/app'
import { reportError, toast } from './store/toasts'
import AddUrlDialog from './components/AddUrlDialog'
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
import TitleBar from './components/TitleBar'
import Toasts from './components/Toasts'
import Toolbar, { type ToolbarActions } from './components/Toolbar'
import { resolvedLanguage } from './i18n'

export default function App(): React.ReactElement {
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
  const [detailId, setDetailId] = useState<string | null>(null)
  const [schedulerOpen, setSchedulerOpen] = useState(false)
  const [siteGrabberOpen, setSiteGrabberOpen] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [draggingUrl, setDraggingUrl] = useState(false)

  useEffect(() => {
    void init()

    // Toasts raised by the main process - a browser handoff arriving, a queue
    // starting - are the only way those events are visible from in here.
    const offToast = window.api.onToast((incoming) => {
      toast(incoming.kind === 'error' ? 'danger' : incoming.kind, incoming.message)
    })

    // Clipboard watching offers the link rather than acting on it: Save As opens
    // with the URL filled in, and Escape is the whole cost of ignoring it.
    const offClipboard = window.api.onClipboardUrl((url) => setSaveAsUrl(url))

    return () => {
      offToast()
      offClipboard()
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
    return orderedIds.map((id) => byId.get(id)).filter((task): task is NonNullable<typeof task> => Boolean(task))
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
    onAdd: () => setAddOpen(true),
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
        if ([...event.dataTransfer.types].some((type) => type === 'text/uri-list' || type === 'text/plain')) {
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
        const raw = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
        const urls = [...new Set(raw.split(/[\r\n\s]+/).filter((value) => /^https?:\/\//i.test(value)))]
        if (urls.length === 1) setSaveAsUrl(urls[0])
        else if (urls.length > 1) {
          void window.api.addDownloads(urls.map((url) => ({ url })))
            .then(() => toast('success', `${urls.length} dropped links added`))
            .catch((error) => reportError('Could not add dropped links', error))
        } else toast('info', 'Drop an HTTP or HTTPS link')
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
          <DownloadTable rows={rows} onDetails={setDetailId} onDelete={requestDelete} />
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
              setSaveAsUrl(urls[0])
              return
            }
            void window.api.addDownloads(urls.map((url) => ({ url })))
              .then(() => toast('success', `${urls.length} downloads added`))
              .catch((err) => reportError('Could not add the downloads', err))
          }}
        />
      )}

      {saveAsUrl && <SaveAsDialog url={saveAsUrl} onClose={() => setSaveAsUrl(null)} />}
      {detailId && <TaskDetailDialog id={detailId} onClose={() => setDetailId(null)} />}
      {schedulerOpen && <SchedulerDialog onClose={() => setSchedulerOpen(false)} />}
      {siteGrabberOpen && <SiteGrabberDialog onClose={() => setSiteGrabberOpen(false)} />}
      {optionsOpen && <OptionsDialog onClose={() => setOptionsOpen(false)} />}
      {confirm && <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />}

      {pending && <PendingActionBar pending={pending} />}
      <Toasts />
      {draggingUrl && (
        <div className="pointer-events-none fixed inset-3 z-[95] grid place-items-center rounded-2xl border-2 border-dashed border-[var(--accent)] bg-black/70 backdrop-blur-sm">
          <div className="text-center">
            <div className="text-lg font-semibold text-ink">Drop links to download</div>
            <div className="text-xs text-muted mt-1">HTTP and HTTPS addresses are accepted</div>
          </div>
        </div>
      )}
    </div>
  )
}
