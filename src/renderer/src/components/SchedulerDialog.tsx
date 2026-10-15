import { useEffect, useState } from 'react'
import type { Queue, QueueCompletionAction, QueueMode } from '@shared/types'
import { useApp } from '../store/app'
import { reportError, toast } from '../store/toasts'
import { useT, type TKey } from '../i18n'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import { PlayIcon, PlusIcon, StopAllIcon } from './Icons'
import QueueIcon from './QueueIcon'
import { QUEUE_ICONS, moveQueueItem, queueIcon } from '@shared/queue-order'

/**
 * Queues and their schedule. A queue is an ordered list of downloads that runs
 * inside a time window and can put the machine to sleep when it drains - which
 * is the whole reason anyone sets one up.
 */

const DAY_KEYS: Array<[string, TKey]> = [
  ['Sun', 'daySun'], ['Mon', 'dayMon'], ['Tue', 'dayTue'], ['Wed', 'dayWed'],
  ['Thu', 'dayThu'], ['Fri', 'dayFri'], ['Sat', 'daySat']
]

const MODES: Array<{ id: QueueMode; label: TKey; hint: TKey }> = [
  { id: 'manual', label: 'modeManual', hint: 'modeManualHint' },
  { id: 'onetime', label: 'modeOnce', hint: 'modeOnceHint' },
  { id: 'periodic', label: 'modePeriodic', hint: 'modePeriodicHint' }
]

const ACTIONS: Array<{ id: QueueCompletionAction; label: TKey }> = [
  { id: 'none', label: 'actionNone' },
  { id: 'run', label: 'actionRun' },
  { id: 'exit', label: 'actionExit' },
  { id: 'sleep', label: 'actionSleep' },
  { id: 'hibernate', label: 'actionHibernate' },
  { id: 'shutdown', label: 'actionShutdown' }
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
    maxConcurrent: 1,
    parallelismConfigured: true,
    icon: 'layers',
    speedLimit: null,
    retryLimit: 3,
    retryDelaySeconds: 30,
    onComplete: 'none',
    completionProgram: null,
    completionArgs: [],
    running: false,
    oneTimeCompleted: false,
    lastResult: 'idle'
  }
}

export default function SchedulerDialog({ onClose, initialQueueId }: { onClose(): void; initialQueueId?: string }): React.ReactElement {
  const t = useT()
  const queues = useApp((s) => s.queues)
  const tasks = useApp((s) => s.tasks)

  const initial = queues.find((queue) => queue.id === initialQueueId) ?? queues[0]
  const [selectedId, setSelectedId] = useState<string | null>(initial?.id ?? null)
  const [draft, setDraft] = useState<Queue>(() => initial ?? blankQueue())

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
      toast('success', t('queueSaved'), saved.name)
    } catch (err) {
      reportError(t('queueSaveFailed'), err)
    }
  }

  async function remove(): Promise<void> {
    if (!draft.id) return
    try {
      await window.api.removeQueue(draft.id)
    } catch (err) {
      reportError(t('queueDeleteFailed'), err)
    }
  }

  const assigned = [
    ...draft.taskIds
      .map((id) => tasks.find((task) => task.id === id && task.queueId === draft.id))
      .filter((task): task is NonNullable<typeof task> => Boolean(task)),
    ...tasks.filter((task) => task.queueId === draft.id && !draft.taskIds.includes(task.id))
  ]
  const timed = draft.mode !== 'manual'
  const running = queues.find((queue) => queue.id === draft.id)?.running ?? false

  return (
    <Dialog
      title={t('queuesAndScheduler')}
      width={780}
      height={690}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={() => void remove()} danger disabled={!draft.id}>
            {t('deleteQueue')}
          </GhostButton>
          <div className="flex-1" />
          <GhostButton onClick={onClose}>{t('close')}</GhostButton>
          <PrimaryButton onClick={() => void save()}>{t('saveQueue')}</PrimaryButton>
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
              <QueueIcon icon={queue.icon} className="w-4 h-4 shrink-0" />
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
            {t('newQueue')}
          </button>
        </aside>

        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="label">{t('name')}</label>
              <input
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                className="field text-[12.5px]"
              />
            </div>
            <div className="w-[130px]">
              <label className="label">{t('queueParallel')}</label>
              <input
                type="number"
                min={1}
                max={20}
                value={draft.maxConcurrent}
                onChange={(event) => patch({ maxConcurrent: Number(event.target.value) })}
                className="field text-[12.5px] tnum"
              />
            </div>
            <div className="w-[130px]">
              <label className="label">{t('speedKb')}</label>
              <input
                type="number"
                min={0}
                value={draft.speedLimit ? Math.round(draft.speedLimit / 1024) : ''}
                placeholder={t('noLimit')}
                onChange={(event) => {
                  const kb = Number(event.target.value)
                  // Shared by every task in the queue, and never wider than the
                  // global limit - see the Queue type.
                  patch({ speedLimit: kb > 0 ? kb * 1024 : null })
                }}
                className="field text-[12.5px] tnum"
              />
            </div>
            {draft.id && (
              <GhostButton
                onClick={() => {
                  const call = running
                    ? window.api.stopQueue(draft.id)
                    : window.api.startQueue(draft.id)
                  void call.catch((err) => reportError(t('queueFailed'), err))
                }}
              >
                <span className="flex items-center gap-1.5">
                  {running ? (
                    <StopAllIcon className="w-3.5 h-3.5" />
                  ) : (
                    <PlayIcon className="w-3.5 h-3.5" />
                  )}
                  {running ? t('stop') : t('startQueue')}
                </span>
              </GhostButton>
            )}
          </div>

          <div>
            <label className="label">{t('queueIcon')}</label>
            <div className="flex gap-2">
              {QUEUE_ICONS.map((icon) => <button key={icon} type="button" aria-label={t(`queueIcon_${icon}`)} title={t(`queueIcon_${icon}`)} aria-pressed={queueIcon(draft.icon) === icon}
                onClick={() => patch({ icon })} className="p-2.5 rounded-lg border border-line hover:bg-white/[0.06]"
                style={queueIcon(draft.icon) === icon ? { background: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}>
                <QueueIcon icon={icon} />
              </button>)}
            </div>
            <p className="text-[11px] text-faint mt-2">{t('queueOrderHint')}</p>
          </div>

          <div>
            <label className="label">{t('schedule')}</label>
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
                  <span className="block font-semibold">{t(mode.label)}</span>
                  <span className="block text-[10.5px] text-faint mt-0.5 leading-snug">
                    {t(mode.hint)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {timed && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">{t('startAt')}</label>
                <input
                  type="time"
                  value={draft.startTime ?? ''}
                  onChange={(event) => patch({ startTime: event.target.value || null })}
                  className="field text-[12.5px] tnum"
                />
              </div>
              <div>
                <label className="label">{t('stopAtOptional')}</label>
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
              <label className="label">{t('days')}</label>
              <div className="flex gap-1.5">
                {DAY_KEYS.map(([day, dayKey], index) => {
                  const on = draft.days.includes(index)
                  return (
                    <button
                      key={day}
                      onClick={() =>
                        patch({
                          days: on
                            ? draft.days.filter((d) => d !== index)
                            : [...draft.days, index].sort((a, b) => a - b)
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
                      {t(dayKey)}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          <div>
            <label className="label">{t('failureRetries')}</label>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="number"
                min={0}
                max={20}
                value={draft.retryLimit}
                onChange={(event) => patch({ retryLimit: Number(event.target.value) })}
                className="field text-[12.5px] tnum"
                title={t('retryAttemptsHint')}
              />
              <input
                type="number"
                min={0}
                max={86400}
                value={draft.retryDelaySeconds}
                onChange={(event) => patch({ retryDelaySeconds: Number(event.target.value) })}
                className="field text-[12.5px] tnum"
                title={t('retryDelayHint')}
              />
            </div>
            <p className="text-[10.5px] text-faint mt-1">{t('retryFieldsHint')}</p>
          </div>

          <div>
            <label className="label">{t('whenQueueFinishes')}</label>
            <select
              value={draft.onComplete}
              onChange={(event) =>
                patch({ onComplete: event.target.value as QueueCompletionAction })
              }
              className="field text-[12.5px]"
            >
              {ACTIONS.map((action) => (
                <option key={action.id} value={action.id}>
                  {t(action.label)}
                </option>
              ))}
            </select>
            {draft.onComplete === 'run' && (
              <div className="grid grid-cols-2 gap-2 mt-2">
                <input
                  value={draft.completionProgram ?? ''}
                  onChange={(event) => patch({ completionProgram: event.target.value || null })}
                  className="field text-[12px]"
                  placeholder="C:\\Tools\\after-download.exe"
                />
                <textarea
                  rows={2}
                  value={draft.completionArgs.join('\n')}
                  onChange={(event) => patch({ completionArgs: event.target.value.split(/\r?\n/).filter(Boolean) })}
                  className="field text-[12px]"
                  placeholder="One argument per line"
                />
              </div>
            )}
            {draft.onComplete !== 'none' && draft.onComplete !== 'exit' && (
              <p className="text-[11px] text-faint mt-1.5 leading-relaxed">
                {t('cancelWindowHint')}
              </p>
            )}
          </div>

          <div>
            <label className="label">{t('downloadsInQueue')}</label>
            {assigned.length === 0 ? (
              <p className="text-[11.5px] text-faint">
                {t('noQueuedDownloads', { name: draft.name })}
              </p>
            ) : (
              <div className="max-h-[110px] overflow-y-auto rounded-lg border border-line divide-y divide-line">
                {assigned.map((task, index) => (
                  <div key={task.id} draggable
                    onDragStart={(event) => { event.dataTransfer.setData('application/x-draco-queue-task', task.id); event.dataTransfer.effectAllowed = 'move' }}
                    onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-draco-queue-task')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
                    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); patch({ taskIds: moveQueueItem(assigned.map((item) => item.id), event.dataTransfer.getData('application/x-draco-queue-task'), task.id) }) }}
                    className="px-2.5 py-1.5 text-[11.5px] flex items-center gap-2 cursor-grab">
                    <span className="text-faint tnum">{index + 1}.</span>
                    <span className="flex-1 truncate">{task.filename}</span>
                    <button
                      disabled={index === 0}
                      onClick={() => {
                        const ids = assigned.map((item) => item.id)
                        ;[ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]
                        patch({ taskIds: ids })
                      }}
                      className="text-faint hover:text-ink disabled:opacity-20"
                      title={t('moveEarlier')}
                    >↑</button>
                    <button
                      disabled={index === assigned.length - 1}
                      onClick={() => {
                        const ids = assigned.map((item) => item.id)
                        ;[ids[index], ids[index + 1]] = [ids[index + 1], ids[index]]
                        patch({ taskIds: ids })
                      }}
                      className="text-faint hover:text-ink disabled:opacity-20"
                      title={t('moveLater')}
                    >↓</button>
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
