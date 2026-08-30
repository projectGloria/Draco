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
        <label className="flex items-center gap-2.5 mt-4 text-[12.5px] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            className="w-3.5 h-3.5 accent-[var(--accent)]"
          />
          {request.checkbox}
        </label>
      )}
    </Dialog>
  )
}
