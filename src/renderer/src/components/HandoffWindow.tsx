import { useEffect, useRef, useState } from 'react'
import type {
  Category,
  HandoffRequest,
  MediaVariant,
  ProbeResult,
  Queue,
  Settings
} from '@shared/types'
import { formatBytes, hostOf } from '../lib/format'
import { applyAccent } from '../store/app'
import { BrandMark, CloseGlyph, DownloadIcon, FolderIcon, VideoIcon } from './Icons'
import { GhostButton, PrimaryButton } from './Dialog'

/**
 * IDM's download dialog, as its own window.
 *
 * It asks one question - where is this going, and do you want it now - and then
 * gets out of the way. It deliberately does not depend on the main window
 * existing: the host can cold-start Draco to service a click, and this has to
 * be able to answer before the download list has finished loading.
 */

export default function HandoffWindow({ id }: { id: string }): React.ReactElement {
  const [request, setRequest] = useState<HandoffRequest | null>(null)
  const [gone, setGone] = useState(false)

  const [categories, setCategories] = useState<Category[]>([])
  const [queues, setQueues] = useState<Queue[]>([])

  useEffect(() => {
    void (async () => {
      const [found, cats, qs, settings] = await Promise.all([
        window.api.getHandoff(id).catch(() => null),
        window.api.listCategories().catch(() => [] as Category[]),
        window.api.listQueues().catch(() => [] as Queue[]),
        window.api.getSettings().catch(() => null as Settings | null)
      ])

      if (settings) applyAccent(settings.accent)
      setCategories(cats)
      setQueues(qs)

      if (!found) setGone(true)
      else setRequest(found)
    })()
  }, [id])

  const dismiss = (): void => {
    void window.api.dismissHandoff(id)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  return (
    <div className="app-bg h-full flex flex-col overflow-hidden border border-line-strong">
      <span
        className="bloom w-[300px] h-[300px] -top-[140px] -left-[80px] opacity-[0.18]"
        style={{ background: 'var(--accent)' }}
      />

      <header className="drag h-9 shrink-0 flex items-center gap-2.5 pl-3 pr-1 border-b border-line bg-white/[0.02]">
        <BrandMark className="w-4 h-4" />
        <span className="font-display text-[12.5px] font-bold tracking-[0.3px]">
          {request?.kind === 'media' ? 'Download video' : 'Download file'}
        </span>
        <div className="flex-1" />
        <button
          onClick={dismiss}
          aria-label="Cancel"
          className="no-drag w-9 h-9 grid place-items-center text-muted hover:bg-[#e81123] hover:text-white transition-colors"
        >
          <CloseGlyph />
        </button>
      </header>

      {gone || !request ? (
        <Placeholder gone={gone} />
      ) : request.kind === 'media' ? (
        <MediaBody request={request} categories={categories} queues={queues} onCancel={dismiss} />
      ) : (
        <FileBody request={request} categories={categories} queues={queues} onCancel={dismiss} />
      )}
    </div>
  )
}

function Placeholder({ gone }: { gone: boolean }): React.ReactElement {
  return (
    <div className="flex-1 grid place-items-center text-center px-8">
      <p className="text-[12.5px] text-faint">
        {gone ? 'This request has already been dealt with.' : 'Loading…'}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* An ordinary file                                                    */
/* ------------------------------------------------------------------ */

function FileBody({
  request,
  categories,
  queues,
  onCancel
}: {
  request: HandoffRequest
  categories: Category[]
  queues: Queue[]
  onCancel(): void
}): React.ReactElement {
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [filename, setFilename] = useState(request.filename || fallbackName(request.url))
  const touched = useRef(Boolean(request.filename))
  const [dir, setDir] = useState<string | null>(null)
  const [categoryId, setCategoryId] = useState('')
  const [queueId, setQueueId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    // Probed with the captured cookies and referer. An anonymous probe of a
    // session-gated URL reports a broken file that downloads perfectly.
    window.api
      .probe(request.url, request.headers)
      .then((result) => {
        if (cancelled) return
        setProbe(result)
        setFilename((current) => (touched.current ? current : result.filename))
      })
      .catch((err: unknown) => {
        if (!cancelled) setProbeError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
    }
  }, [request])

  async function accept(autoStart: boolean): Promise<void> {
    setBusy(true)
    try {
      await window.api.acceptHandoff(request.id, {
        url: request.url,
        filename: filename.trim() || undefined,
        dir: dir ?? undefined,
        categoryId: categoryId || null,
        queueId: queueId || null,
        autoStart
      })
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3.5">
        <Source url={request.url} title={request.pageTitle} />

        <Field label="File name">
          <input
            value={filename}
            autoFocus
            onChange={(event) => {
              touched.current = true
              setFilename(event.target.value)
            }}
            spellCheck={false}
            className="field text-[12.5px]"
          />
        </Field>

        <SaveTo dir={dir} onPick={setDir} />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
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
          </Field>

          <Field label="Queue">
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
          </Field>
        </div>

        <ServerInfo probe={probe} error={probeError} knownSize={request.size} />
        {error && <ErrorNote message={error} />}
      </div>

      <Footer>
        <GhostButton onClick={onCancel}>Cancel</GhostButton>
        <GhostButton onClick={() => void accept(false)} disabled={busy}>
          Download later
        </GhostButton>
        <PrimaryButton onClick={() => void accept(true)} disabled={busy}>
          Start download
        </PrimaryButton>
      </Footer>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* A video                                                             */
/* ------------------------------------------------------------------ */

function MediaBody({
  request,
  categories,
  queues,
  onCancel
}: {
  request: HandoffRequest
  categories: Category[]
  queues: Queue[]
  onCancel(): void
}): React.ReactElement {
  const [variants, setVariants] = useState<MediaVariant[] | null>(null)
  const [chosen, setChosen] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [filename, setFilename] = useState(() => suggestName(request, null))
  const touched = useRef(false)
  const [dir, setDir] = useState<string | null>(null)
  const [categoryId, setCategoryId] = useState('')
  const [queueId, setQueueId] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false

    // Qualities are read here rather than when the stream was spotted: reaching
    // out to a CDN for every video someone scrolls past would announce Draco to
    // half the internet. A press of the button is the consent to look.
    window.api
      .resolveHandoffMedia(request.id)
      .then((candidate) => {
        if (cancelled) return
        setVariants(candidate.variants)
        if (!touched.current) setFilename(suggestName(request, candidate.variants[0] ?? null))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
    }
  }, [request])

  const variant = variants?.[chosen] ?? null

  async function accept(): Promise<void> {
    if (!variant) return
    setBusy(true)
    try {
      await window.api.acceptHandoffMedia(request.id, {
        variantUrl: variant.url,
        filename: filename.trim() || 'video.mp4',
        dir: dir ?? undefined,
        categoryId: categoryId || undefined,
        queueId: queueId || undefined,
        audioUrl: variant.audioUrl ?? null
      })
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3.5">
        <Source url={request.pageUrl ?? request.url} title={request.pageTitle} media />

        <Field label="Quality">
          {error ? (
            <ErrorNote message={error} />
          ) : !variants ? (
            <div className="field text-[12.5px] text-faint">Reading the stream…</div>
          ) : variants.length === 0 ? (
            <ErrorNote message="The playlist offered nothing that can be downloaded." />
          ) : (
            <select
              value={chosen}
              onChange={(event) => {
                const next = Number(event.target.value)
                setChosen(next)
                if (!touched.current) setFilename(suggestName(request, variants[next]))
              }}
              className="field text-[12.5px]"
            >
              {variants.map((entry, index) => (
                <option key={entry.url + index} value={index}>
                  {entry.label}
                  {entry.bandwidth ? ` · ${Math.round(entry.bandwidth / 1000)} kbps` : ''}
                  {entry.estimatedSize ? ` · ${formatBytes(entry.estimatedSize)}` : ''}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="File name">
          <input
            value={filename}
            onChange={(event) => {
              touched.current = true
              setFilename(event.target.value)
            }}
            spellCheck={false}
            className="field text-[12.5px]"
          />
        </Field>

        <SaveTo dir={dir} onPick={setDir} />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
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
          </Field>

          <Field label="Queue">
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
          </Field>
        </div>
      </div>

      <Footer>
        <GhostButton onClick={onCancel}>Cancel</GhostButton>
        <PrimaryButton onClick={() => void accept()} disabled={busy || !variant}>
          Start download
        </PrimaryButton>
      </Footer>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Shared bits                                                         */
/* ------------------------------------------------------------------ */

function Footer({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="shrink-0 px-5 py-3.5 border-t border-line flex items-center justify-end gap-2 bg-white/[0.02]">
      {children}
    </div>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  )
}

function Source({
  url,
  title,
  media
}: {
  url: string
  title?: string
  media?: boolean
}): React.ReactElement {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className="w-8 h-8 rounded-lg grid place-items-center shrink-0"
        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
      >
        {media ? <VideoIcon className="w-4 h-4" /> : <DownloadIcon className="w-4 h-4" />}
      </span>
      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold truncate" title={title || url}>
          {title || hostOf(url) || url}
        </div>
        <div className="text-[11px] text-faint truncate" title={url}>
          {url}
        </div>
      </div>
    </div>
  )
}

function SaveTo({
  dir,
  onPick
}: {
  dir: string | null
  onPick(next: string | null): void
}): React.ReactElement {
  return (
    <div>
      <label className="label">Save to</label>
      <button
        onClick={() => {
          void window.api.chooseDirectory(dir ?? undefined).then((chosen) => {
            if (chosen) onPick(chosen)
          })
        }}
        className="field text-left text-[12.5px] flex items-center gap-2 hover:bg-white/[0.06] transition-colors"
      >
        <FolderIcon className="w-4 h-4 text-faint shrink-0" />
        <span className={'truncate ' + (dir ? '' : 'text-faint')}>
          {dir ?? 'Automatic — filed into its category folder'}
        </span>
      </button>
      {dir && (
        <button
          onClick={() => onPick(null)}
          className="mt-1.5 text-[11px] text-faint hover:text-ink transition-colors"
        >
          Use the category folder instead
        </button>
      )}
    </div>
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
          You can still start it — the engine tries again on its own.
        </div>
      </div>
    )
  }

  if (!probe) {
    return (
      <div className="rounded-lg px-3 py-2.5 text-[11.5px] text-faint border border-line bg-white/[0.02]">
        Asking the server about this file…
        {knownSize ? <span className="tnum"> The browser said {formatBytes(knownSize)}.</span> : null}
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

function ErrorNote({ message }: { message: string }): React.ReactElement {
  return (
    <div className="rounded-lg px-3 py-2.5 text-[11.5px] leading-relaxed border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.08)] text-err">
      {message}
    </div>
  )
}

function fallbackName(url: string): string {
  try {
    const path = decodeURIComponent(new URL(url).pathname)
    return path.split('/').filter(Boolean).pop() || 'download'
  } catch {
    return 'download'
  }
}

/** A video's name comes from the page title; a playlist URL never describes it. */
function suggestName(request: HandoffRequest, variant: MediaVariant | null): string {
  let base = (request.pageTitle || hostOf(request.pageUrl ?? request.url) || 'video')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 80)

  // Strip generic site suffixes from titles to make cleaner filenames
  base = base.replace(/\s*-\s*(YouTube|Vimeo|Twitch|Dailymotion)$/i, '').trim()

  const quality = variant?.height ? ' ' + variant.height + 'p' : ''
  const baseName = (base || 'video') + quality

  const url = variant?.url || request.url || ''
  let ext = '.mp4'
  if (/\.mkv(\?|$)/i.test(url)) ext = '.mkv'
  else if (/\.webm(\?|$)/i.test(url)) ext = '.webm'
  else if (/\.ts(\?|$)/i.test(url)) ext = '.ts'

  return baseName + ext
}
