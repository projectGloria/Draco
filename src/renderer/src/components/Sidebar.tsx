import CategoryIcon from './CategoryIcon'
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../store/app'
import { reportError } from '../store/toasts'
import { useT } from '../i18n'
import type { Queue } from '@shared/types'
import ContextMenu, { type MenuPosition } from './ContextMenu'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import QueueIcon from './QueueIcon'
import {
  CalendarIcon,
  CheckIcon,
  ChevronIcon,
  ClipboardIcon,
  DownloadIcon,
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
  onEditQueues(id?: string): void
}): React.ReactElement {
  const categories = useApp((s) => s.categories)
  const queues = useApp((s) => s.queues)
  const sidebar = useApp((s) => s.sidebar)
  const setSidebar = useApp((s) => s.setSidebar)
  const t = useT()

  const clipboardItems = useApp((s) => s.clipboardItems)
  const clipboardFetching = clipboardItems.some((item) => item.status === 'fetching')

  /*
   * One pass over the list for every count this nav draws.
   *
   * There used to be four selectors here, and Zustand runs every one of them on
   * every store write - which is four times a second while anything is
   * downloading. Two of them were O(tasks x queues) and O(tasks x categories),
   * one allocated a filtered array to read its length, and all of them then
   * encoded their results into a comma-joined string that was parsed back out
   * with a freshly compiled RegExp per queue per render. That last part was
   * also quietly wrong: the id was interpolated into the pattern unescaped, so
   * an id carrying a regex metacharacter matched the wrong entry.
   *
   * `useShallow` is what makes the single pass pay off - the record is rebuilt
   * every tick, but the nav only re-renders when a number in it moved. It has
   * to be one flat record for that to work: a shallow compare over nested
   * `queue` and `category` objects would see two fresh references every time
   * and never match. The keys are the same strings the sidebar selection uses,
   * so there is no second naming scheme to keep in step.
   */
  const counts = useApp(
    useShallow((s) => {
      const out: Record<string, number> = {
        total: s.tasks.length, unfinished: 0, active: 0, queued: 0, attention: 0
      }

      for (const task of s.tasks) {
        if (task.status !== 'done') out.unfinished++
        if (['probing', 'downloading', 'processing', 'scanning'].includes(task.status)) out.active++
        if (task.status === 'queued') out.queued++
        if (task.status === 'error' || task.status === 'missing') out.attention++
        if (task.queueId) {
          const key = 'queue:' + task.queueId
          out[key] = (out[key] ?? 0) + 1
        }
        if (task.categoryId) {
          const key = 'cat:' + task.categoryId
          out[key] = (out[key] ?? 0) + 1
        }
      }

      return out
    })
  )

  const total = counts.total
  const unfinished = counts.unfinished
  const finished = total - unfinished

  const [openCategories, setOpenCategories] = useState(true)
  const [openQueues, setOpenQueues] = useState(true)
  const [menu, setMenu] = useState<{ queue: Queue; at: MenuPosition } | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const rename = async (): Promise<void> => {
    const queue = queues.find((item) => item.id === renameId)
    if (!queue || !name.trim()) return
    try {
      await window.api.saveQueue({ ...queue, name: name.trim() })
      setRenameId(null)
    } catch (error) { reportError(t('queueSaveFailed'), error) }
  }

  return (
    <nav className="w-[204px] shrink-0 border-r border-line bg-white/[0.012] overflow-y-auto py-2 px-2 flex flex-col gap-0.5 max-[720px]:hidden">
      <Item
        icon={<ListIcon className="w-[15px] h-[15px]" />}
        label={t('allDownloads')}
        count={total}
        active={sidebar === 'all'}
        onClick={() => setSidebar('all')}
      />
      <Item
        icon={<DownloadIcon className="w-[15px] h-[15px]" />}
        label={t('activeDownloads')}
        count={counts.active}
        active={sidebar === 'active'}
        onClick={() => setSidebar('active')}
      />
      <Item
        icon={<ListIcon className="w-[15px] h-[15px]" />}
        label={t('queuedDownloads')}
        count={counts.queued}
        active={sidebar === 'queued'}
        onClick={() => setSidebar('queued')}
      />
      <Item
        icon={<StopAllIcon className="w-[15px] h-[15px]" />}
        label={t('needsAttention')}
        count={counts.attention}
        active={sidebar === 'attention'}
        onClick={() => setSidebar('attention')}
      />
      <Item
        icon={<CheckIcon className="w-[15px] h-[15px]" />}
        label={t('finished')}
        count={finished}
        active={sidebar === 'finished'}
        onClick={() => setSidebar('finished')}
      />
      <div className="h-2" />
      <Item
        icon={<ClipboardIcon className="w-[15px] h-[15px]" />}
        label={t('clipboard')}
        count={clipboardItems.length}
        active={sidebar === 'clipboard'}
        onClick={() => setSidebar('clipboard')}
        trailing={clipboardFetching ? (
          <span
            className="w-3.5 h-3.5 rounded-full border-2 border-faint border-t-[var(--accent)] animate-spin shrink-0"
            aria-label={t('preparingClipboard')}
          />
        ) : undefined}
      />
      <Item
        icon={<DownloadIcon className="w-[15px] h-[15px]" />}
        label={t('unfinished')}
        count={unfinished}
        active={sidebar === 'unfinished'}
        onClick={() => setSidebar('unfinished')}
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
            icon={<CategoryIcon category={category} />}
            label={category.name}
            count={counts['cat:' + category.id] ?? 0}
            active={sidebar === 'cat:' + category.id}
            onClick={() => setSidebar('cat:' + category.id)}
          />
        ))}

      <div className="h-2" />

      <Section label={t('queues')} open={openQueues} onToggle={() => setOpenQueues((v) => !v)}>
        <button
          onClick={() => onEditQueues()}
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
            icon={queue.icon}
            onContextMenu={(event) => { event.preventDefault(); setMenu({ queue, at: { x: event.clientX, y: event.clientY } }) }}
            running={queue.running}
            count={counts['queue:' + queue.id] ?? 0}
            active={sidebar === 'queue:' + queue.id}
            onClick={() => setSidebar('queue:' + queue.id)}
            stopLabel={t('stopQueue')}
            startLabel={t('startQueue')}
            errorLabel={t('queueFailed')}
          />
        ))}
      {menu && <ContextMenu at={menu.at} onClose={() => setMenu(null)} items={[
        { label: t('renameQueue'), onClick: () => { setRenameId(menu.queue.id); setName(menu.queue.name) } },
        { label: t('options'), onClick: () => onEditQueues(menu.queue.id) }
      ]} />}
      {renameId && <Dialog title={t('renameQueue')} width={400} onClose={() => setRenameId(null)} footer={<>
        <GhostButton onClick={() => setRenameId(null)}>{t('cancel')}</GhostButton>
        <PrimaryButton disabled={!name.trim()} onClick={() => void rename()}>{t('saveQueue')}</PrimaryButton>
      </>}>
        <input autoFocus value={name} maxLength={60} onFocus={(event) => event.target.select()} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void rename() }} className="field" aria-label={t('name')} />
      </Dialog>}
    </nav>
  )
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
  onContextMenu,
  trailing
}: {
  icon: React.ReactNode
  label: string
  count: number
  active: boolean
  indent?: boolean
  highlight?: boolean
  onClick(): void
  onContextMenu?(event: React.MouseEvent): void
  trailing?: React.ReactNode
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
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
  icon,
  onContextMenu,
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
  icon: Queue['icon']
  onContextMenu(event: React.MouseEvent): void
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
      icon={<QueueIcon icon={icon} className="w-[15px] h-[15px]" />}
      label={name}
      count={count}
      active={active}
      onClick={onClick}
      onContextMenu={onContextMenu}
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
