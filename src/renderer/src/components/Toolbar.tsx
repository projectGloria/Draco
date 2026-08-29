import { useApp } from '../store/app'
import {
  BroomIcon,
  CalendarIcon,
  GearIcon,
  InfoIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  StopAllIcon,
  TrashIcon
} from './Icons'

/**
 * IDM's toolbar, in IDM's order. Buttons disable rather than disappear: a
 * toolbar whose contents move around depending on what is selected is a toolbar
 * you have to read every time.
 */

export interface ToolbarActions {
  onAdd(): void
  onResume(): void
  onPause(): void
  onPauseAll(): void
  onDelete(): void
  onDeleteCompleted(): void
  onDetails(): void
  onScheduler(): void
  onOptions(): void
}

export default function Toolbar({
  actions,
  search,
  onSearch
}: {
  actions: ToolbarActions
  search: string
  onSearch(value: string): void
}): React.ReactElement {
  const tasks = useApp((s) => s.tasks)
  const selection = useApp((s) => s.selection)

  const selected = tasks.filter((t) => selection.includes(t.id))
  const canResume = selected.some((t) => t.status !== 'downloading' && t.status !== 'done')
  const canPause = selected.some((t) => t.status === 'downloading' || t.status === 'queued')
  const anyRunning = tasks.some((t) => t.status === 'downloading' || t.status === 'queued')
  const anyDone = tasks.some((t) => t.status === 'done')

  return (
    <div className="h-11 shrink-0 flex items-center gap-1 px-2 border-b border-line bg-white/[0.02]">
      <Button icon={<PlusIcon />} label="Add URL" primary onClick={actions.onAdd} />

      <Divider />

      <Button
        icon={<PlayIcon />}
        label="Resume"
        disabled={!canResume}
        onClick={actions.onResume}
      />
      <Button icon={<PauseIcon />} label="Stop" disabled={!canPause} onClick={actions.onPause} />
      <Button
        icon={<StopAllIcon />}
        label="Stop all"
        disabled={!anyRunning}
        onClick={actions.onPauseAll}
      />

      <Divider />

      <Button
        icon={<TrashIcon />}
        label="Delete"
        disabled={selection.length === 0}
        onClick={actions.onDelete}
      />
      <Button
        icon={<BroomIcon />}
        label="Delete completed"
        disabled={!anyDone}
        onClick={actions.onDeleteCompleted}
      />
      <Button
        icon={<InfoIcon />}
        label="Details"
        disabled={selection.length !== 1}
        onClick={actions.onDetails}
      />

      <Divider />

      <Button icon={<CalendarIcon />} label="Scheduler" onClick={actions.onScheduler} />
      <Button icon={<GearIcon />} label="Options" onClick={actions.onOptions} />

      <div className="flex-1" />

      <label className="relative w-[190px] max-[900px]:w-[120px]">
        <SearchIcon className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search"
          className="field !py-1 !pl-8 text-[12px]"
          spellCheck={false}
        />
      </label>
    </div>
  )
}

function Divider(): React.ReactElement {
  return <span className="w-px h-5 bg-line mx-1 shrink-0" />
}

function Button({
  icon,
  label,
  onClick,
  disabled,
  primary
}: {
  icon: React.ReactNode
  label: string
  onClick(): void
  disabled?: boolean
  primary?: boolean
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={
        'h-8 px-2.5 rounded-lg flex items-center gap-2 text-[12px] font-medium shrink-0 transition-colors ' +
        'disabled:opacity-30 disabled:cursor-not-allowed ' +
        (primary
          ? 'text-white hover:brightness-110'
          : 'text-muted enabled:hover:text-ink enabled:hover:bg-white/[0.07]')
      }
      style={primary ? { background: 'var(--grad)' } : undefined}
    >
      <span className="shrink-0">{icon}</span>
      {/* The labels are the first thing to go when the window narrows; the
          icons and the tooltips carry it from there. */}
      <span className="max-[1120px]:hidden whitespace-nowrap">{label}</span>
    </button>
  )
}
