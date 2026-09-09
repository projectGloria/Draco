import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ColumnId, DownloadTask, TaskStatus } from '@shared/types'
import { formatBytes, formatEta, formatPercent, formatSpeed, formatWhen, percent } from '../lib/format'
import { buildDisplayRows, type TaskGroup } from '@shared/groups'
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
  onGroupDetails,
  onDelete
}: {
  rows: DownloadTask[]
  onDetails(id: string): void
  /** Opens the group's properties window - the batch equivalent of a torrent's. */
  onGroupDetails(groupId: string): void
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
  const onGroupDetailsRef = useRef(onGroupDetails)
  const onDeleteRef = useRef(onDelete)
  rowsRef.current = rows
  selectionRef.current = selection
  queuesRef.current = queues
  onDetailsRef.current = onDetails
  onGroupDetailsRef.current = onGroupDetails
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
  const display = useMemo(() => buildDisplayRows(rows), [rows])
  const firstVisible = Math.max(0, Math.floor(Math.max(0, viewport.scrollTop - 32) / ROW_HEIGHT) - OVERSCAN_ROWS)
  const visibleCount = Math.ceil(viewport.height / ROW_HEIGHT) + OVERSCAN_ROWS * 2
  const lastVisible = Math.min(display.length, firstVisible + visibleCount)
  const visibleRows = display.slice(firstVisible, lastVisible)

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

  /**
   * Dragging a finished row out of Draco and onto another application - a chat
   * window, a folder, a mail composer.
   *
   * `preventDefault` is what hands the drag over: it cancels Chromium's own
   * HTML drag so the OS-level one main starts is the only drag in flight. Main
   * resolves the paths, so a row whose file has since moved simply produces no
   * drag rather than a drop of nothing.
   */
  const dragTask = useCallback((task: DownloadTask, event: React.DragEvent): void => {
    if (task.status !== 'done') return
    event.preventDefault()
    const selected = selectionRef.current
    window.api.startFileDrag(selected.includes(task.id) ? [...selected] : [task.id])
  }, [])

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

  /**
   * Selecting a group selects the files in it, so the ordinary commands - pause,
   * delete, move to queue - reach every one of them without the group needing
   * commands of its own. A modifier adds to or removes from the selection the
   * way it does for a single row.
   */
  const selectGroup = useCallback((group: TaskGroup, event: React.MouseEvent): void => {
    if (event.button === 2) return
    const ids = group.tasks.map((task) => task.id)
    const current = selectionRef.current
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      setSelection(ids.every((id) => current.includes(id))
        ? current.filter((id) => !ids.includes(id))
        : [...new Set([...current, ...ids])])
      return
    }
    setSelection(ids)
  }, [setSelection])

  /** What is inside a group is read in its properties window. */
  const openGroup = useCallback((group: TaskGroup): void => {
    onGroupDetailsRef.current(group.id)
  }, [])

  const groupMenu = useCallback((event: React.MouseEvent, group: TaskGroup): void => {
    event.preventDefault()
    const ids = group.tasks.map((task) => task.id)
    setSelection(ids)
    const running = group.tasks.some((task) => task.status === 'downloading' || task.status === 'queued')

    const items: MenuItem[] = [
      { label: `Properties… (${ids.length} files)`, onClick: () => onGroupDetailsRef.current(group.id) },
      {},
      {
        label: running ? `Stop ${ids.length} downloads` : `Resume ${ids.length} downloads`,
        onClick: () => {
          const call = running ? window.api.pauseTasks(ids) : window.api.startTasks(ids)
          void call.catch((err) => reportError('Command failed', err))
        }
      },
      {
        label: t('openFolder'),
        onClick: () => void window.api.revealFile(group.tasks[0].id)
          .catch((err) => reportError('Could not open the folder', err))
      },
      {}
    ]

    for (const queue of queuesRef.current) {
      items.push({
        label: t('moveToQueue') + ': ' + queue.name,
        checked: group.tasks.every((task) => task.queueId === queue.id),
        onClick: () => void patchQueue(ids, queue.id)
      })
    }
    if (queuesRef.current.length > 0) {
      items.push({
        label: t('noQueue'),
        disabled: group.tasks.every((task) => !task.queueId),
        onClick: () => void patchQueue(ids, null)
      })
      items.push({})
    }

    items.push({
      label: `Export ${ids.length} downloads…`,
      onClick: () => {
        void window.api
          .exportDownloads(ids)
          .then((count) => {
            if (count > 0) toast('success', `Exported ${count} download${count === 1 ? '' : 's'}`)
          })
          .catch((err) => reportError('Could not export', err))
      }
    })
    items.push({})
    items.push({ label: `Delete ${ids.length} downloads`, danger: true, onClick: () => onDeleteRef.current(ids) })

    setMenu({ at: { x: event.clientX, y: event.clientY }, items })
  }, [setSelection, t])

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

    // Only offered for a torrent that has finished, which is the only row that
    // can still be uploading. `stopSeeding` reports whether it actually was.
    if (task.kind === 'torrent' && task.status === 'done') {
      items.splice(2, 0, {
        label: 'Stop seeding',
        onClick: () => {
          void window.api
            .stopSeeding(ids)
            .then((stopped) => toast('info', stopped ? 'Seeding stopped' : 'Not seeding'))
            .catch((err) => reportError('Could not stop seeding', err))
        }
      })
    }

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

    // List-level, and put here because right-clicking the list is where a
    // person looks for what can be done to it. Export takes the selection;
    // import never starts what it adds.
    items.push({})
    items.push({
      label: ids.length > 1 ? `Export ${ids.length} downloads…` : 'Export this download…',
      onClick: () => {
        void window.api
          .exportDownloads(ids)
          .then((count) => {
            if (count > 0) toast('success', `Exported ${count} download${count === 1 ? '' : 's'}`)
          })
          .catch((err) => reportError('Could not export', err))
      }
    })
    items.push({
      label: 'Import list…',
      onClick: () => {
        void window.api
          .importDownloads()
          .then((count) => {
            if (count > 0) toast('success', `Imported ${count} download${count === 1 ? '' : 's'} — none started`)
          })
          .catch((err) => reportError('Could not import', err))
      }
    })
    items.push({})

    items.push({ label: 'Delete', danger: true, onClick: () => onDeleteRef.current(ids) })

    setMenu({ at: { x: event.clientX, y: event.clientY }, items })
  }, [setSelection, t])

  /* ---------------------------------------------------------------- */

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col">
      <div
        className="flex-1 min-h-0 overflow-auto"
        ref={body}
        onScroll={(event) => {
          // Read the element now, not inside the updater. React nulls
          // `currentTarget` once the handler returns, and a functional update is
          // free to run later - during the next render - by which time reaching
          // through the event throws and takes the whole table down with it.
          // A group expanding by forty-eight rows changes the scroll geometry in
          // one frame, which is exactly when that update gets deferred.
          const { scrollTop, clientHeight, clientWidth } = event.currentTarget
          setViewport((current) => ({
            scrollTop,
            height: current.height || clientHeight,
            width: current.width || clientWidth
          }))
        }}
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
            <div className="relative" style={{ height: display.length * ROW_HEIGHT }}>
              {visibleRows.map((row, offset) => row.kind === 'group' ? (
                <GroupRow
                  key={row.group.id}
                  group={row.group}
                  columns={columnIds}
                  template={template}
                  top={(firstVisible + offset) * ROW_HEIGHT}
                  selected={row.group.tasks.every((task) => selectedIds.has(task.id))}
                  queueLabel={row.group.summary.queueId ? queueLabels.get(row.group.summary.queueId) ?? '' : ''}
                  statusLabel={t(STATUS_KEYS[row.group.summary.status])}
                  onSelect={selectGroup}
                  onOpen={openGroup}
                  onMenu={groupMenu}
                />
              ) : (
                <Row
                  key={row.task.id}
                  task={row.task}
                  columns={columnIds}
                  template={template}
                  top={(firstVisible + offset) * ROW_HEIGHT}
                  selected={selectedIds.has(row.task.id)}
                  queueLabel={row.task.queueId ? queueLabels.get(row.task.queueId) ?? '' : ''}
                  statusLabel={t(STATUS_KEYS[row.task.status])}
                  onSelect={selectTask}
                  onDragStart={dragTask}
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

const GroupRow = memo(function GroupRow({
  group,
  columns,
  template,
  top,
  selected,
  queueLabel,
  statusLabel,
  onSelect,
  onOpen,
  onMenu
}: {
  group: TaskGroup
  columns: ColumnId[]
  template: string
  top: number
  selected: boolean
  queueLabel: string
  statusLabel: string
  onSelect(group: TaskGroup, event: React.MouseEvent): void
  onOpen(group: TaskGroup): void
  onMenu(event: React.MouseEvent, group: TaskGroup): void
}): React.ReactElement {
  return (
    <div
      className="absolute left-0 right-0 h-[30px] border-b border-line grid select-none cursor-pointer"
      style={{
        gridTemplateColumns: template,
        transform: `translateY(${top}px)`,
        background: selected ? 'var(--accent-soft)' : 'rgba(56, 189, 248, 0.07)',
        boxShadow: 'inset 2px 0 0 var(--accent)',
        borderTopColor: 'var(--accent-line)'
      }}
      onMouseDown={(event) => onSelect(group, event)}
      onDoubleClick={() => onOpen(group)}
      onContextMenu={(event) => onMenu(event, group)}
      title={`${group.name} — ${group.tasks.length} files
Double-click to see what is in it`}
    >
      {columns.map((id) => id === 'name' ? (
        <div key={id} className="px-2.5 text-[12px] truncate min-w-0 flex items-center gap-2">
          <SiteIcon
            url={group.summary.sourceUrl ?? group.summary.youtube?.pageUrl ?? group.summary.url}
            className="w-4 h-4 shrink-0"
          />
          <span className="truncate font-medium text-[var(--accent)]">{group.name}</span>
          <span className="shrink-0 tnum text-[11px] text-faint">{group.tasks.length} files</span>
        </div>
      ) : (
        <Cell
          key={id}
          id={id}
          task={group.summary}
          queueLabel={queueLabel}
          statusLabel={statusLabel}
        />
      ))}
      <div />
    </div>
  )
})

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
  selected,
  queueLabel,
  statusLabel,
  onSelect,
  onDragStart,
  onMouseEnter,
  onOpen,
  onMenu
}: {
  task: DownloadTask
  columns: ColumnId[]
  template: string
  top: number
  selected: boolean
  queueLabel: string
  statusLabel: string
  onSelect(task: DownloadTask, event: React.MouseEvent): void
  onDragStart(task: DownloadTask, event: React.DragEvent): void
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
        background: selected ? 'var(--accent-soft)' : undefined,
        boxShadow: selected ? 'inset 2px 0 0 var(--accent)' : undefined
      }}
      draggable={task.status === 'done'}
      onDragStart={(event) => onDragStart(task, event)}
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
  statusLabel
}: {
  id: ColumnId
  task: DownloadTask
  queueLabel: string
  statusLabel: string
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
          <span className="truncate">{task.filename}</span>
        </div>
      )

    case 'size':
      return <div className={base}>{formatBytes(task.size ?? task.expectedSize ?? null)}</div>

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
      {/* An empty list is exactly where someone arriving from another machine
          is standing, and the row menu that offers this is unreachable when
          there are no rows to right-click. */}
      <button
        type="button"
        className="mt-3 text-[11.5px] text-muted hover:text-ink underline underline-offset-2"
        onClick={() => {
          void window.api
            .importDownloads()
            .then((count) => {
              if (count > 0) toast('success', `Imported ${count} download${count === 1 ? '' : 's'} — none started`)
            })
            .catch((err) => reportError('Could not import', err))
        }}
      >
        Import a list of downloads
      </button>
    </div>
  )
}
