import { useState } from 'react'
import { useT } from '../i18n'
import type { ToolId, ToolStatus } from '@shared/types'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'

/**
 * The two binaries Draco fetches rather than ships, and the one button that
 * brings them up to date.
 *
 * It exists because the app already knew when yt-dlp was too old - the failure
 * it produces even says "updating yt-dlp usually fixes it" - and offered the
 * user nowhere to do that. Nothing here installs itself: the update runs
 * because somebody pressed the button.
 */
export default function ToolUpdateDialog({
  tools,
  onClose,
  onUpdated
}: {
  tools: ToolStatus[]
  onClose(): void
  onUpdated(next: ToolStatus): void
}): React.ReactElement {
  const t = useT()
  const [busy, setBusy] = useState<ToolId | null>(null)
  const [errors, setErrors] = useState<Partial<Record<ToolId, string>>>({})
  const [done, setDone] = useState<Partial<Record<ToolId, string>>>({})

  const update = async (tool: ToolStatus): Promise<void> => {
    setBusy(tool.id)
    setErrors((current) => ({ ...current, [tool.id]: undefined }))
    try {
      const next = await window.api.updateTool(tool.id)
      setDone((current) => ({ ...current, [tool.id]: next.installedVersion ?? 'installed' }))
      onUpdated(next)
    } catch (err) {
      setErrors((current) => ({
        ...current,
        [tool.id]: err instanceof Error ? err.message : String(err)
      }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog
      title={t('toolsUpdateTitle')}
      subtitle={t('toolsUpdateSubtitle')}
      width={480}
      onClose={onClose}
      footer={<GhostButton onClick={onClose}>{t('close')}</GhostButton>}
    >
      <div className="flex flex-col gap-2.5">
        {tools.map((tool) => (
          <div key={tool.id} className="rounded-lg border border-line bg-white/[0.03] px-3.5 py-3">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold">{tool.name}</div>
                <p className="text-[11px] text-faint mt-0.5 leading-snug">{tool.purpose}</p>
              </div>

              {done[tool.id] ? (
                <span className="text-[11.5px] text-ok shrink-0">{t('toolUpdated')}</span>
              ) : tool.updateAvailable ? (
                <PrimaryButton onClick={() => void update(tool)} disabled={busy !== null}>
                  {busy === tool.id ? t('toolUpdating') : t('toolUpdate')}
                </PrimaryButton>
              ) : (
                <span className="text-[11.5px] text-faint shrink-0">{t('toolUpToDate')}</span>
              )}
            </div>

            <div className="mt-2 flex items-center gap-2 text-[11px] text-faint tnum">
              <span>{versionLabel(tool, done[tool.id], t)}</span>
              {!tool.managed && tool.path && (
                <span className="text-warn">· {t('toolFromPath')}</span>
              )}
            </div>

            {errors[tool.id] && (
              <p className="mt-2 text-[11px] text-err leading-snug">{errors[tool.id]}</p>
            )}
          </div>
        ))}

        <p className="text-[11px] text-faint leading-snug mt-1">
          {t('toolsChecksumNote')}
        </p>
      </div>
    </Dialog>
  )
}

type Translate = ReturnType<typeof useT>
function versionLabel(tool: ToolStatus, updatedTo: string | undefined, t: Translate): string {
  if (updatedTo) return t('toolNowVersion', { version: updatedTo })
  if (!tool.path) return t('toolNotInstalled')
  const installed = tool.installedVersion ?? t('toolUnknownVersion')
  if (tool.updateAvailable && tool.latestVersion) return `${installed} → ${tool.latestVersion}`
  return installed
}
