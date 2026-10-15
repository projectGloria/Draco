import { useEffect } from 'react'
import type { Settings } from '@shared/types'
import { applyAccent } from '../store/app'
import { resolvedLanguage } from '../i18n'

/** Every renderer window uses the same saved theme, accent, and language. */
export function useAppearance(settings: Pick<Settings, 'theme' | 'accent' | 'language'>): void {
  useEffect(() => {
    document.documentElement.lang = resolvedLanguage(settings.language)
  }, [settings.language])

  useEffect(() => applyAccent(settings.accent), [settings.accent])

  useEffect(() => {
    const system = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.dataset.theme = settings.theme === 'system'
        ? (system.matches ? 'dark' : 'light')
        : settings.theme
    }
    apply()
    if (settings.theme !== 'system') return
    system.addEventListener('change', apply)
    return () => system.removeEventListener('change', apply)
  }, [settings.theme])
}
