import { useState } from 'react'
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
      title="Updates for Draco's helper tools"
      subtitle="Downloaded by Draco, kept in your app data folder"
      width={480}
      onClose={onClose}
      footer={<GhostButton onClick={onClose}>Close</GhostButton>}
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
                <span className="text-[11.5px] text-ok shrink-0">Updated</span>
              ) : tool.updateAvailable ? (
                <PrimaryButton onClick={() => void update(tool)} disabled={busy !== null}>
                  {busy === tool.id ? 'Updating…' : 'Update'}
                </PrimaryButton>
              ) : (
                <span className="text-[11.5px] text-faint shrink-0">Up to date</span>
              )}
            </div>

            <div className="mt-2 flex items-center gap-2 text-[11px] text-faint tnum">
              <span>{versionLabel(tool, done[tool.id])}</span>
              {!tool.managed && tool.path && (
                <span className="text-warn">· from your system PATH, so Draco leaves it alone</span>
              )}
            </div>

            {errors[tool.id] && (
              <p className="mt-2 text-[11px] text-err leading-snug">{errors[tool.id]}</p>
            )}
          </div>
        ))}

        <p className="text-[11px] text-faint leading-snug mt-1">
          ffmpeg is an 80 MB download and yt-dlp a small one. Where the publisher lists a
          digest, Draco checks the file against it before it replaces the copy in use.
        </p>
      </div>
    </Dialog>
  )
}

function versionLabel(tool: ToolStatus, updatedTo?: string): string {
  if (updatedTo) return `Now ${updatedTo}`
  if (!tool.path) return 'Not installed yet; Draco fetches it the first time it is needed'
  const installed = tool.installedVersion ?? 'unknown version'
  if (tool.updateAvailable && tool.latestVersion) return `${installed} → ${tool.latestVersion}`
  return installed
}
