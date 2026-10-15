import { useEffect, useState } from 'react'
import type { PendingAction } from '@shared/types'
import { formatCountdown } from '../lib/format'
import { reportError } from '../store/toasts'
import { useT, type TKey } from '../i18n'
import { AlertIcon } from './Icons'

const WORDS: Record<PendingAction['action'], TKey | null> = {
  none: null,
  run: 'pendingRun',
  exit: 'pendingExit',
  sleep: 'pendingSleep',
  hibernate: 'pendingHibernate',
  shutdown: 'pendingShutdown'
}

/**
 * The countdown before a queue's completion action fires. A download manager
 * that can turn the machine off has to be very loud about being an inch from
 * doing it, and the way out has to be one click.
 */
export default function PendingActionBar({
  pending
}: {
  pending: PendingAction
}): React.ReactElement {
  const t = useT()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [])

  // Translated around the `{time}` placeholder rather than interpolated, so
  // the countdown stays bold and Turkish can place it before the verb.
  const template = WORDS[pending.action] ? t(WORDS[pending.action] as TKey) : ''
  const time = formatCountdown(pending.firesAt - now)
  const [before, after = ''] = template.split('{time}')

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 bottom-10 z-[92] flex items-center gap-3 px-4 py-2.5
                 rounded-xl bg-raised border shadow-[0_18px_50px_rgba(0,0,0,0.6)] fade-up"
      style={{ borderColor: 'rgba(251,191,36,0.35)' }}
    >
      <span className="text-warn shrink-0">
        <AlertIcon className="w-4 h-4" />
      </span>
      <span className="text-[12.5px]">
        {before}
        <b className="tnum" style={{ color: 'var(--color-warn)' }}>
          {time}
        </b>
        {after}
      </span>
      <button
        onClick={() => {
          void window.api
            .cancelPendingAction()
            .catch((err) => reportError(t('cancelFailed'), err))
        }}
        className="px-3 py-1 rounded-lg text-[12px] font-semibold bg-white/[0.08] hover:bg-white/[0.14] transition-colors"
      >
        {t('cancel')}
      </button>
    </div>
  )
}
