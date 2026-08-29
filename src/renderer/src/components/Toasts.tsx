import type { Toast } from '../store/toasts'
import { useToasts } from '../store/toasts'
import { AlertIcon, CheckIcon, DownloadIcon } from './Icons'

const ACCENTS: Record<Toast['kind'], string> = {
  success: 'var(--color-ok)',
  info: 'var(--accent)',
  danger: 'var(--color-err)'
}

const TINTS: Record<Toast['kind'], string> = {
  success: 'rgba(52,211,153,0.12)',
  info: 'var(--accent-soft)',
  danger: 'rgba(248,113,113,0.12)'
}

export default function Toasts(): React.ReactElement | null {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)

  if (toasts.length === 0) return null

  return (
    <div className="fixed right-4 bottom-9 z-[90] flex flex-col gap-2 pointer-events-none">
      {toasts.map((item) => (
        <button
          key={item.id}
          onClick={() => dismiss(item.id)}
          title="Dismiss"
          className="pointer-events-auto relative flex items-center gap-3 text-left overflow-hidden
                     min-w-[280px] max-w-[380px] px-3.5 py-2.5 rounded-xl bg-raised border border-line-strong
                     shadow-[0_14px_40px_rgba(0,0,0,0.5)]"
          style={{
            animation: item.leaving
              ? 'toast-out 250ms forwards'
              : 'toast-in 300ms cubic-bezier(0.34,1.3,0.64,1)'
          }}
        >
          <span
            className="absolute left-0 top-0 bottom-0 w-[3px]"
            style={{ background: ACCENTS[item.kind] }}
          />
          <span
            className="w-7 h-7 rounded-lg grid place-items-center shrink-0"
            style={{ background: TINTS[item.kind], color: ACCENTS[item.kind] }}
          >
            {item.kind === 'success' ? (
              <CheckIcon className="w-3.5 h-3.5" />
            ) : item.kind === 'danger' ? (
              <AlertIcon className="w-3.5 h-3.5" />
            ) : (
              <DownloadIcon className="w-3.5 h-3.5" />
            )}
          </span>
          <span className="min-w-0">
            <b className="block text-[12px] font-semibold">{item.title}</b>
            {item.detail && (
              <span className="block text-[11px] text-faint mt-0.5 line-clamp-2">{item.detail}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  )
}
