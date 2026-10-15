import { useEffect, useRef } from 'react'
import { CloseGlyph } from './Icons'

/**
 * The shell every dialog in the app sits in: a scrim, a card, Escape to close,
 * and focus moved inside on open so the keyboard does not stay behind in the
 * download table.
 */

/**
 * The dialogs currently mounted, innermost last. Escape belongs to the
 * topmost one only: `document`-level listeners all fire for the same event,
 * so without this a single press closed a dialog *and* the one stacked on
 * top of it, throwing away whatever the lower dialog had unsaved.
 */
const openDialogs: Array<Record<string, never>> = []

export default function Dialog({
  title,
  subtitle,
  width = 520,
  height,
  onClose,
  showClose = true,
  autoFocus = true,
  footer,
  children
}: {
  title: string
  subtitle?: string
  width?: number
  height?: number
  onClose(): void
  showClose?: boolean
  autoFocus?: boolean
  footer?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  const card = useRef<HTMLDivElement>(null)
  const token = useRef<Record<string, never>>({}).current
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    openDialogs.push(token)
    const onKey = (event: KeyboardEvent): void => {
      if (openDialogs[openDialogs.length - 1] !== token) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const controls = [...(card.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      ) ?? [])].filter((element) => element.getClientRects().length > 0)
      if (controls.length === 0) {
        event.preventDefault()
        card.current?.focus()
        return
      }
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && (document.activeElement === first || !card.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !card.current?.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      const at = openDialogs.indexOf(token)
      if (at >= 0) openDialogs.splice(at, 1)
      document.removeEventListener('keydown', onKey)
    }
  }, [token])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // The first field, or the card itself when the dialog is read-only.
    if (autoFocus) {
      const focusable = card.current?.querySelector<HTMLElement>(
        'input:not([type=hidden]), select, textarea, button'
      )
      focusable?.focus()
    } else {
      card.current?.focus()
    }
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [autoFocus])

  return (
    <div
      className="fixed inset-0 z-[80] grid place-items-center p-6 max-[600px]:p-2 bg-black/55 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        // Only a press that both starts and ends on the scrim closes it, so a
        // text selection dragged out of an input does not dismiss the dialog.
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={card}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="pop-in surface-card rounded-card w-full max-h-full flex flex-col
                   shadow-[0_28px_80px_rgba(0,0,0,0.6)] overflow-hidden outline-none"
        style={{ maxWidth: width, height: height ? `min(${height}px, calc(100vh - 48px))` : undefined }}
      >
        <div className="flex items-start gap-3 px-5 py-3.5 border-b border-line shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[14px] font-semibold truncate">{title}</h2>
            {subtitle && (
              <p className="text-[11.5px] text-faint mt-0.5 truncate" title={subtitle}>
                {subtitle}
              </p>
            )}
          </div>
          {showClose && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-7 h-7 -mr-1 rounded-lg grid place-items-center text-faint
                         hover:bg-white/[0.07] hover:text-ink transition-colors shrink-0"
            >
              <CloseGlyph />
            </button>
          )}
        </div>

        <div className="px-5 py-4 max-[600px]:px-3 overflow-y-auto min-h-0 flex-1">{children}</div>

        {footer && (
          <div className="px-5 py-3.5 max-[600px]:px-3 border-t border-line flex flex-wrap items-center justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = 'button'
}: {
  children: React.ReactNode
  onClick?(): void
  disabled?: boolean
  type?: 'button' | 'submit'
}): React.ReactElement {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold text-white border border-transparent
                 transition-[filter,opacity] disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
      style={{ background: 'var(--grad)' }}
    >
      {children}
    </button>
  )
}

export function GhostButton({
  children,
  onClick,
  danger,
  disabled
}: {
  children: React.ReactNode
  onClick?(): void
  danger?: boolean
  disabled?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        'px-3.5 py-1.5 rounded-lg text-[12.5px] font-medium border border-line bg-white/[0.04] ' +
        'transition-colors disabled:opacity-40 disabled:cursor-not-allowed ' +
        (danger ? 'text-err hover:bg-[rgba(248,113,113,0.12)]' : 'text-ink hover:bg-white/[0.09]')
      }
    >
      {children}
    </button>
  )
}
