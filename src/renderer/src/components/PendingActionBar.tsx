import { useEffect, useState } from 'react'
import type { PendingAction } from '@shared/types'
import { formatCountdown } from '../lib/format'
import { reportError } from '../store/toasts'
import { AlertIcon } from './Icons'

const WORDS: Record<PendingAction['action'], string> = {
  none: '',
  run: 'Draco will run the configured program',
  exit: 'Draco will quit',
  sleep: 'This computer will sleep',
  hibernate: 'This computer will hibernate',
  shutdown: 'This computer will shut down'
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
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [])

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
        {WORDS[pending.action]} in{' '}
        <b className="tnum" style={{ color: 'var(--color-warn)' }}>
          {formatCountdown(pending.firesAt - now)}
        </b>
      </span>
      <button
        onClick={() => {
          void window.api
            .cancelPendingAction()
            .catch((err) => reportError('Could not cancel', err))
        }}
        className="px-3 py-1 rounded-lg text-[12px] font-semibold bg-white/[0.08] hover:bg-white/[0.14] transition-colors"
      >
        Cancel
      </button>
    </div>
  )
}
