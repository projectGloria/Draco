import { useEffect, useState } from 'react'
import type { DownloadTask, Segment } from '@shared/types'
import { formatBytes, formatEta, formatSpeed, formatWhen, percent } from '../lib/format'
import { HISTORY_SAMPLES, speedHistory } from '../lib/history'
import { categoryName, useApp } from '../store/app'
import { reportError, toast } from '../store/toasts'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import ContextMenu, { type MenuPosition } from './ContextMenu'
import FileIcon from './FileIcon'
import ProgressBar, { barColor } from './ProgressBar'

type TorrentTab = 'general' | 'trackers' | 'peers' | 'sources' | 'content'

/**
 * IDM's signature screen: what every connection is doing right now.
 *
 * The segment list is the whole reason for the custom engine, so it gets shown
 * honestly - one bar per segment over its own byte range, live, including the
 * ones that were split off mid-flight from a connection that was falling behind.
 */

export default function TaskDetailDialog({
  id,
  onClose
}: {
  id: string
  onClose(): void
}): React.ReactElement | null {
  const task = useApp((s) => s.tasks.find((t) => t.id === id))
  const categories = useApp((s) => s.categories)
  const queues = useApp((s) => s.queues)

  const [filename, setFilename] = useState(task?.filename ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [queueId, setQueueId] = useState(task?.queueId ?? '')
  const [torrentTab, setTorrentTab] = useState<TorrentTab>('general')

  if (!task) return null

  const running = task.status === 'downloading' || task.status === 'queued'
  const dirty =
    filename !== task.filename || description !== task.description || (queueId || null) !== task.queueId

  async function save(): Promise<void> {
    try {
      await window.api.updateTask(id, {
        filename: filename.trim(),
        description,
        queueId: queueId || null
      })
      toast('success', 'Saved')
    } catch (err) {
      reportError('Could not save', err)
    }
  }

  return (
    <Dialog
      title={task.filename}
      subtitle={task.url}
      width={task.kind === 'torrent' ? 920 : 740}
      onClose={onClose}
      footer={
        <>
          <GhostButton
            onClick={() => {
              void window.api.copyToClipboard(task.url)
              toast('info', 'URL copied')
            }}
          >
            Copy URL
          </GhostButton>
          <GhostButton onClick={() => void window.api.revealFile(id)}>Open folder</GhostButton>
          <GhostButton
            onClick={() => {
              const call = running ? window.api.pauseTasks([id]) : window.api.startTasks([id])
              void call.catch((err) => reportError('Command failed', err))
            }}
            disabled={task.status === 'done'}
          >
            {running ? 'Stop' : 'Resume'}
          </GhostButton>
          <PrimaryButton onClick={() => void save()} disabled={!dirty}>
            Save
          </PrimaryButton>
        </>
      }
    >
      <Overview task={task} categoryLabel={categoryName(categories, task.categoryId)} />

      {task.kind === 'torrent' ? (
        <TorrentDetails task={task} tab={torrentTab} onTabChange={setTorrentTab} />
      ) : (
        <>
      <div className="mt-5">
        <SectionLabel>
          Connections
          <span className="text-faint font-normal normal-case tracking-normal ml-2">
            {task.segments.filter((s) => s.active).length} of {task.segments.length} active
            {' · '}
            {task.resumable ? 'server supports resume' : 'server does not support resume'}
          </span>
        </SectionLabel>

        {/* A playlist's pieces have no offset in the finished file until they
            are joined, so there is no map to draw for one. */}
        {task.kind === 'file' && task.size ? (
          <FileMap segments={task.segments} size={task.size} />
        ) : null}

        <div className="mt-3 space-y-1.5 max-h-[220px] overflow-y-auto pr-1">
          {task.segments.length === 0 ? (
            <p className="text-[12px] text-faint py-3">
              No connections yet — the download has not been started.
            </p>
          ) : (
            task.segments.map((segment, index) => (
              <SegmentRow
                key={index}
                index={index}
                segment={segment}
                status={task.status}
              />
            ))
          )}
        </div>
      </div>

      <div className="mt-5">
        <SectionLabel>Speed, last 60 seconds</SectionLabel>
        <Sparkline id={id} live={task.status === 'downloading'} />
      </div>
        </>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="label">File name</label>
          <input
            value={filename}
            onChange={(event) => setFilename(event.target.value)}
            spellCheck={false}
            className="field text-[12.5px]"
          />
        </div>
        <div>
          <label className="label">Queue</label>
          <select
            value={queueId}
            onChange={(event) => setQueueId(event.target.value)}
            className="field text-[12.5px]"
          >
            <option value="">None</option>
            {queues.map((queue) => (
              <option key={queue.id} value={queue.id}>
                {queue.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Description</label>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional"
            className="field text-[12.5px]"
          />
        </div>
      </div>

      {task.error && (
        <div className="mt-4 rounded-lg px-3 py-2.5 text-[11.5px] leading-relaxed border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.08)] text-err">
          {task.error}
        </div>
      )}
    </Dialog>
  )
}

function TorrentDetails({
  task,
  tab,
  onTabChange
}: {
  task: DownloadTask
  tab: TorrentTab
  onTabChange(tab: TorrentTab): void
}): React.ReactElement {
  const info = task.torrentInfo
  const tabs: Array<{ id: TorrentTab; label: string }> = [
    { id: 'general', label: 'General' },
    { id: 'trackers', label: `Trackers${info ? ` (${info.trackers.length})` : ''}` },
    { id: 'peers', label: `Peers${info ? ` (${info.peers.length})` : ''}` },
    { id: 'sources', label: `HTTP Sources${info ? ` (${info.sources.length})` : ''}` },
    { id: 'content', label: `Content${info ? ` (${info.files.length})` : ''}` }
  ]

  return (
    <div className="mt-5 border border-line rounded-lg overflow-hidden bg-white/[0.02]">
      <div className="flex items-center border-b border-line bg-white/[0.03] overflow-x-auto">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            onClick={() => onTabChange(entry.id)}
            className={
              'px-3.5 py-2.5 text-[11px] font-semibold whitespace-nowrap border-r border-line transition-colors ' +
              (tab === entry.id ? 'text-ink bg-white/[0.07]' : 'text-faint hover:text-ink hover:bg-white/[0.04]')
            }
            style={tab === entry.id ? { boxShadow: 'inset 0 -2px 0 var(--accent)' } : undefined}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="min-h-[245px] max-h-[330px] overflow-auto p-3">
        {!info ? (
          <div className="h-[220px] grid place-items-center text-[12px] text-faint">
            Torrent details will appear after metadata is received.
          </div>
        ) : tab === 'general' ? (
          <TorrentGeneral task={task} />
        ) : tab === 'trackers' ? (
          <SimpleTorrentList
            heading="Tracker URL"
            rows={info.trackers}
            empty="This torrent has no tracker URLs and is using peer discovery."
          />
        ) : tab === 'sources' ? (
          <SimpleTorrentList
            heading="HTTP source"
            rows={info.sources}
            empty="This torrent does not advertise HTTP web seeds."
          />
        ) : tab === 'peers' ? (
          <TorrentPeers task={task} />
        ) : (
          <TorrentContent task={task} />
        )}
      </div>
    </div>
  )
}

function TorrentGeneral({ task }: { task: DownloadTask }): React.ReactElement {
  const info = task.torrentInfo!
  return (
    <div className="grid grid-cols-3 gap-x-5 gap-y-4 text-[11.5px]">
      <Fact label="Info hash" value={info.infoHash} wide />
      <Fact label="Selected size" value={formatBytes(task.size)} />
      <Fact label="Downloaded" value={formatBytes(task.received)} />
      <Fact label="Uploaded" value={formatBytes(info.uploaded)} />
      <Fact label="Share ratio" value={info.ratio.toFixed(2)} />
      <Fact label="Connected peers" value={String(info.peers.length)} />
      <Fact label="Trackers" value={String(info.trackers.length)} />
      <Fact label="HTTP sources" value={String(info.sources.length)} />
    </div>
  )
}

function SimpleTorrentList({
  heading,
  rows,
  empty
}: {
  heading: string
  rows: string[]
  empty: string
}): React.ReactElement {
  if (rows.length === 0) return <div className="py-16 text-center text-[12px] text-faint">{empty}</div>
  return (
    <div className="text-[11.5px]">
      <div className="grid grid-cols-[minmax(0,1fr)_90px] px-2 pb-2 text-[10px] uppercase tracking-[0.4px] text-faint">
        <span>{heading}</span><span>Status</span>
      </div>
      {rows.map((row) => (
        <div key={row} className="grid grid-cols-[minmax(0,1fr)_90px] px-2 py-2 border-t border-line">
          <span className="truncate" title={row}>{row}</span>
          <span style={{ color: 'var(--color-ok)' }}>Active</span>
        </div>
      ))}
    </div>
  )
}

function TorrentPeers({ task }: { task: DownloadTask }): React.ReactElement {
  const peers = task.torrentInfo!.peers
  if (peers.length === 0) {
    return <div className="py-16 text-center text-[12px] text-faint">No peers are connected right now.</div>
  }
  return (
    <div className="text-[11px]">
      <div className="grid grid-cols-[160px_minmax(0,1fr)_90px_90px] px-2 pb-2 text-[10px] uppercase tracking-[0.4px] text-faint">
        <span>Address</span><span>Client / type</span><span className="text-right">Down</span><span className="text-right">Up</span>
      </div>
      {peers.map((peer, index) => (
        <div key={`${peer.address}-${index}`} className="grid grid-cols-[160px_minmax(0,1fr)_90px_90px] px-2 py-2 border-t border-line tnum">
          <span className="truncate" title={peer.address}>{peer.address}</span>
          <span className="truncate text-muted" title={peer.client}>{peer.client || peer.type}</span>
          <span className="text-right">{formatSpeed(peer.downloadSpeed) || '—'}</span>
          <span className="text-right">{formatSpeed(peer.uploadSpeed) || '—'}</span>
        </div>
      ))}
    </div>
  )
}

function TorrentContent({ task }: { task: DownloadTask }): React.ReactElement {
  const files = task.torrentInfo!.files
  const [menu, setMenu] = useState<{ at: MenuPosition; path: string } | null>(null)

  const openItem = async (path: string): Promise<void> => {
    try {
      if (!(await window.api.openTorrentItem(task.id, path))) {
        toast('info', 'That file is not available on disk yet')
      }
    } catch (error) {
      reportError('Could not open the torrent file', error)
    }
  }

  const revealItem = async (path: string): Promise<void> => {
    try {
      if (!(await window.api.revealTorrentItem(task.id, path))) {
        toast('info', 'That file is not available on disk yet')
      }
    } catch (error) {
      reportError('Could not show the torrent file', error)
    }
  }

  return (
    <div className="text-[11.5px]">
      <div className="grid grid-cols-[18px_minmax(0,1fr)_90px_160px] gap-2 px-2 pb-2 text-[10px] uppercase tracking-[0.4px] text-faint">
        <span /><span>Name</span><span className="text-right">Size</span><span className="text-right">Progress</span>
      </div>
      {files.map((file) => {
        const fileProgress = file.size ? Math.min(100, (file.downloaded / file.size) * 100) : 100
        const fileStatus = fileProgress >= 100
          ? 'done'
          : file.selected && task.status === 'downloading'
            ? 'downloading'
            : 'paused'
        return (
          <div
            key={file.path}
            className={'grid grid-cols-[18px_minmax(0,1fr)_90px_160px] items-center gap-2 px-2 py-2 border-t border-line cursor-default hover:bg-white/[0.035] ' + (file.selected ? '' : 'opacity-45')}
            onDoubleClick={() => void openItem(file.path)}
            onContextMenu={(event) => {
              event.preventDefault()
              setMenu({ at: { x: event.clientX, y: event.clientY }, path: file.path })
            }}
          >
            <FileIcon name={file.path} className="w-4 h-4" />
            <span className="truncate" title={file.path}>{file.path}</span>
            <span className="text-right tnum text-muted">{formatBytes(file.size)}</span>
            <div className="flex items-center gap-2 min-w-0">
              <ProgressBar percent={fileProgress} status={fileStatus} height={5} />
              <span className="w-[42px] shrink-0 text-right tnum">{fileProgress.toFixed(1)}%</span>
            </div>
          </div>
        )
      })}
      {menu && (
        <ContextMenu
          at={menu.at}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Open', onClick: () => void openItem(menu.path) },
            { label: 'Show in Explorer', onClick: () => void revealItem(menu.path) },
            {},
            {
              label: 'Copy relative path',
              onClick: () => void window.api.copyToClipboard(menu.path)
            }
          ]}
        />
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="text-[10.5px] font-semibold uppercase tracking-[0.5px] text-faint mb-2">
      {children}
    </div>
  )
}

function Overview({
  task,
  categoryLabel
}: {
  task: DownloadTask
  categoryLabel: string
}): React.ReactElement {
  const done = task.size ? percent(task.received, task.size) : null

  return (
    <div>
      <div className="flex items-end justify-between gap-4 mb-2">
        <div className="tnum text-[13px]">
          <span className="font-semibold">{formatBytes(task.received)}</span>
          <span className="text-faint"> of {formatBytes(task.size)}</span>
          {done !== null && <span className="text-faint"> · {done.toFixed(1)}%</span>}
        </div>
        <div className="tnum text-[12px] text-right">
          {task.status === 'downloading' && (
            <>
              <span style={{ color: 'var(--accent)' }} className="font-semibold">
                {formatSpeed(task.speed)}
              </span>
              {task.eta !== null && <span className="text-faint"> · {formatEta(task.eta)} left</span>}
            </>
          )}
        </div>
      </div>

      <ProgressBar percent={done} status={task.status} height={8} />

      <div className="mt-3 grid grid-cols-4 gap-3 text-[11.5px]">
        <Fact label="Status" value={task.status} />
        <Fact label="Connections" value={String(task.connections)} />
        <Fact label="Category" value={categoryLabel || '—'} />
        <Fact label="Added" value={formatWhen(task.createdAt)} />
        <Fact label="Saved in" value={task.dir} wide />
        <Fact label="Server" value={task.finalUrl || task.url} wide />
      </div>
    </div>
  )
}

function Fact({
  label,
  value,
  wide
}: {
  label: string
  value: string
  wide?: boolean
}): React.ReactElement {
  return (
    <div className={'min-w-0 ' + (wide ? 'col-span-2' : '')}>
      <div className="text-faint text-[10px] uppercase tracking-[0.4px]">{label}</div>
      <div className="truncate tnum" title={value}>
        {value}
      </div>
    </div>
  )
}

/**
 * The whole file as one strip, each segment drawn at its true offset and width.
 * This is what makes dynamic splitting visible: fast connections show up as
 * narrow blocks carved out of the tail of a slow one.
 */
function FileMap({ segments, size }: { segments: Segment[]; size: number }): React.ReactElement {
  return (
    <div className="relative w-full h-5 rounded-md overflow-hidden bg-white/[0.05] border border-line">
      {segments.map((segment) => {
        const end = segment.end < 0 ? size - 1 : segment.end
        const span = Math.max(1, end - segment.start + 1)
        const filled = Math.max(0, Math.min(span, segment.position - segment.start))

        return (
          <div
            key={segment.start}
            className="absolute inset-y-0 border-l border-black/40"
            style={{ left: (segment.start / size) * 100 + '%', width: (span / size) * 100 + '%' }}
            title={`${formatBytes(segment.start)} → ${formatBytes(end)}`}
          >
            <div
              className="h-full transition-[width] duration-200"
              style={{
                width: (filled / span) * 100 + '%',
                background: segment.active ? 'var(--grad)' : 'rgba(255,255,255,0.22)'
              }}
            />
          </div>
        )
      })}
    </div>
  )
}

function SegmentRow({
  index,
  segment,
  status
}: {
  index: number
  segment: Segment
  status: DownloadTask['status']
}): React.ReactElement {
  const end = segment.end
  const span = end < 0 ? null : end - segment.start + 1
  const written = segment.position - segment.start
  const pct = span ? Math.min(100, (written / span) * 100) : null

  return (
    <div className="flex items-center gap-2.5 text-[11px]">
      <span
        className={'w-1.5 h-1.5 rounded-full shrink-0 ' + (segment.active ? 'animate-pulse' : '')}
        style={{ background: segment.active ? barColor(status) : 'var(--color-faint)' }}
      />
      <span className="tnum text-faint w-5 shrink-0">{index + 1}</span>

      <span className="flex-1 min-w-0">
        <ProgressBar percent={pct} status={segment.active ? status : 'paused'} height={5} />
      </span>

      <span
        className="tnum text-faint w-[150px] text-right shrink-0"
        title={end < 0 ? 'This connection is fetching a playlist piece' : 'Byte range'}
      >
        {end < 0 ? 'streaming' : `${formatBytes(segment.start)} – ${formatBytes(end)}`}
      </span>
      <span className="tnum w-[74px] text-right shrink-0">{formatBytes(written)}</span>
    </div>
  )
}

/**
 * Speed over the last minute. Redrawn on its own timer from a plain array kept
 * outside React state - the point of the chart is not to re-render the app 240
 * times a minute.
 */
function Sparkline({ id, live }: { id: string; live: boolean }): React.ReactElement {
  const [samples, setSamples] = useState<number[]>(() => speedHistory(id))

  useEffect(() => {
    setSamples(speedHistory(id))
    if (!live) return

    const timer = setInterval(() => setSamples(speedHistory(id)), 500)
    return () => clearInterval(timer)
  }, [id, live])

  const width = 100
  const height = 34
  const peak = Math.max(1, ...samples)

  // Anchored to the right edge so a fresh download grows into the chart rather
  // than stretching two samples across the whole width.
  const offset = HISTORY_SAMPLES - samples.length
  const points = samples
    .map((value, index) => {
      const x = ((offset + index) / (HISTORY_SAMPLES - 1)) * width
      const y = height - (value / peak) * (height - 2) - 1
      return x.toFixed(2) + ',' + y.toFixed(2)
    })
    .join(' ')

  return (
    <div className="relative rounded-lg border border-line bg-white/[0.02] px-2 pt-2 pb-1">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full h-[46px]">
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {samples.length > 1 && (
          <>
            <polygon
              points={`${points} ${width},${height} ${((offset / (HISTORY_SAMPLES - 1)) * width).toFixed(2)},${height}`}
              fill="url(#sparkFill)"
            />
            <polyline
              points={points}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </>
        )}
      </svg>
      <div className="flex justify-between text-[10px] text-faint tnum">
        <span>60s ago</span>
        <span>peak {formatSpeed(peak)}</span>
        <span>now</span>
      </div>
    </div>
  )
}
