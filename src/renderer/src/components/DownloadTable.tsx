import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ColumnId, DownloadTask, TaskStatus } from '@shared/types'
import { formatBytes, formatEta, formatPercent, formatSpeed, formatWhen, percent } from '../lib/format'
import { useApp } from '../store/app'
import { useT, type TKey } from '../i18n'
import { reportError, toast } from '../store/toasts'
import ContextMenu, { type MenuItem, type MenuPosition } from './ContextMenu'
import FileIcon, { SiteIcon } from './FileIcon'
import { DownloadIcon, SortArrow, TorrentIcon } from './Icons'
import ProgressBar from './ProgressBar'

/**
 * Column headings and status names, by translation key rather than by literal.
 *
 * The main window is the surface a language setting is actually judged on, so
 * these are the strings that have to move with it - the table is most of what
 * is on screen most of the time.
 */
const HEADING_KEYS: Record<ColumnId, TKey> = {
  name: 'colName',
  size: 'colSize',
  progress: 'colProgress',
  status: 'colStatus',
  eta: 'colEta',
  speed: 'colSpeed',
  queue: 'colQueue',
  added: 'colAdded',
  description: 'colDescription'
}

/** Numeric columns are right-aligned so their digits line up down the column. */
const RIGHT: ReadonlySet<ColumnId> = new Set<ColumnId>(['size', 'eta', 'speed'])
const ROW_HEIGHT = 30
const OVERSCAN_ROWS = 8

const STATUS_KEYS: Record<TaskStatus, TKey> = {
  queued: 'statusQueued',
  probing: 'statusProbing',
  downloading: 'statusDownloading',
  paused: 'statusPaused',
  done: 'statusDone',
  error: 'statusError',
  missing: 'statusMissing'
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
  const t = useT()
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
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0, width: 0 })
  const body = useRef<HTMLDivElement>(null)
  const rowsRef = useRef(rows)
  const selectionRef = useRef(selection)
  const queuesRef = useRef(queues)
  const onDetailsRef = useRef(onDetails)
  const onDeleteRef = useRef(onDelete)
  rowsRef.current = rows
  selectionRef.current = selection
  queuesRef.current = queues
  onDetailsRef.current = onDetails
  onDeleteRef.current = onDelete

  const columns = useMemo(() => {
    const width = viewport.width
    let visible = settings.columns.filter((column) => column.visible)
    if (width > 0 && width < 900) visible = visible.filter((column) => column.id !== 'added' && column.id !== 'description')
    if (width > 0 && width < 760) visible = visible.filter((column) => !['eta', 'speed', 'queue'].includes(column.id))
    if (width > 0 && width < 620) visible = visible.filter((column) => column.id !== 'size')
    if (width > 0 && width < 500) visible = visible.filter((column) => column.id !== 'status')
    const fixed = visible.reduce((sum, column) => sum + (column.id === 'name' ? 0 : column.width), 0)
    return visible.map((column) => column.id === 'name' && width > 0
      ? { ...column, width: Math.max(180, Math.min(column.width, width - fixed - 2)) }
      : column)
  }, [settings.columns, viewport.width])
  const columnIds = useMemo(() => columns.map((column) => column.id), [columns])
  const template = columns.map((c) => c.width + 'px').join(' ') + ' 1fr'
  const minWidth = columns.reduce((sum, c) => sum + c.width, 0)
  const selectedIds = useMemo(() => new Set(selection), [selection])
  const queueLabels = useMemo(
    () => new Map(queues.map((queue) => [queue.id, queue.name])),
    [queues]
  )
  const firstVisible = Math.max(0, Math.floor(Math.max(0, viewport.scrollTop - 32) / ROW_HEIGHT) - OVERSCAN_ROWS)
  const visibleCount = Math.ceil(viewport.height / ROW_HEIGHT) + OVERSCAN_ROWS * 2
  const lastVisible = Math.min(rows.length, firstVisible + visibleCount)
  const visibleRows = rows.slice(firstVisible, lastVisible)

  useEffect(() => {
    const element = body.current
    if (!element) return
    const update = (): void => setViewport((current) => ({
      scrollTop: element.scrollTop,
      height: element.clientHeight || current.height,
      width: element.clientWidth || current.width
    }))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

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
        label: t(HEADING_KEYS[column.id]),
        checked: column.visible,
        // The name column is what identifies a row; hiding it would leave a
        // table of numbers with nothing to attach them to.
        disabled: column.id === 'name',
        onClick: () => toggleColumn(column.id)
      }))
    })
  }

  const selectTask = useCallback((task: DownloadTask, event: React.MouseEvent): void => {
    if (event.button === 2) return
    clickRow(
      task.id,
      { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey },
      rowsRef.current
    )
  }, [clickRow])

  const hoverRow = useCallback((task: DownloadTask, event: React.MouseEvent): void => {
    // Buttons === 1 means primary button is held down
    if (event.buttons === 1) {
      if (!selectionRef.current.includes(task.id)) {
        clickRow(task.id, { ctrl: true, shift: false }, rowsRef.current)
      }
    }
  }, [clickRow])

  const openTask = useCallback((task: DownloadTask): void => {
    if (task.status === 'done') {
      void window.api.openFile(task.id).catch((err) => reportError('Could not open the file', err))
    } else {
      onDetailsRef.current(task.id)
    }
  }, [])

  const rowMenu = useCallback((event: React.MouseEvent, task: DownloadTask): void => {
    event.preventDefault()
    const currentSelection = selectionRef.current
    const currentRows = rowsRef.current
    const currentQueues = queuesRef.current

    // Right-clicking outside the selection moves it, the way Explorer does.
    const ids = currentSelection.includes(task.id) ? currentSelection : [task.id]
    if (!currentSelection.includes(task.id)) setSelection([task.id])

    const running = ids.some((id) => {
      const row = currentRows.find((r) => r.id === id)
      return row?.status === 'downloading' || row?.status === 'queued'
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
      { label: t('redownload'), onClick: () => void window.api.redownload(task.id).catch((err) => reportError('Redownload failed', err)) },
      {},
      {
        label: t('open'),
        disabled: task.status !== 'done',
        onClick: () => void window.api.openFile(task.id).catch((err) => reportError('Could not open the file', err))
      },
      {
        label: t('openFolder'),
        onClick: () => void window.api.revealFile(task.id).catch((err) => reportError('Could not open the folder', err))
      },
      {
        label: t('copyUrl'),
        onClick: () => {
          void window.api.copyToClipboard(task.url)
          toast('info', 'URL copied')
        }
      },
      { label: 'Properties…', onClick: () => onDetailsRef.current(task.id) },
      {}
    ]

    for (const queue of currentQueues) {
      items.push({
        label: t('moveToQueue') + ': ' + queue.name,
        checked: ids.every((id) => currentRows.find((r) => r.id === id)?.queueId === queue.id),
        onClick: () => void patchQueue(ids, queue.id)
      })
    }
    if (currentQueues.length > 0) {
      items.push({
        label: t('noQueue'),
        disabled: ids.every((id) => !currentRows.find((r) => r.id === id)?.queueId),
        onClick: () => void patchQueue(ids, null)
      })
      items.push({})
    }

    items.push({ label: 'Delete', danger: true, onClick: () => onDeleteRef.current(ids) })

    setMenu({ at: { x: event.clientX, y: event.clientY }, items })
  }, [setSelection, t])

  /* ---------------------------------------------------------------- */

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      <div
        className="flex-1 min-h-0 overflow-auto"
        ref={body}
        onScroll={(event) => setViewport((current) => ({
          scrollTop: event.currentTarget.scrollTop,
          height: current.height || event.currentTarget.clientHeight,
          width: current.width || event.currentTarget.clientWidth
        }))}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setSelection([])
          }
        }}
      >
        <div style={{ minWidth }} onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            setSelection([])
          }
        }}>
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
                  title={t('sortBy', { column: t(HEADING_KEYS[column.id]) })}
                >
                  <span className="truncate">{t(HEADING_KEYS[column.id])}</span>
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
            <div className="relative" style={{ height: rows.length * ROW_HEIGHT }}>
              {visibleRows.map((task, offset) => (
                <Row
                  key={task.id}
                  task={task}
                  columns={columnIds}
                  template={template}
                  top={(firstVisible + offset) * ROW_HEIGHT}
                  groupFirst={Boolean(task.groupId && rows[firstVisible + offset - 1]?.groupId !== task.groupId)}
                  groupLast={Boolean(task.groupId && rows[firstVisible + offset + 1]?.groupId !== task.groupId)}
                  selected={selectedIds.has(task.id)}
                  queueLabel={task.queueId ? queueLabels.get(task.queueId) ?? '' : ''}
                  statusLabel={t(STATUS_KEYS[task.status])}
                  onSelect={selectTask}
                  onMouseEnter={hoverRow}
                  onOpen={openTask}
                  onMenu={rowMenu}
                />
              ))}
            </div>
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
  top,
  groupFirst,
  groupLast,
  selected,
  queueLabel,
  statusLabel,
  onSelect,
  onMouseEnter,
  onOpen,
  onMenu
}: {
  task: DownloadTask
  columns: ColumnId[]
  template: string
  top: number
  groupFirst: boolean
  groupLast: boolean
  selected: boolean
  queueLabel: string
  statusLabel: string
  onSelect(task: DownloadTask, event: React.MouseEvent): void
  onMouseEnter(task: DownloadTask, event: React.MouseEvent): void
  onOpen(task: DownloadTask): void
  onMenu(event: React.MouseEvent, task: DownloadTask): void
}): React.ReactElement {
  return (
    <div
      className="absolute left-0 right-0 h-[30px] border-b border-line grid select-none"
      style={{
        gridTemplateColumns: template,
        transform: `translateY(${top}px)`,
        background: selected ? 'var(--accent-soft)' : task.groupId ? 'rgba(56, 189, 248, 0.035)' : undefined,
        boxShadow: task.groupId || selected ? 'inset 2px 0 0 var(--accent)' : undefined,
        borderTopColor: groupFirst ? 'var(--accent-line)' : undefined,
        borderBottomColor: groupLast ? 'var(--accent-line)' : undefined
      }}
      onMouseDown={(event) => onSelect(task, event)}
      onMouseEnter={(event) => onMouseEnter(task, event)}
      onDoubleClick={() => onOpen(task)}
      onContextMenu={(event) => onMenu(event, task)}
    >
      {columns.map((id) => (
        <Cell
          key={id}
          id={id}
          task={task}
          queueLabel={queueLabel}
          statusLabel={statusLabel}
          groupFirst={groupFirst}
        />
      ))}
      <div />
    </div>
  )
})

function Cell({
  id,
  task,
  queueLabel,
  statusLabel,
  groupFirst
}: {
  id: ColumnId
  task: DownloadTask
  queueLabel: string
  statusLabel: string
  groupFirst: boolean
}): React.ReactElement {
  const base =
    'px-2.5 text-[12px] truncate min-w-0 flex items-center ' +
    (RIGHT.has(id) ? 'justify-end text-right tnum ' : '')

  switch (id) {
    case 'name':
      return (
        <div className={base + ' flex items-center gap-2'} title={task.filename + '\n' + task.url}>
          <span className="shrink-0 flex items-center gap-1.5">
            {task.kind === 'torrent' ? (
              <span className="text-[var(--accent)]" title="Torrent source">
                <TorrentIcon className="w-4 h-4" />
              </span>
            ) : (
              <SiteIcon url={task.sourceUrl ?? task.youtube?.pageUrl ?? task.url} className="w-4 h-4" />
            )}
            <FileIcon
              name={task.kind === 'torrent' ? representativeTorrentFile(task) : task.filename}
              className="w-4 h-4"
            />
          </span>
          <span className="truncate">
            {task.groupId && (
              <span className="text-[var(--accent)] font-medium">
                {groupFirst ? `${task.groupName || 'Page downloads'} / ` : '↳ '}
              </span>
            )}
            {task.filename}
          </span>
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
          title={task.error ?? task.detail ?? statusLabel}
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
                (task.detail ?? statusLabel)}
            {task.isCatMode ? ' 🎭' : ''}
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

function representativeTorrentFile(task: DownloadTask): string {
  const selected = task.selectedFiles ? new Set(task.selectedFiles) : null
  const files = task.torrentInfo?.files ?? task.torrentFiles ?? []
  const largest = files
    .filter((file) => !selected || selected.has(file.path))
    .reduce<(typeof files)[number] | undefined>(
      (current, file) => !current || file.size > current.size ? file : current,
      undefined
    )
  return largest?.path ?? task.selectedFiles?.find((path) => /\.[a-z0-9]{1,10}$/i.test(path)) ?? task.filename
}

function EmptyState(): React.ReactElement {
  const t = useT()
  return (
    <div className="py-20 grid place-items-center text-center fade-up">
      <div
        className="w-12 h-12 rounded-2xl grid place-items-center mb-3"
        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
      >
        <DownloadIcon className="w-6 h-6" />
      </div>
      <p className="text-[13px] font-semibold">{t('noDownloads')}</p>
      <p className="text-[12px] text-faint mt-1 max-w-[320px] leading-relaxed">{t('noDownloadsHint')}</p>
    </div>
  )
}
