import { useEffect, useState } from 'react'
import { useApp } from '../store/app'
import { BrandMark, CloseGlyph, MaximizeGlyph, MinimizeGlyph } from './Icons'
import { useT } from '../i18n'

export default function TitleBar(): React.ReactElement {
  const [maximized, setMaximized] = useState(false)
  const activeTasksStr = useApp((s) => {
    const activeTasks = s.tasks.filter((t) => t.status === 'downloading')
    return `${activeTasks.length}:${activeTasks[0]?.filename || ''}`
  })
  
  const [activeCount, firstName] = activeTasksStr.split(/:(.*)/)
  const active = parseInt(activeCount, 10)
  const t = useT()

  useEffect(() => window.api.onMaximizeChange(setMaximized), [])

  let titleText = t('downloadManager')
  if (active === 1) titleText = t('downloadingSingle', { name: firstName })
  else if (active > 1) titleText = t('downloadingMultiple', { name: firstName, count: active - 1 })

  return (
    <header className="drag h-9 shrink-0 flex items-center gap-2.5 pl-3 pr-1 border-b border-line bg-white/[0.015] relative z-30">
      <BrandMark className="w-4 h-4 drop-shadow-[0_0_8px_var(--accent-line)]" />
      <span className="font-display text-[13px] font-bold tracking-[0.3px]">Draco</span>

      <div className="flex-1 text-center text-[11.5px] text-faint tracking-[0.2px] truncate max-[720px]:hidden">
        {titleText}
      </div>

      <div className="no-drag flex">
        <WindowButton label={t('minimize')} onClick={() => void window.api.minimize()}>
          <MinimizeGlyph />
        </WindowButton>
        <WindowButton
          label={maximized ? t('restore') : t('maximize')}
          onClick={() => void window.api.toggleMaximize()}
        >
          <MaximizeGlyph maximized={maximized} />
        </WindowButton>
        <WindowButton label={t('close')} onClick={() => void window.api.close()} close>
          <CloseGlyph />
        </WindowButton>
      </div>
    </header>
  )
}

function WindowButton({
  children,
  label,
  onClick,
  close
}: {
  children: React.ReactNode
  label: string
  onClick(): void
  close?: boolean
}): React.ReactElement {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={
        'w-[42px] h-9 grid place-items-center text-muted transition-colors ' +
        (close ? 'hover:bg-[#e81123] hover:text-white' : 'hover:bg-white/[0.07] hover:text-ink')
      }
    >
      {children}
    </button>
  )
}
