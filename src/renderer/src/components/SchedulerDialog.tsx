import { useEffect, useState } from 'react'
import type { Queue, QueueCompletionAction, QueueMode } from '@shared/types'
import { useApp } from '../store/app'
import { reportError, toast } from '../store/toasts'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import { LayersIcon, PlayIcon, PlusIcon, StopAllIcon } from './Icons'

/**
 * Queues and their schedule. A queue is an ordered list of downloads that runs
 * inside a time window and can put the machine to sleep when it drains - which
 * is the whole reason anyone sets one up.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const MODES: Array<{ id: QueueMode; label: string; hint: string }> = [
  { id: 'manual', label: 'Manual', hint: 'Runs only when you start it' },
  { id: 'onetime', label: 'Once', hint: 'Starts at the given time, then stops' },
  { id: 'periodic', label: 'Periodic', hint: 'Starts on the chosen days' }
]

const ACTIONS: Array<{ id: QueueCompletionAction; label: string }> = [
  { id: 'none', label: 'Do nothing' },
  { id: 'exit', label: 'Quit Draco' },
  { id: 'sleep', label: 'Sleep' },
  { id: 'hibernate', label: 'Hibernate' },
  { id: 'shutdown', label: 'Shut down' }
]

function blankQueue(): Queue {
  return {
    id: '',
    name: 'New queue',
    taskIds: [],
    mode: 'manual',
    startTime: '02:00',
    stopTime: null,
    days: [1, 2, 3, 4, 5],
    maxConcurrent: 2,
    onComplete: 'none',
    running: false
  }
}

export default function SchedulerDialog({ onClose }: { onClose(): void }): React.ReactElement {
  const queues = useApp((s) => s.queues)
  const tasks = useApp((s) => s.tasks)

  const [selectedId, setSelectedId] = useState<string | null>(queues[0]?.id ?? null)
  const [draft, setDraft] = useState<Queue>(() => queues[0] ?? blankQueue())

  // Keep the editor pointed at a queue that still exists after a delete.
  useEffect(() => {
    if (selectedId === null) return
    const found = queues.find((q) => q.id === selectedId)
    if (!found) {
      setSelectedId(queues[0]?.id ?? null)
      setDraft(queues[0] ?? blankQueue())
    }
  }, [queues, selectedId])

  function pick(queue: Queue): void {
    setSelectedId(queue.id)
    setDraft(queue)
  }

  function patch(next: Partial<Queue>): void {
    setDraft((current) => ({ ...current, ...next }))
  }

  async function save(): Promise<void> {
    try {
      const saved = await window.api.saveQueue(draft)
      setSelectedId(saved.id)
      setDraft(saved)
      toast('success', 'Queue saved', saved.name)
    } catch (err) {
      reportError('Could not save the queue', err)
    }
  }

  async function remove(): Promise<void> {
    if (!draft.id) return
    try {
      await window.api.removeQueue(draft.id)
    } catch (err) {
      reportError('Could not delete the queue', err)
    }
  }

  const assigned = tasks.filter((t) => t.queueId === draft.id)
  const timed = draft.mode !== 'manual'

  return (
    <Dialog
      title="Queues and scheduler"
      width={760}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={() => void remove()} danger disabled={!draft.id}>
            Delete queue
          </GhostButton>
          <div className="flex-1" />
          <GhostButton onClick={onClose}>Close</GhostButton>
          <PrimaryButton onClick={() => void save()}>Save queue</PrimaryButton>
        </>
      }
    >
      <div className="flex gap-4 min-h-[380px]">
        <aside className="w-[190px] shrink-0 flex flex-col gap-1">
          {queues.map((queue) => (
            <button
              key={queue.id}
              onClick={() => pick(queue)}
              className={
                'w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[12.5px] text-left transition-colors ' +
                (queue.id === selectedId
                  ? 'text-ink'
                  : 'text-muted hover:text-ink hover:bg-white/[0.05]')
              }
              style={queue.id === selectedId ? { background: 'var(--accent-soft)' } : undefined}
            >
              <LayersIcon className="w-4 h-4 shrink-0" />
              <span className="flex-1 truncate">{queue.name}</span>
              {queue.running && (
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--color-ok)' }} />
              )}
            </button>
          ))}

          <button
            onClick={() => {
              setSelectedId(null)
              setDraft(blankQueue())
            }}
            className="mt-1 w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[12.5px]
                       text-faint hover:text-ink hover:bg-white/[0.05] transition-colors"
          >
            <PlusIcon className="w-4 h-4" />
            New queue
          </button>
        </aside>

        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="label">Name</label>
              <input
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                className="field text-[12.5px]"
              />
            </div>
            <div className="w-[130px]">
              <label className="label">Concurrent</label>
              <input
                type="number"
                min={1}
                max={20}
                value={draft.maxConcurrent}
                onChange={(event) => patch({ maxConcurrent: Number(event.target.value) })}
                className="field text-[12.5px] tnum"
              />
            </div>
            {draft.id && (
              <GhostButton
                onClick={() => {
                  const call = draft.running
                    ? window.api.stopQueue(draft.id)
                    : window.api.startQueue(draft.id)
                  void call.catch((err) => reportError('Queue command failed', err))
                }}
              >
                <span className="flex items-center gap-1.5">
                  {draft.running ? (
                    <StopAllIcon className="w-3.5 h-3.5" />
                  ) : (
                    <PlayIcon className="w-3.5 h-3.5" />
                  )}
                  {draft.running ? 'Stop' : 'Start'}
                </span>
              </GhostButton>
            )}
          </div>

          <div>
            <label className="label">Schedule</label>
            <div className="flex gap-2">
              {MODES.map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => patch({ mode: mode.id })}
                  title={mode.hint}
                  className={
                    'flex-1 px-3 py-2 rounded-lg border text-[12px] text-left transition-colors ' +
                    (draft.mode === mode.id
                      ? 'text-ink'
                      : 'border-line text-muted hover:text-ink hover:bg-white/[0.05]')
                  }
                  style={
                    draft.mode === mode.id
                      ? { background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }
                      : undefined
                  }
                >
                  <span className="block font-semibold">{mode.label}</span>
                  <span className="block text-[10.5px] text-faint mt-0.5 leading-snug">
                    {mode.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {timed && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Start at</label>
                <input
                  type="time"
                  value={draft.startTime ?? ''}
                  onChange={(event) => patch({ startTime: event.target.value || null })}
                  className="field text-[12.5px] tnum"
                />
              </div>
              <div>
                <label className="label">Stop at (optional)</label>
                <input
                  type="time"
                  value={draft.stopTime ?? ''}
                  onChange={(event) => patch({ stopTime: event.target.value || null })}
                  className="field text-[12.5px] tnum"
                />
              </div>
            </div>
          )}

          {draft.mode === 'periodic' && (
            <div>
              <label className="label">Days</label>
              <div className="flex gap-1.5">
                {DAYS.map((day, index) => {
                  const on = draft.days.includes(index)
                  return (
                    <button
                      key={day}
                      onClick={() =>
                        patch({
                          days: on
                            ? draft.days.filter((d) => d !== index)
                            : [...draft.days, index].sort()
                        })
                      }
                      className={
                        'flex-1 py-1.5 rounded-lg border text-[11.5px] transition-colors ' +
                        (on ? 'text-ink' : 'border-line text-faint hover:text-ink hover:bg-white/[0.05]')
                      }
                      style={
                        on
                          ? { background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }
                          : undefined
                      }
                    >
                      {day}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div>
            <label className="label">When the queue finishes</label>
            <select
              value={draft.onComplete}
              onChange={(event) =>
                patch({ onComplete: event.target.value as QueueCompletionAction })
              }
              className="field text-[12.5px]"
            >
              {ACTIONS.map((action) => (
                <option key={action.id} value={action.id}>
                  {action.label}
                </option>
              ))}
            </select>
            {draft.onComplete !== 'none' && draft.onComplete !== 'exit' && (
              <p className="text-[11px] text-faint mt-1.5 leading-relaxed">
                You get a minute to call this off before it happens.
              </p>
            )}
          </div>

          <div>
            <label className="label">Downloads in this queue</label>
            {assigned.length === 0 ? (
              <p className="text-[11.5px] text-faint">
                None yet. Right-click a download and choose “Move to {draft.name}”.
              </p>
            ) : (
              <div className="max-h-[110px] overflow-y-auto rounded-lg border border-line divide-y divide-line">
                {assigned.map((task) => (
                  <div key={task.id} className="px-2.5 py-1.5 text-[11.5px] truncate">
                    {task.filename}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
