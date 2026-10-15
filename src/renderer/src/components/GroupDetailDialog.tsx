import { useMemo, useState } from 'react'
import type { DownloadTask } from '@shared/types'
import { displaySource } from '@shared/display-source'
import { useT } from '../i18n'
import { formatBytes, formatEta, formatSpeed, formatWhen, percent } from '../lib/format'
import { summarizeGroup } from '@shared/groups'
import { canPauseTask } from '@shared/task-status'
import { useApp } from '../store/app'
import { reportError, toast } from '../store/toasts'
import ContextMenu, { type MenuItem, type MenuPosition } from './ContextMenu'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import FileIcon from './FileIcon'
import { AlertIcon, GlobeIcon, ListIcon } from './Icons'
import ProgressBar from './ProgressBar'

/**
 * What a torrent's properties window is for a swarm, this is for a group: the
 * one thing the user asked for, opened up.
 *
 * A group has no swarm, so there are no peers or trackers to show. What it does
 * have that a single download does not is a roster - forty-nine files, each
 * with its own progress and its own way of failing - so the contents come
 * first, and the rest of the tabs answer the two questions a batch actually
 * raises: where is all this coming from, and what did not make it.
 */

type GroupTab = 'content' | 'hosts' | 'errors'

export default function GroupDetailDialog({
  groupId,
  onClose
}: {
  groupId: string
  onClose(): void
}): React.ReactElement | null {
  const t = useT()
  const tasks = useApp((state) => state.tasks)
  const members = useMemo(() => tasks.filter((task) => task.groupId === groupId), [tasks, groupId])
  const [tab, setTab] = useState<GroupTab>('content')

  const failed = members.filter((task) => task.status === 'error')
  const summary = useMemo(
    () => (members.length > 0 ? summarizeGroup(groupId, members) : null),
    [groupId, members]
  )
  if (!summary) return null

  const ids = members.map((task) => task.id)
  const running = members.some((task) => canPauseTask(task.status))
  const done = summary.size ? percent(summary.received, summary.size) : null
  const sourceUrl = members.find((task) => task.sourceUrl)?.sourceUrl ?? summary.url

  const tabs: Array<{ id: GroupTab; label: string; icon: React.ReactElement }> = [
    { id: 'content', label: `Content (${members.length})`, icon: <ListIcon className="w-3.5 h-3.5" /> },
    {
      id: 'hosts',
      label: `Sources (${new Set(members.map(hostOf)).size})`,
      icon: <GlobeIcon className="w-3.5 h-3.5" />
    },
    { id: 'errors', label: `Errors (${failed.length})`, icon: <AlertIcon className="w-3.5 h-3.5" /> }
  ]

  return (
    <Dialog
      title={summary.groupName || t('pageDownloads')}
      subtitle={sourceUrl}
      width={920}
      onClose={onClose}
      autoFocus={false}
      footer={
        <>
          <GhostButton
            onClick={() => {
              void window.api.copyToClipboard(sourceUrl)
              toast('info', t('sourceUrlCopied'))
            }}
          >
            {t('copySourceUrl')}
          </GhostButton>
          <GhostButton onClick={() => void window.api.revealFile(ids[0])}>{t('openFolder')}</GhostButton>
          <GhostButton
            onClick={() => {
              const call = running ? window.api.pauseTasks(ids) : window.api.startTasks(ids)
              void call.catch((err) => reportError(t('commandFailed'), err))
            }}
            disabled={members.every((task) => task.status === 'done')}
          >
            {running ? t('stopCount', { count: ids.length }) : t('resumeCount', { count: ids.length })}
          </GhostButton>
          <PrimaryButton onClick={onClose}>{t('close')}</PrimaryButton>
        </>
      }
    >
      <div>
        <div className="flex items-end justify-between gap-4 mb-2">
          <div className="tnum text-[13px]">
            <span className="font-semibold">{formatBytes(summary.received)}</span>
            <span className="text-faint"> of {formatBytes(summary.size)}</span>
            {done !== null && <span className="text-faint"> · {done.toFixed(1)}%</span>}
          </div>
          <div className="tnum text-[12px] text-right">
            {summary.speed > 0 && (
              <>
                <span style={{ color: 'var(--accent)' }} className="font-semibold">
                  {formatSpeed(summary.speed)}
                </span>
                {summary.eta !== null && <span className="text-faint"> · {formatEta(summary.eta)} left</span>}
              </>
            )}
          </div>
        </div>

        <ProgressBar percent={done} status={summary.status} height={8} />

        <div className="mt-3 grid grid-cols-4 gap-3 text-[11.5px]">
          <Fact label="Files" value={`${members.filter((t) => t.status === 'done').length} of ${members.length} done`} />
          <Fact label="Formats" value={formatBreakdown(members)} />
          <Fact label="Status" value={statusBreakdown(members)} />
          <Fact label="Added" value={formatWhen(summary.createdAt)} />
          <Fact label="Saved in" value={summary.dir} wide />
          <Fact label="Source page" value={sourceUrl} wide />
        </div>
      </div>

      <div className="mt-5 border border-line rounded-lg overflow-hidden bg-white/[0.02]">
        <div className="flex items-center border-b border-line bg-white/[0.03] overflow-x-auto">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setTab(entry.id)}
              className={
                'flex items-center gap-1.5 px-3.5 py-2.5 text-[11px] font-semibold whitespace-nowrap border-r border-line transition-colors ' +
                (tab === entry.id ? 'text-ink bg-white/[0.07]' : 'text-faint hover:text-ink hover:bg-white/[0.04]')
              }
              style={tab === entry.id ? { boxShadow: 'inset 0 -2px 0 var(--accent)' } : undefined}
            >
              <span
                className="shrink-0"
                style={
                  entry.id === 'errors' && failed.length > 0
                    ? { color: 'var(--color-err)' }
                    : tab === entry.id
                      ? { color: 'var(--accent)' }
                      : undefined
                }
              >
                {entry.icon}
              </span>
              {entry.label}
            </button>
          ))}
        </div>

        <div className="min-h-[245px] max-h-[330px] overflow-auto p-3">
          {tab === 'content' ? (
            <GroupContent members={members} />
          ) : tab === 'hosts' ? (
            <GroupHosts members={members} />
          ) : (
            <GroupErrors members={failed} />
          )}
        </div>
      </div>
    </Dialog>
  )
}

function GroupContent({ members }: { members: DownloadTask[] }): React.ReactElement {
  const t = useT()
  const [menu, setMenu] = useState<{ at: MenuPosition; task: DownloadTask } | null>(null)
  const [active, setActive] = useState<string | null>(null)

  const open = (task: DownloadTask): void => {
    if (task.status !== 'done') {
      toast('info', t('notFinishedYet'))
      return
    }
    void window.api.openFile(task.id).catch((error) => reportError('Could not open the file', error))
  }

  const items = (task: DownloadTask): MenuItem[] => {
    const running = canPauseTask(task.status)
    return [
      { label: t('open'), disabled: task.status !== 'done', onClick: () => open(task) },
      { label: t('openFolder'), onClick: () => void window.api.revealFile(task.id) },
      {},
      {
        label: running ? t('stop') : t('resume'),
        disabled: task.status === 'done',
        onClick: () => {
          const call = running ? window.api.pauseTasks([task.id]) : window.api.startTasks([task.id])
          void call.catch((error) => reportError(t('commandFailed'), error))
        }
      },
      {
        label: t('copyUrl'),
        onClick: () => {
          void window.api.copyToClipboard(task.url)
          toast('info', t('urlCopied'))
        }
      },
      {},
      {
        label: t('removeFromGroup'),
        danger: true,
        // Detach the row from the batch without touching the download itself;
        // removeTasks would have deleted it from the list entirely.
        onClick: () => void window.api
          .updateTask(task.id, { groupId: null })
          .catch((error) => reportError(t('removeFromFileFailed'), error))
      }
    ]
  }

  return (
    <div className="text-[11.5px]">
      <div className="grid grid-cols-[minmax(0,1fr)_90px_150px_110px] items-center gap-2 px-2 pb-2 text-[10px] uppercase tracking-[0.4px] text-faint">
        <span>File</span>
        <span className="text-right">Size</span>
        <span>Progress</span>
        <span>Status</span>
      </div>
      {members.map((task) => (
        <div
          key={task.id}
          className={
            'grid grid-cols-[minmax(0,1fr)_90px_150px_110px] items-center gap-2 px-2 py-2 border-t border-line cursor-pointer ' +
            (active === task.id ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]')
          }
          onMouseDown={() => setActive(task.id)}
          onDoubleClick={() => open(task)}
          onContextMenu={(event) => {
            event.preventDefault()
            setActive(task.id)
            setMenu({ at: { x: event.clientX, y: event.clientY }, task })
          }}
        >
          <span className="flex items-center gap-2 min-w-0">
            <FileIcon name={task.filename} className="w-4 h-4 shrink-0" />
            <span className="truncate" title={task.filename + '\n' + displaySource(task.url)}>{task.filename}</span>
          </span>
          <span className="text-right tnum text-faint">{formatBytes(task.size ?? task.expectedSize ?? null)}</span>
          <span className="flex items-center gap-2">
            <ProgressBar
              percent={task.size ? percent(task.received, task.size) : task.status === 'done' ? 100 : null}
              status={task.status}
            />
          </span>
          <span
            className="truncate tnum"
            style={{ color: task.status === 'error' ? 'var(--color-err)' : undefined }}
            title={task.error ?? task.detail ?? task.status}
          >
            {task.status === 'downloading' && task.speed > 0 ? formatSpeed(task.speed) : task.status}
          </span>
        </div>
      ))}
      {menu && (
        <ContextMenu at={menu.at} items={items(menu.task)} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

/**
 * Where the bytes come from. An album's files are usually spread over a couple
 * of CDN hosts, and when one of them is the one failing, this is the tab that
 * says so.
 */
function GroupHosts({ members }: { members: DownloadTask[] }): React.ReactElement {
  const hosts = new Map<string, { files: number; bytes: number; failed: number }>()
  for (const task of members) {
    const host = hostOf(task)
    const entry = hosts.get(host) ?? { files: 0, bytes: 0, failed: 0 }
    entry.files += 1
    entry.bytes += task.size ?? task.expectedSize ?? 0
    if (task.status === 'error') entry.failed += 1
    hosts.set(host, entry)
  }

  return (
    <div className="text-[11.5px]">
      <div className="grid grid-cols-[minmax(0,1fr)_80px_110px_90px] px-2 pb-2 text-[10px] uppercase tracking-[0.4px] text-faint">
        <span>Host</span>
        <span className="text-right">Files</span>
        <span className="text-right">Size</span>
        <span className="text-right">Failed</span>
      </div>
      {[...hosts.entries()]
        .sort((a, b) => b[1].files - a[1].files)
        .map(([host, entry]) => (
          <div key={host} className="grid grid-cols-[minmax(0,1fr)_80px_110px_90px] px-2 py-2 border-t border-line tnum">
            <span className="truncate" title={host}>{host}</span>
            <span className="text-right">{entry.files}</span>
            <span className="text-right text-faint">{formatBytes(entry.bytes)}</span>
            <span className="text-right" style={{ color: entry.failed > 0 ? 'var(--color-err)' : undefined }}>
              {entry.failed || '—'}
            </span>
          </div>
        ))}
    </div>
  )
}

function GroupErrors({ members }: { members: DownloadTask[] }): React.ReactElement {
  if (members.length === 0) {
    return <div className="py-16 text-center text-[12px] text-faint">Nothing in this group has failed.</div>
  }
  return (
    <div className="text-[11.5px]">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_80px] items-center gap-2 px-2 pb-2 text-[10px] uppercase tracking-[0.4px] text-faint">
        <span>File</span>
        <span>Reason</span>
        <span className="text-right">Retry</span>
      </div>
      {members.map((task) => (
        <div key={task.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_80px] items-center gap-2 px-2 py-2 border-t border-line">
          <span className="truncate" title={task.filename}>{task.filename}</span>
          <span className="truncate text-err" title={task.error ?? ''}>{task.error ?? 'Unknown error'}</span>
          <button
            className="text-right text-faint hover:text-ink transition-colors"
            onClick={() => void window.api.startTasks([task.id]).catch((error) => reportError('Retry failed', error))}
          >
            Retry
          </button>
        </div>
      ))}
    </div>
  )
}

function Fact({ label, value, wide }: { label: string; value: string; wide?: boolean }): React.ReactElement {
  return (
    <div className={'min-w-0 ' + (wide ? 'col-span-2' : '')}>
      <div className="text-faint text-[10px] uppercase tracking-[0.4px]">{label}</div>
      <div className="truncate tnum" title={value}>{value}</div>
    </div>
  )
}

function hostOf(task: DownloadTask): string {
  try {
    return new URL(task.finalUrl || task.url).hostname
  } catch {
    return 'unknown'
  }
}

/** "48 FLAC · 1 JPG" - what the group is actually made of. */
function formatBreakdown(members: DownloadTask[]): string {
  const counts = new Map<string, number>()
  for (const task of members) {
    const extension = /\.([a-z0-9]{1,6})$/i.exec(task.filename)?.[1]?.toUpperCase() ?? '—'
    counts.set(extension, (counts.get(extension) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([extension, count]) => `${count} ${extension}`)
    .join(' · ')
}

function statusBreakdown(members: DownloadTask[]): string {
  const counts = new Map<string, number>()
  for (const task of members) counts.set(task.status, (counts.get(task.status) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${count} ${status}`)
    .join(' · ')
}
