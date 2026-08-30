import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ColumnId, DownloadTask, TaskStatus } from '@shared/types'
import { formatBytes, formatEta, formatPercent, formatSpeed, formatWhen, percent } from '../lib/format'
import { queueName, useApp } from '../store/app'
import { reportError, toast } from '../store/toasts'
import ContextMenu, { type MenuItem, type MenuPosition } from './ContextMenu'
import FileIcon from './FileIcon'
import { DownloadIcon, SortArrow } from './Icons'
import ProgressBar from './ProgressBar'

const HEADINGS: Record<ColumnId, string> = {
  name: 'Name',
  size: 'Size',
  progress: 'Progress',
  status: 'Status',
  eta: 'Time left',
  speed: 'Speed',
  queue: 'Queue',
  added: 'Added',
  description: 'Description'
}

/** Numeric columns are right-aligned so their digits line up down the column. */
const RIGHT: ReadonlySet<ColumnId> = new Set<ColumnId>(['size', 'eta', 'speed'])

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'Queued',
  probing: 'Connecting',
  downloading: 'Downloading',
  paused: 'Paused',
  done: 'Complete',
  error: 'Error',
  missing: 'File missing'
}

const STATUS_COLOR: Record<TaskStatus, string> = {
  queued: 'var(--color-faint)',
  probing: 'var(--accent)',
  downloading: 'var(--accent)',
  paused: 'var(--color-faint)',
  done: 'var(--color-ok)',
  error: 'var(--color-err)',
  missing: 'var(--color-warn)'
}

export default function DownloadTable({
  rows,
  onDetails,
  onDelete
}: {
  rows: DownloadTask[]
  onDetails(id: string): void
  onDelete(ids: string[]): void
}): React.ReactElement {
  const settings = useApp((s) => s.settings)
  const queues = useApp((s) => s.queues)
  const selection = useApp((s) => s.selection)
  const clickRow = useApp((s) => s.clickRow)
  const selectAll = useApp((s) => s.selectAll)
  const setSelection = useApp((s) => s.setSelection)
  const setSort = useApp((s) => s.setSort)
  const setColumnWidth = useApp((s) => s.setColumnWidth)
  const toggleColumn = useApp((s) => s.toggleColumn)

  const [menu, setMenu] = useState<{ at: MenuPosition; items: MenuItem[] } | null>(null)
  const body = useRef<HTMLDivElement>(null)

  const columns = useMemo(() => settings.columns.filter((c) => c.visible), [settings.columns])
  const template = columns.map((c) => c.width + 'px').join(' ') + ' 1fr'
  const minWidth = columns.reduce((sum, c) => sum + c.width, 0)

  /* ---------------------------------------------------------------- */
  /* Column resizing                                                   */
  /* ---------------------------------------------------------------- */

  const startResize = useCallback(
    (event: React.MouseEvent, id: ColumnId, startWidth: number) => {
      event.preventDefault()
      event.stopPropagation()
      const startX = event.clientX

      const move = (moveEvent: MouseEvent): void => {
        setColumnWidth(id, startWidth + (moveEvent.clientX - startX))
      }
      const up = (): void => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
      }

      // The cursor is forced for the whole drag; otherwise it reverts the moment
      // the pointer leaves the 7px grip, which makes the drag feel dropped.
      document.body.style.cursor = 'col-resize'
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [setColumnWidth]
  )

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                          */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

      if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        selectAll(rows)
        return
      }
      if (event.key === 'Delete' && selection.length > 0) {
        event.preventDefault()
        onDelete(selection)
        return
      }
      if (event.key === 'Escape') setSelection([])
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows, selection, selectAll, setSelection, onDelete])

  /* ---------------------------------------------------------------- */
  /* Menus                                                             */
  /* ---------------------------------------------------------------- */

  function headerMenu(event: React.MouseEvent): void {
    event.preventDefault()
    setMenu({
      at: { x: event.clientX, y: event.clientY },
      items: settings.columns.map((column) => ({
        label: HEADINGS[column.id],
        checked: column.visible,
        // The name column is what identifies a row; hiding it would leave a
        // table of numbers with nothing to attach them to.
        disabled: column.id === 'name',
        onClick: () => toggleColumn(column.id)
      }))
    })
  }

  function rowMenu(event: React.MouseEvent, task: DownloadTask): void {
    event.preventDefault()

    // Right-clicking outside the selection moves it, the way Explorer does.
    const ids = selection.includes(task.id) ? selection : [task.id]
    if (!selection.includes(task.id)) setSelection([task.id])

    const running = ids.some((id) => {
      const t = rows.find((r) => r.id === id)
      return t?.status === 'downloading' || t?.status === 'queued'
    })

    const items: MenuItem[] = [
      {
        label: running ? 'Stop download' : 'Resume download',
        disabled: task.status === 'done' && !running,
        onClick: () => {
          const call = running ? window.api.pauseTasks(ids) : window.api.startTasks(ids)
          void call.catch((err) => reportError('Command failed', err))
        }
      },
      { label: 'Redownload', onClick: () => void window.api.redownload(task.id).catch((err) => reportError('Redownload failed', err)) },
      {},
      {
        label: 'Open file',
        disabled: task.status !== 'done',
        onClick: () => void window.api.openFile(task.id).catch((err) => reportError('Could not open the file', err))
      },
      {
        label: 'Open containing folder',
        onClick: () => void window.api.revealFile(task.id).catch((err) => reportError('Could not open the folder', err))
      },
      {
        label: 'Copy download URL',
        onClick: () => {
          void window.api.copyToClipboard(task.url)
          toast('info', 'URL copied')
        }
      },
      { label: 'Properties…', onClick: () => onDetails(task.id) },
      {}
    ]

    for (const queue of queues) {
      items.push({
        label: 'Move to ' + queue.name,
        checked: ids.every((id) => rows.find((r) => r.id === id)?.queueId === queue.id),
        onClick: () => void patchQueue(ids, queue.id)
      })
    }
    if (queues.length > 0) {
      items.push({
        label: 'Remove from queue',
        disabled: ids.every((id) => !rows.find((r) => r.id === id)?.queueId),
        onClick: () => void patchQueue(ids, null)
      })
      items.push({})
    }

    items.push({ label: 'Delete', danger: true, onClick: () => onDelete(ids) })

    setMenu({ at: { x: event.clientX, y: event.clientY }, items })
  }

  /* ---------------------------------------------------------------- */

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto" ref={body}>
        <div style={{ minWidth }}>
          {/* Sticky so the headings stay put while a long list scrolls. */}
          <div
            className="grid sticky top-0 z-10 h-8 bg-surface border-b border-line-strong select-none"
            style={{ gridTemplateColumns: template }}
            onContextMenu={headerMenu}
          >
            {columns.map((column) => {
              const sorted = settings.sortColumn === column.id
              return (
                <div
                  key={column.id}
                  className={
                    'relative flex items-center gap-1.5 px-2.5 text-[11px] font-semibold uppercase ' +
                    'tracking-[0.4px] cursor-pointer transition-colors hover:text-ink ' +
                    (sorted ? 'text-ink' : 'text-faint') +
                    (RIGHT.has(column.id) ? ' justify-end' : '')
                  }
                  onClick={() => setSort(column.id)}
                  title={'Sort by ' + HEADINGS[column.id]}
                >
                  <span className="truncate">{HEADINGS[column.id]}</span>
                  {sorted && (
                    <span style={{ color: 'var(--accent)' }}>
                      <SortArrow direction={settings.sortDirection} />
                    </span>
                  )}
                  <span
                    className="col-grip"
                    onMouseDown={(event) => startResize(event, column.id, column.width)}
                    onClick={(event) => event.stopPropagation()}
                  />
                </div>
              )
            })}
            <div />
          </div>

          {rows.length === 0 ? (
            <EmptyState />
          ) : (
            rows.map((task) => (
              <Row
                key={task.id}
                task={task}
                columns={columns.map((c) => c.id)}
                template={template}
                selected={selection.includes(task.id)}
                queueLabel={queueName(queues, task.queueId)}
                onMouseDown={(event) => {
                  if (event.button === 2) return
                  clickRow(task.id, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey }, rows)
                }}
                onDoubleClick={() => {
                  // Finished downloads open; anything else has nothing to open
                  // yet, so the useful thing is the segment view.
                  if (task.status === 'done') {
                    void window.api.openFile(task.id).catch((err) => reportError('Could not open the file', err))
                  } else {
                    onDetails(task.id)
                  }
                }}
                onContextMenu={(event) => rowMenu(event, task)}
              />
            ))
          )}
        </div>
      </div>

      {menu && <ContextMenu at={menu.at} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

async function patchQueue(ids: string[], queueId: string | null): Promise<void> {
  try {
    for (const id of ids) await window.api.updateTask(id, { queueId })
  } catch (err) {
    reportError('Could not change the queue', err)
  }
}

const Row = memo(function Row({
  task,
  columns,
  template,
  selected,
  queueLabel,
  onMouseDown,
  onDoubleClick,
  onContextMenu
}: {
  task: DownloadTask
  columns: ColumnId[]
  template: string
  selected: boolean
  queueLabel: string
  onMouseDown(event: React.MouseEvent): void
  onDoubleClick(): void
  onContextMenu(event: React.MouseEvent): void
}): React.ReactElement {
  return (
    <div
      className={
        'grid items-center border-b border-line/60 cursor-default transition-colors ' +
        (selected ? 'text-ink' : 'hover:bg-white/[0.035]')
      }
      style={{
        gridTemplateColumns: template,
        height: 'var(--row-h)',
        background: selected ? 'var(--accent-soft)' : undefined,
        boxShadow: selected ? 'inset 2px 0 0 var(--accent)' : undefined
      }}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      {columns.map((id) => (
        <Cell key={id} id={id} task={task} queueLabel={queueLabel} />
      ))}
      <div />
    </div>
  )
})

function Cell({
  id,
  task,
  queueLabel
}: {
  id: ColumnId
  task: DownloadTask
  queueLabel: string
}): React.ReactElement {
  const base = 'px-2.5 text-[12px] truncate min-w-0 ' + (RIGHT.has(id) ? 'text-right tnum ' : '')

  switch (id) {
    case 'name':
      return (
        <div className={base + ' flex items-center gap-2'} title={task.filename + '\n' + task.url}>
          <span className="shrink-0 grid place-items-center">
            <FileIcon
              name={task.filename}
              className="w-4 h-4"
              color={STATUS_COLOR[task.status]}
            />
          </span>
          <span className="truncate">{task.filename}</span>
        </div>
      )

    case 'size':
      return <div className={base}>{formatBytes(task.size)}</div>

    case 'progress':
      return (
        <div className={base + ' flex items-center gap-2'}>
          <ProgressBar
            percent={task.size ? percent(task.received, task.size) : task.status === 'done' ? 100 : null}
            status={task.status}
          />
          <span className="tnum text-[11px] text-faint w-[42px] text-right shrink-0">
            {task.size ? formatPercent(task.received, task.size) : formatBytes(task.received)}
          </span>
        </div>
      )

    case 'status':
      return (
        <div
          className={base + ' flex items-center gap-2'}
          title={task.error ?? task.detail ?? STATUS_LABEL[task.status]}
        >
          <span
            className={
              'w-1.5 h-1.5 rounded-full shrink-0 ' +
              (task.status === 'downloading' || task.status === 'probing' ? 'animate-pulse' : '')
            }
            style={{ background: STATUS_COLOR[task.status] }}
          />
          <span className="truncate" style={{ color: task.status === 'error' ? 'var(--color-err)' : undefined }}>
            {task.status === 'error' && task.error
              ? task.error
              : /* The detail says what a long stage is actually doing - fetching
                   ffmpeg, muxing - which "Downloading" on its own does not. */
                (task.detail ?? STATUS_LABEL[task.status])}
          </span>
        </div>
      )

    /*
     * Both read the figure rather than the status label. A stream fetched as
     * separate video and audio parts stays `probing` until its parts are past
     * their own probe, and gating on the label left these columns blank for the
     * whole transfer. The engine zeroes speed and nulls eta on pause, error and
     * completion, so the value alone says whether there is anything to show.
     */
    case 'eta':
      return <div className={base}>{formatEta(task.eta)}</div>

    case 'speed':
      return (
        <div className={base} style={{ color: task.speed > 0 ? 'var(--accent)' : undefined }}>
          {formatSpeed(task.speed)}
        </div>
      )

    case 'queue':
      return <div className={base + ' text-muted'}>{queueLabel}</div>

    case 'added':
      return <div className={base + ' text-muted tnum'}>{formatWhen(task.createdAt)}</div>

    case 'description':
    default:
      return (
        <div className={base + ' text-muted'} title={task.description}>
          {task.description}
        </div>
      )
  }
}

function EmptyState(): React.ReactElement {
  return (
    <div className="py-20 grid place-items-center text-center fade-up">
      <div
        className="w-12 h-12 rounded-2xl grid place-items-center mb-3"
        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
      >
        <DownloadIcon className="w-6 h-6" />
      </div>
      <p className="text-[13px] font-semibold">Nothing here yet</p>
      <p className="text-[12px] text-faint mt-1 max-w-[320px] leading-relaxed">
        Add a URL, or start a download in your browser with the Draco extension installed and it
        will land here.
      </p>
    </div>
  )
}
