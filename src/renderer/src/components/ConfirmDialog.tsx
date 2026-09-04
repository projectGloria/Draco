import { useState } from 'react'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'

export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  /** Renders an extra checkbox, e.g. "also delete the downloaded file". */
  checkbox?: string
  onConfirm(checked: boolean): void
}

export default function ConfirmDialog({
  request,
  onClose
}: {
  request: ConfirmRequest
  onClose(): void
}): React.ReactElement {
  const [checked, setChecked] = useState(false)

  const confirm = (): void => {
    request.onConfirm(checked)
    onClose()
  }

  return (
    <Dialog
      title={request.title}
      width={430}
      onClose={onClose}
      showClose={false}
      autoFocus={false}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          {request.danger ? (
            <button
              type="button"
              onClick={confirm}
              className="px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold text-white
                         bg-[#dc4c4c] hover:bg-[#e25c5c] transition-colors"
            >
              {request.confirmLabel}
            </button>
          ) : (
            <PrimaryButton onClick={confirm}>{request.confirmLabel}</PrimaryButton>
          )}
        </>
      }
    >
      <p className="text-[12.5px] leading-relaxed text-muted">{request.message}</p>

      {request.checkbox && (
        // Drawn rather than a native <input>: the platform checkbox renders in
        // the light colour scheme on this dark dialog, and an empty white box
        // reads as ticked. An opt-in this destructive has to look unticked.
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          onClick={() => setChecked(!checked)}
          className="flex items-center gap-2.5 mt-4 text-[12.5px] text-left select-none group"
        >
          <span
            className="w-[15px] h-[15px] rounded-[4px] shrink-0 border flex items-center
                       justify-center transition-colors"
            style={{
              background: checked ? 'var(--accent)' : 'transparent',
              borderColor: checked ? 'var(--accent)' : 'var(--color-line)'
            }}
          >
            {checked && (
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path
                  d="M2.5 6.3 4.8 8.6 9.5 3.9"
                  stroke="#fff"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
          <span className="group-hover:text-ink transition-colors">{request.checkbox}</span>
        </button>
      )}
    </Dialog>
  )
}
