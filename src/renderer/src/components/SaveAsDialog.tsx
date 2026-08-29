import { useEffect, useRef, useState } from 'react'
import type { NewDownload, ProbeResult, RequestHeaders } from '@shared/types'
import { formatBytes, hostOf } from '../lib/format'
import { useApp } from '../store/app'
import { reportError } from '../store/toasts'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import { FolderIcon } from './Icons'

/**
 * IDM's "Download File Info" step: what the server said about the file, and
 * where it is about to go, before a single byte is committed.
 *
 * The probe here is only for showing the user; the engine probes again for
 * itself when the task starts, because what a dialog learned thirty seconds ago
 * is not something a downloader should trust. It does reuse the captured
 * headers, though - a cookie-gated URL would 403 an anonymous probe and the
 * dialog would report a broken file that is in fact perfectly downloadable.
 */

export default function SaveAsDialog({
  url,
  suggestedFilename,
  headers,
  knownSize,
  fromBrowser,
  onClose
}: {
  url: string
  /** The name the browser had already chosen, when this came from a handoff. */
  suggestedFilename?: string
  headers?: RequestHeaders
  knownSize?: number | null
  fromBrowser?: boolean
  onClose(): void
}): React.ReactElement {
  const categories = useApp((s) => s.categories)
  const queues = useApp((s) => s.queues)

  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [filename, setFilename] = useState(suggestedFilename || fallbackName(url))
  /**
   * A ref, not state: the probe resolves long after this effect closed over its
   * variables, and a stale `false` here would overwrite a name the user had
   * already started typing.
   *
   * A name the browser supplied counts as chosen. Chrome derives it from
   * Content-Disposition itself, so it is the same answer the probe would give,
   * and overwriting it would make the field flicker for no gain.
   */
  const touched = useRef(Boolean(suggestedFilename))
  const [dir, setDir] = useState<string | null>(null)
  const [categoryId, setCategoryId] = useState<string>('')
  const [queueId, setQueueId] = useState<string>('')
  const [description, setDescription] = useState('')

  useEffect(() => {
    let cancelled = false

    window.api
      .probe(url, headers)
      .then((result) => {
        if (cancelled) return
        setProbe(result)
        setFilename((current) => (touched.current ? current : result.filename))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setProbeError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
    }
  }, [url, headers])

  async function browse(): Promise<void> {
    const chosen = await window.api.chooseDirectory(dir ?? undefined)
    if (chosen) setDir(chosen)
  }

  async function start(autoStart: boolean): Promise<void> {
    const input: NewDownload = {
      url,
      filename: filename.trim() || undefined,
      dir: dir ?? undefined,
      categoryId: categoryId || null,
      queueId: queueId || null,
      headers,
      description: description.trim(),
      autoStart
    }

    try {
      await window.api.addDownload(input)
      onClose()
    } catch (err) {
      reportError('Could not add the download', err)
    }
  }

  return (
    <Dialog
      title={fromBrowser ? 'Download file info' : 'Save as'}
      subtitle={hostOf(url) || url}
      width={560}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <GhostButton onClick={() => void start(false)}>Download later</GhostButton>
          <PrimaryButton onClick={() => void start(true)}>Start download</PrimaryButton>
        </>
      }
    >
      <div className="space-y-3.5">
        <div>
          <label className="label">File name</label>
          <input
            value={filename}
            onChange={(event) => {
              touched.current = true
              setFilename(event.target.value)
            }}
            spellCheck={false}
            className="field text-[12.5px]"
          />
        </div>

        <div>
          <label className="label">Save to</label>
          <button
            onClick={() => void browse()}
            className="field text-left text-[12.5px] flex items-center gap-2 hover:bg-white/[0.06] transition-colors"
          >
            <FolderIcon className="w-4 h-4 text-faint shrink-0" />
            <span className={'truncate ' + (dir ? '' : 'text-faint')}>
              {dir ?? 'Automatic — filed into its category folder'}
            </span>
          </button>
          {dir && (
            <button
              onClick={() => setDir(null)}
              className="mt-1.5 text-[11px] text-faint hover:text-ink transition-colors"
            >
              Use the category folder instead
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Category</label>
            <select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              className="field text-[12.5px]"
            >
              <option value="">Automatic (by extension)</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Queue</label>
            <select
              value={queueId}
              onChange={(event) => setQueueId(event.target.value)}
              className="field text-[12.5px]"
            >
              <option value="">None</option>
              {queues.map((queue) => (
                <option key={queue.id} value={queue.id}>
                  {queue.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label">Description</label>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional"
            className="field text-[12.5px]"
          />
        </div>

        <ServerInfo probe={probe} error={probeError} knownSize={knownSize ?? null} />

        {fromBrowser && (
          // Worth saying plainly: the browser's own download was already
          // cancelled to hand this over, so Cancel here means no download at
          // all rather than "let the browser do it".
          <p className="text-[11px] text-faint leading-relaxed">
            The browser has handed this over. Cancelling here means the file is not downloaded at
            all.
          </p>
        )}
      </div>
    </Dialog>
  )
}

function ServerInfo({
  probe,
  error,
  knownSize
}: {
  probe: ProbeResult | null
  error: string | null
  knownSize: number | null
}): React.ReactElement {
  if (error) {
    return (
      <div className="rounded-lg px-3 py-2.5 text-[11.5px] leading-relaxed border border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.08)] text-warn">
        Could not read the file details: {error}
        <div className="text-faint mt-1">
          You can still start the download — the engine will try again on its own.
        </div>
      </div>
    )
  }

  if (!probe) {
    return (
      <div className="rounded-lg px-3 py-2.5 text-[11.5px] text-faint border border-line bg-white/[0.02]">
        Asking the server about this file…
        {knownSize ? (
          <span className="tnum"> The browser said {formatBytes(knownSize)}.</span>
        ) : null}
      </div>
    )
  }

  return (
    <div className="rounded-lg px-3 py-2.5 border border-line bg-white/[0.02] grid grid-cols-3 gap-y-1.5 text-[11.5px]">
      <Fact label="Size" value={formatBytes(probe.size ?? knownSize)} />
      <Fact
        label="Resume"
        value={probe.resumable ? 'Supported' : 'Not supported'}
        tone={probe.resumable ? 'ok' : 'warn'}
      />
      <Fact label="Type" value={probe.mimeType ?? '—'} />
    </div>
  )
}

function Fact({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone?: 'ok' | 'warn'
}): React.ReactElement {
  return (
    <div className="min-w-0">
      <div className="text-faint text-[10px] uppercase tracking-[0.4px]">{label}</div>
      <div
        className="truncate tnum"
        title={value}
        style={{
          color: tone === 'ok' ? 'var(--color-ok)' : tone === 'warn' ? 'var(--color-warn)' : undefined
        }}
      >
        {value}
      </div>
    </div>
  )
}

/** A name to show while the probe is still in flight. */
function fallbackName(url: string): string {
  try {
    const path = decodeURIComponent(new URL(url).pathname)
    const last = path.split('/').filter(Boolean).pop()
    return last || 'download'
  } catch {
    return 'download'
  }
}
