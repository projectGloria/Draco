import { useState } from 'react'
import type { DownloadTask } from '@shared/types'
import { useApp } from '../store/app'
import { reportError } from '../store/toasts'
import { useT } from '../i18n'
import {
  CalendarIcon,
  CheckIcon,
  ChevronIcon,
  DownloadIcon,
  FolderIcon,
  LayersIcon,
  ListIcon,
  PlayIcon,
  StopAllIcon
} from './Icons'

/**
 * IDM's tree, with the counts it never showed you. Categories come from the
 * user's own list, so this is built from state rather than hard-coded.
 */

export default function Sidebar({
  onEditQueues
}: {
  onEditQueues(): void
}): React.ReactElement {
  const tasks = useApp((s) => s.tasks)
  const categories = useApp((s) => s.categories)
  const queues = useApp((s) => s.queues)
  const sidebar = useApp((s) => s.sidebar)
  const setSidebar = useApp((s) => s.setSidebar)
  const t = useT()

  const total = useApp((s) => s.tasks.length)
  const unfinished = useApp((s) => s.tasks.filter((t) => t.status !== 'done').length)
  const finished = total - unfinished

  const [openCategories, setOpenCategories] = useState(true)
  const [openQueues, setOpenQueues] = useState(true)

  return (
    <nav className="w-[204px] shrink-0 border-r border-line bg-white/[0.012] overflow-y-auto py-2 px-2 flex flex-col gap-0.5">
      <Item
        icon={<ListIcon className="w-[15px] h-[15px]" />}
        label={t('allDownloads')}
        count={total}
        active={sidebar === 'all'}
        onClick={() => setSidebar('all')}
      />
      <Item
        icon={<DownloadIcon className="w-[15px] h-[15px]" />}
        label={t('unfinished')}
        count={unfinished}
        active={sidebar === 'unfinished'}
        onClick={() => setSidebar('unfinished')}
      />
      <Item
        icon={<CheckIcon className="w-[15px] h-[15px]" />}
        label={t('finished')}
        count={finished}
        active={sidebar === 'finished'}
        onClick={() => setSidebar('finished')}
      />

      <Section
        label={t('categories')}
        open={openCategories}
        onToggle={() => setOpenCategories((v) => !v)}
      />
      {openCategories &&
        categories.map((category) => (
          <Item
            key={category.id}
            indent
            icon={<FolderIcon className="w-[15px] h-[15px]" />}
            label={category.name}
            count={countBy(tasks, (t) => t.categoryId === category.id)}
            active={sidebar === 'cat:' + category.id}
            onClick={() => setSidebar('cat:' + category.id)}
          />
        ))}

      <Section label={t('queues')} open={openQueues} onToggle={() => setOpenQueues((v) => !v)}>
        <button
          onClick={onEditQueues}
          title={t('manageQueues')}
          className="w-5 h-5 rounded grid place-items-center text-faint hover:text-ink hover:bg-white/[0.07]"
        >
          <CalendarIcon className="w-3.5 h-3.5" />
        </button>
      </Section>
      {openQueues &&
        queues.map((queue) => (
          <QueueItem
            key={queue.id}
            id={queue.id}
            name={queue.name}
            running={queue.running}
            count={countBy(tasks, (t) => t.queueId === queue.id)}
            active={sidebar === 'queue:' + queue.id}
            onClick={() => setSidebar('queue:' + queue.id)}
            stopLabel={t('stopQueue')}
            startLabel={t('startQueue')}
            errorLabel={t('queueFailed')}
          />
        ))}
    </nav>
  )
}

function countBy(tasks: DownloadTask[], predicate: (task: DownloadTask) => boolean): number {
  let n = 0
  for (const task of tasks) if (predicate(task)) n++
  return n
}

function Section({
  label,
  open,
  onToggle,
  children
}: {
  label: string
  open: boolean
  onToggle(): void
  children?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="flex items-center gap-1 mt-3 mb-0.5 pl-1.5 pr-0.5">
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 flex-1 text-left text-[10.5px] font-semibold tracking-[0.6px]
                   uppercase text-faint hover:text-muted transition-colors"
      >
        <ChevronIcon open={open} className="w-2.5 h-2.5" />
        {label}
      </button>
      {children}
    </div>
  )
}

function Item({
  icon,
  label,
  count,
  active,
  indent,
  highlight,
  onClick,
  trailing
}: {
  icon: React.ReactNode
  label: string
  count: number
  active: boolean
  indent?: boolean
  highlight?: boolean
  onClick(): void
  trailing?: React.ReactNode
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      title={label}
      className={
        'group relative w-full flex items-center gap-2.5 rounded-lg py-[6px] pr-2 text-[12.5px] transition-colors ' +
        (indent ? 'pl-6 ' : 'pl-2.5 ') +
        (active ? 'text-ink' : 'text-muted hover:text-ink hover:bg-white/[0.045]')
      }
      style={active ? { background: 'var(--accent-soft)' } : undefined}
    >
      {active && (
        <span
          className="absolute left-0 top-1.5 bottom-1.5 w-[2.5px] rounded-full"
          style={{ background: 'var(--accent)' }}
        />
      )}
      <span
        className="shrink-0 transition-colors"
        style={{ color: active ? 'var(--accent)' : undefined }}
      >
        {icon}
      </span>
      <span className="flex-1 text-left truncate">{label}</span>
      {trailing}
      {count > 0 && (
        <span
          className={
            'tnum text-[10.5px] px-1.5 py-px rounded-full shrink-0 ' +
            (highlight ? 'text-white' : 'text-faint bg-white/[0.06]')
          }
          style={highlight ? { background: 'var(--accent)' } : undefined}
        >
          {count}
        </span>
      )}
    </button>
  )
}

function QueueItem({
  id,
  name,
  running,
  count,
  active,
  onClick,
  stopLabel,
  startLabel,
  errorLabel
}: {
  id: string
  name: string
  running: boolean
  count: number
  active: boolean
  onClick(): void
  stopLabel: string
  startLabel: string
  errorLabel: string
}): React.ReactElement {
  const toggle = (event: React.MouseEvent): void => {
    // The row selects the queue; the glyph starts or stops it. Without this the
    // only way to run a queue would be a trip through the scheduler dialog.
    event.stopPropagation()
    const call = running ? window.api.stopQueue(id) : window.api.startQueue(id)
    void call.catch((err) => reportError(errorLabel, err))
  }

  return (
    <Item
      indent
      icon={<LayersIcon className="w-[15px] h-[15px]" />}
      label={name}
      count={count}
      active={active}
      onClick={onClick}
      trailing={
        <span
          role="button"
          tabIndex={0}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') toggle(event as unknown as React.MouseEvent)
          }}
          title={running ? stopLabel : startLabel}
          className={
            'w-5 h-5 rounded grid place-items-center shrink-0 transition-colors ' +
            (running ? 'text-ok' : 'text-faint opacity-0 group-hover:opacity-100 hover:text-ink')
          }
        >
          {running ? <StopAllIcon className="w-3 h-3" /> : <PlayIcon className="w-3 h-3" />}
        </span>
      }
    />
  )
}
