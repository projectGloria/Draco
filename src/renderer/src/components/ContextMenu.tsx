import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * A right-click menu. Positioned at the cursor and then nudged back inside the
 * window - a menu opened near the bottom edge that runs off screen is worse
 * than no menu at all.
 */

export interface MenuItem {
  /** A separator when omitted. */
  label?: string
  onClick?(): void
  disabled?: boolean
  danger?: boolean
  /** Renders a checkmark column, for toggles like column visibility. */
  checked?: boolean
}

export interface MenuPosition {
  x: number
  y: number
}

export default function ContextMenu({
  at,
  items,
  onClose
}: {
  at: MenuPosition
  items: MenuItem[]
  onClose(): void
}): React.ReactElement {
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<MenuPosition>(at)

  useLayoutEffect(() => {
    const el = menu.current
    if (!el) return

    const { width, height } = el.getBoundingClientRect()
    const margin = 6
    setPos({
      x: Math.max(margin, Math.min(at.x, window.innerWidth - width - margin)),
      y: Math.max(margin, Math.min(at.y, window.innerHeight - height - margin))
    })
  }, [at])

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }

    // `mousedown` rather than `click`, so the menu is gone before the press
    // underneath it starts a selection.
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={menu}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-[95] min-w-[190px] py-1 rounded-lg bg-raised border border-line-strong
                 shadow-[0_18px_50px_rgba(0,0,0,0.6)] fade-up"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item, index) =>
        item.label === undefined ? (
          <div key={index} className="h-px my-1 bg-line" />
        ) : (
          <button
            key={index}
            disabled={item.disabled}
            onClick={() => {
              item.onClick?.()
              onClose()
            }}
            className={
              'w-full flex items-center gap-2 px-3 py-[5px] text-left text-[12.5px] transition-colors ' +
              'disabled:opacity-35 disabled:cursor-not-allowed ' +
              (item.danger
                ? 'text-err enabled:hover:bg-[rgba(248,113,113,0.12)]'
                : 'text-muted enabled:hover:text-ink enabled:hover:bg-white/[0.07]')
            }
          >
            {item.checked !== undefined && (
              <span className="w-3 shrink-0" style={{ color: 'var(--accent)' }}>
                {item.checked ? '✓' : ''}
              </span>
            )}
            <span className="truncate">{item.label}</span>
          </button>
        )
      )}
    </div>
  )
}
