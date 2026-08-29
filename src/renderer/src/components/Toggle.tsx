export default function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled
}: {
  checked: boolean
  onChange(next: boolean): void
  label: string
  hint?: string
  disabled?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="w-full flex items-start gap-3 text-left py-1.5 disabled:opacity-45 group"
    >
      <span
        className="mt-0.5 w-[34px] h-[19px] rounded-full shrink-0 border transition-colors relative"
        style={{
          background: checked ? 'var(--grad)' : 'rgba(255,255,255,0.06)',
          borderColor: checked ? 'transparent' : 'var(--color-line)'
        }}
      >
        <span
          className="absolute top-[2px] w-[13px] h-[13px] rounded-full bg-white transition-[left] duration-150"
          style={{ left: checked ? '18px' : '3px' }}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] leading-[19px] group-hover:text-ink transition-colors">
          {label}
        </span>
        {hint && <span className="block text-[11px] text-faint mt-0.5 leading-snug">{hint}</span>}
      </span>
    </button>
  )
}
