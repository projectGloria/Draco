import { useEffect, useState } from 'react'
import type { SiteGrabProject } from '@shared/types'
import { looksLikeUrl } from '../lib/format'
import { reportError, toast } from '../store/toasts'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import Toggle from './Toggle'

export default function SiteGrabberDialog({ onClose }: { onClose(): void }): React.ReactElement {
  const [url, setUrl] = useState('')
  const [depth, setDepth] = useState(2)
  const [pages, setPages] = useState(100)
  const [includeAssets, setIncludeAssets] = useState(true)
  const [stayOnHost, setStayOnHost] = useState(true)
  const [respectRobots, setRespectRobots] = useState(true)
  const [autoStart, setAutoStart] = useState(false)
  const [scheduleHours, setScheduleHours] = useState(0)
  const [busy, setBusy] = useState(false)
  const [projects, setProjects] = useState<SiteGrabProject[]>([])

  const refresh = (): void => {
    void window.api.listSiteGrabs().then(setProjects).catch(() => {})
  }
  useEffect(refresh, [])

  const submit = (): void => {
    if (!looksLikeUrl(url) || busy) return
    setBusy(true)
    void window.api.startSiteGrab({
      startUrl: url,
      maxDepth: depth,
      maxPages: pages,
      includeAssets,
      stayOnHost,
      respectRobots,
      autoStart,
      scheduleHours: scheduleHours >= 1 ? scheduleHours : null
    }).then((result) => {
      toast('success', `${result.added} site resources added`, result.rootDir)
      onClose()
    }).catch((error) => reportError('Site grab failed', error)).finally(() => setBusy(false))
  }

  return (
    <Dialog
      title="Site grabber"
      subtitle="Discover linked pages and assets as a bounded download project"
      width={570}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton disabled={!looksLikeUrl(url) || busy} onClick={submit}>
            {busy ? 'Crawling…' : 'Create project'}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="label">Starting page</label>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value.trim())}
            className="field text-[12.5px] font-mono"
            placeholder="https://example.com/docs/"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Link depth (0–5)</label>
            <input type="number" min={0} max={5} value={depth} onChange={(event) => setDepth(Number(event.target.value))} className="field tnum text-[12.5px]" />
          </div>
          <div>
            <label className="label">Maximum pages (1–1000)</label>
            <input type="number" min={1} max={1000} value={pages} onChange={(event) => setPages(Number(event.target.value))} className="field tnum text-[12.5px]" />
          </div>
        </div>
        <div>
          <label className="label">Re-crawl every (hours)</label>
          <input type="number" min={0} max={720} value={scheduleHours} onChange={(event) => setScheduleHours(Number(event.target.value))} className="field tnum text-[12.5px]" />
          <p className="text-[10.5px] text-faint mt-1">0 disables scheduling. Later runs add newly discovered URLs.</p>
        </div>
        <div className="border-t border-line pt-2">
          <Toggle checked={includeAssets} onChange={setIncludeAssets} label="Include images, styles, scripts, media, and captions" />
          <Toggle checked={stayOnHost} onChange={setStayOnHost} label="Stay on the starting host" />
          <Toggle checked={respectRobots} onChange={setRespectRobots} label="Respect robots.txt exclusions" />
          <Toggle checked={autoStart} onChange={setAutoStart} label="Start downloads after discovery" hint="Leave off to review the generated list first." />
        </div>
        {projects.length > 0 && (
          <div className="border-t border-line pt-3">
            <label className="label">Saved projects</label>
            <div className="max-h-[120px] overflow-y-auto rounded-lg border border-line divide-y divide-line">
              {projects.map((project) => (
                <div key={project.id} className="flex items-center gap-2 px-2.5 py-2 text-[11.5px]">
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-ink">{project.name}</div>
                    <div className="truncate text-faint">{project.knownUrls.length} known URLs{project.lastError ? ` · ${project.lastError}` : ''}</div>
                  </div>
                  <GhostButton onClick={() => {
                    void window.api.runSiteGrab(project.id)
                      .then((result) => { toast('success', `${result.added} new resources added`); refresh() })
                      .catch((error) => reportError('Site sync failed', error))
                  }}>Sync</GhostButton>
                  <GhostButton danger onClick={() => {
                    void window.api.removeSiteGrab(project.id).then(refresh).catch((error) => reportError('Could not remove project', error))
                  }}>Remove</GhostButton>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}
