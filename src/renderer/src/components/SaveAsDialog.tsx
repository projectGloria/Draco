import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardItem, MediaVariant, NewDownload, ProbeResult, RequestHeaders, YouTubeResolution } from '@shared/types'
import { formatBytes, hostOf, looksLikeYouTubeInput } from '../lib/format'
import { useApp } from '../store/app'
import { reportError } from '../store/toasts'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import FileIcon from './FileIcon'
import { FolderIcon, TorrentIcon } from './Icons'

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
  clipboardItem,
  onAdded,
  onClose
}: {
  url: string
  /** The name the browser had already chosen, when this came from a handoff. */
  suggestedFilename?: string
  headers?: RequestHeaders
  knownSize?: number | null
  fromBrowser?: boolean
  clipboardItem?: ClipboardItem
  onAdded?(): void
  onClose(): void
}): React.ReactElement {
  const categories = useApp((s) => s.categories)
  const queues = useApp((s) => s.queues)

  const [probe, setProbe] = useState<ProbeResult | null>(clipboardItem?.probe ?? null)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [probeRetry, setProbeRetry] = useState(0)
  const preparedMedia = clipboardItem?.youtube ?? clipboardItem?.media
  const [filename, setFilename] = useState(
    suggestedFilename ||
    (preparedMedia
      ? youtubeFilename(preparedMedia.title, preparedMedia.variants[0] ?? null)
      : clipboardItem?.probe?.filename) ||
    fallbackName(url)
  )
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
  const [expectedChecksum, setExpectedChecksum] = useState('')
  const [postProcess, setPostProcess] = useState<'none' | 'mp4' | 'mp3'>('none')
  const [selectedFiles, setSelectedFiles] = useState<Set<string> | null>(null)
  const [youtube, setYoutube] = useState<YouTubeResolution | null>(preparedMedia ?? null)
  const [youtubeVariantIndex, setYoutubeVariantIndex] = useState(0)
  const [selectedMediaIndices, setSelectedMediaIndices] = useState<Set<number>>(
    () => new Set((preparedMedia?.variants ?? []).map((_variant, index) => index))
  )
  const [detectedMedia, setDetectedMedia] = useState(clipboardItem?.kind === 'media')
  const torrentSelectionEmpty = selectedFiles !== null && selectedFiles.size === 0
  const torrentMode = isTorrentInput(url) || probe?.torrentFiles !== undefined
  const youtubeMode = looksLikeYouTubeInput(url)
  const mediaMode = youtubeMode || detectedMedia || clipboardItem?.kind === 'media'
  const pageAssetMode = mediaMode && !youtubeMode
  const youtubeVariant = youtube?.variants[youtubeVariantIndex] ?? null
  const cannotStart = torrentSelectionEmpty ||
    (pageAssetMode ? selectedMediaIndices.size === 0 : mediaMode && !youtubeVariant)

  useEffect(() => {
    if (probe?.torrentFiles) {
      setSelectedFiles(new Set(probe.torrentFiles.map(f => f.path)))
    }
  }, [probe])

  useEffect(() => {
    let cancelled = false

    // YouTube extraction results are a stable quality ladder, but ordinary
    // pages are snapshots of mutable HTML. Always re-scan those when opened;
    // this also upgrades clipboard entries saved by an older detector instead
    // of showing their stale one-image result forever.
    if (youtubeMode && preparedMedia) return
    if (!mediaMode && clipboardItem?.probe) return

    if (youtubeMode) {
      window.api
        .resolveYouTube(url)
        .then((result) => {
          if (cancelled) return
          setYoutube(result)
          setSelectedMediaIndices(new Set(result.variants.map((_variant, index) => index)))
          const first = result.variants[0] ?? null
          setFilename((current) => (touched.current ? current : youtubeFilename(result.title, first)))
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setProbeError(err instanceof Error ? err.message : String(err))
        })

      return () => {
        cancelled = true
      }
    }

    if (mediaMode) {
      setYoutube(null)
      setSelectedMediaIndices(new Set())
      window.api
        .resolveMediaPage(url, headers)
        .then((result) => {
          if (cancelled) return
          setYoutube(result)
          setSelectedMediaIndices(new Set(result.variants.map((_variant, index) => index)))
          const first = result.variants[0] ?? null
          setFilename((current) => (touched.current ? current : youtubeFilename(result.title, first)))
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setProbeError(err instanceof Error ? err.message : String(err))
        })

      return () => {
        cancelled = true
      }
    }

    window.api
      .probe(url, headers)
      .then(async (result) => {
        if (cancelled) return
        if (isHtmlPage(result.mimeType)) {
          setDetectedMedia(true)
          setProbe(null)
          const media = await window.api.resolveMediaPage(url, headers)
          if (cancelled) return
          setYoutube(media)
          setSelectedMediaIndices(new Set(media.variants.map((_variant, index) => index)))
          const first = media.variants[0] ?? null
          setFilename((current) => (touched.current ? current : youtubeFilename(media.title, first)))
          return
        }
        setProbe(result)
        setFilename((current) => (touched.current ? current : result.filename))
      })
      .catch(async (err: unknown) => {
        if (cancelled) return
        // A normal page can reject HEAD/ranged file probes even though its
        // HTML and embedded player remain available. Treat probe failure as a
        // signal to inspect page media before showing an error to the user.
        if (couldBeHtmlPage(url)) {
          try {
            const media = await window.api.resolveMediaPage(url, headers)
            if (cancelled) return
            setDetectedMedia(true)
            setProbe(null)
            setYoutube(media)
            setSelectedMediaIndices(new Set(media.variants.map((_variant, index) => index)))
            const first = media.variants[0] ?? null
            setFilename((current) => (touched.current ? current : youtubeFilename(media.title, first)))
            return
          } catch {}
        }
        setProbeError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
    }
  }, [url, headers, youtubeMode, mediaMode, clipboardItem, preparedMedia, probeRetry])

  async function browse(): Promise<void> {
    const chosen = await window.api.chooseDirectory(dir ?? undefined)
    if (chosen) setDir(chosen)
  }

  async function start(autoStart: boolean): Promise<void> {
    if (pageAssetMode) {
      if (!youtube || selectedMediaIndices.size === 0) return
      const groupName = pageGroupName(youtube.title, url)
      const grouped = selectedMediaIndices.size > 1
      const groupId = grouped ? window.crypto.randomUUID() : undefined
      const inputs = youtube.variants
        .map((variant, index) => ({ variant, index }))
        .filter(({ index }) => selectedMediaIndices.has(index))
        .map(({ variant }): NewDownload => ({
          url: variant.url || url,
          sourceUrl: url,
          groupId,
          groupName: grouped ? groupName : undefined,
          groupFolder: grouped ? groupName : undefined,
          audioUrl: variant.audioUrl ?? null,
          audioTracks: variant.audioTracks,
          youtube: variant.youtube
            ? {
                pageUrl: url,
                videoFormatId: variant.youtube.videoFormatId,
                audioFormatId: variant.youtube.audioFormatId ?? null,
                height: variant.height,
                role: variant.youtube.role ?? 'video'
              }
            : undefined,
          filename: smartPageFilename(groupName, variant),
          dir: dir ?? undefined,
          categoryId: categoryId || null,
          queueId: queueId || null,
          headers: headers ?? { referer: url },
          description: description.trim(),
          autoStart,
          suppressProgressWindow: clipboardItem !== undefined
        }))

      try {
        await window.api.addDownloads(inputs)
        onAdded?.()
        onClose()
      } catch (err) {
        reportError('Could not add the downloads', err)
      }
      return
    }

    if (mediaMode && !youtubeVariant) return

    const input: NewDownload = {
      url: youtubeVariant?.url || url,
      sourceUrl: mediaMode ? url : undefined,
      audioUrl: youtubeVariant?.audioUrl ?? null,
      audioTracks: youtubeVariant?.audioTracks,
      youtube: youtubeVariant?.youtube
        ? {
            pageUrl: url,
            videoFormatId: youtubeVariant.youtube.videoFormatId,
            audioFormatId: youtubeVariant.youtube.audioFormatId ?? null,
            height: youtubeVariant.height,
            role: youtubeVariant.youtube.role ?? 'video'
          }
        : undefined,
      filename: filename.trim() || undefined,
      dir: dir ?? undefined,
      categoryId: categoryId || null,
      queueId: queueId || null,
      headers: headers ?? (mediaMode ? { referer: url } : undefined),
      description: description.trim(),
      expectedChecksum: expectedChecksum.trim() || undefined,
      autoStart,
      suppressProgressWindow: clipboardItem !== undefined,
      postProcess: postProcess === 'none' ? undefined : postProcess,
      selectedFiles: selectedFiles ? Array.from(selectedFiles) : undefined,
      torrentFiles: probe?.torrentFiles
    }

    try {
      await window.api.addDownload(input)
      onAdded?.()
      onClose()
    } catch (err) {
      reportError('Could not add the download', err)
    }
  }

  return (
    <Dialog
      title={torrentMode ? 'Add torrent' : youtubeMode ? 'Download YouTube video' : mediaMode ? 'Download media' : fromBrowser ? 'Download file info' : 'Save as'}
      subtitle={hostOf(url) || url}
      width={torrentMode ? 1100 : pageAssetMode ? 760 : 560}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <GhostButton disabled={cannotStart} onClick={() => void start(false)}>
            {pageAssetMode ? `Add ${selectedMediaIndices.size} later` : 'Download later'}
          </GhostButton>
          <PrimaryButton disabled={cannotStart} onClick={() => void start(true)}>
            {pageAssetMode ? `Start ${selectedMediaIndices.size} download${selectedMediaIndices.size === 1 ? '' : 's'}` : 'Start download'}
          </PrimaryButton>
        </>
      }
    >
      <div
        className={
          torrentMode
            ? 'grid grid-cols-[minmax(0,0.9fr)_minmax(420px,1.1fr)] gap-5 items-stretch'
            : ''
        }
      >
        <div className="space-y-3.5 min-w-0">
        {mediaMode && (
          <div>
            <label className="label">{pageAssetMode ? 'Page contents' : 'Quality'}</label>
            {probeError ? (
              <div className="rounded-lg px-3 py-2.5 text-[11.5px] leading-relaxed border border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.08)] text-warn">
                Could not find downloadable media: {probeError}
              </div>
            ) : !youtube ? (
              <MediaLoadingState phase={pageAssetMode ? 'page' : 'qualities'} />
            ) : youtube.variants.length === 0 ? (
              <div className="field text-[12.5px] text-warn">
                {pageAssetMode ? 'No downloadable files were found.' : 'No downloadable qualities were found.'}
              </div>
            ) : pageAssetMode ? (
              <PageAssetSelection
                variants={youtube.variants}
                selected={selectedMediaIndices}
                onSelectionChange={setSelectedMediaIndices}
              />
            ) : (
              <select
                value={youtubeVariantIndex}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  setYoutubeVariantIndex(next)
                  if (!touched.current) setFilename(youtubeFilename(youtube.title, youtube.variants[next] ?? null))
                }}
                className="field text-[12.5px]"
              >
                {youtube.variants.map((variant, index) => (
                  <option key={`${variant.youtube?.videoFormatId ?? index}-${variant.youtube?.audioFormatId ?? ''}`} value={index}>
                    {variant.label} · {youtubeContainer(variant).toUpperCase()}
                    {variant.estimatedSize ? ` · ≈ ${formatBytes(variant.estimatedSize)}` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
        {!pageAssetMode && <div>
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
        </div>}

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

        <div className="grid grid-cols-2 max-[560px]:grid-cols-1 gap-3">
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

        {!pageAssetMode && <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Checksum (optional)</label>
            <input
              value={expectedChecksum}
              onChange={(event) => setExpectedChecksum(event.target.value)}
              placeholder="MD5, SHA-1, or SHA-256 hash"
              spellCheck={false}
              className="field text-[12.5px] font-mono placeholder:font-sans"
            />
          </div>
          <div>
            <label className="label">Post-Processing</label>
            <select
              value={postProcess}
              onChange={(event) => setPostProcess(event.target.value as any)}
              className="field text-[12.5px]"
            >
              <option value="none">None</option>
              <option value="mp4">Convert to MP4 (FFmpeg)</option>
              <option value="mp3">Convert to MP3 (FFmpeg)</option>
            </select>
          </div>
        </div>}

          {!mediaMode && <ServerInfo probe={probe} error={probeError} knownSize={knownSize ?? null} />}

          {fromBrowser && (
            <div className="text-faint text-[11px] text-center italic mt-2">
              If you cancel, you will have to restart the download yourself.
            </div>
          )}
        </div>

        {torrentMode && (
          <TorrentContents
            files={probe?.torrentFiles ?? null}
            selectedFiles={selectedFiles}
            error={probeError}
            onSelectionChange={setSelectedFiles}
            onRetry={() => {
              setProbeError(null)
              setProbe(null)
              setSelectedFiles(null)
              setProbeRetry((value) => value + 1)
            }}
          />
        )}
      </div>
    </Dialog>
  )
}

function couldBeHtmlPage(value: string): boolean {
  try {
    const url = new URL(value)
    if (!/^https?:$/.test(url.protocol)) return false
    return !/\.(?:torrent|zip|rar|7z|exe|msi|dmg|iso|pdf|mp4|webm|mkv|mov|m4v|m3u8|mpd|mp3|m4a|aac|opus|ogg|flac|wav|jpe?g|png|gif|webp|svg)(?:$|[?#])/i.test(url.pathname)
  } catch {
    return false
  }
}

function PageAssetSelection({
  variants,
  selected,
  onSelectionChange
}: {
  variants: MediaVariant[]
  selected: Set<number>
  onSelectionChange(next: Set<number>): void
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const [sizeDirection, setSizeDirection] = useState<'none' | 'desc' | 'asc'>('none')
  const selectedSize = variants.reduce(
    (total, variant, index) => total + (selected.has(index) ? variant.estimatedSize ?? 0 : 0),
    0
  )
  const unknownSizes = variants.some((variant, index) => selected.has(index) && !variant.estimatedSize)
  const visible = useMemo(() => variants
    .map((variant, index) => ({ variant, index }))
    .filter(({ variant }) => {
      const needle = query.trim().toLowerCase()
      return !needle || `${variant.label} ${mediaVariantName(variant)} ${variant.url}`.toLowerCase().includes(needle)
    })
    .sort((a, b) => {
      if (sizeDirection === 'none') return a.index - b.index
      const difference = (a.variant.estimatedSize ?? -1) - (b.variant.estimatedSize ?? -1)
      return sizeDirection === 'asc' ? difference : -difference
    }), [variants, query, sizeDirection])
  return (
    <section className="border border-line rounded-lg bg-white/[0.02] overflow-hidden">
      <div className="px-3.5 py-2.5 bg-white/[0.04] border-b border-line flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold">Page downloads</div>
          <div className="text-[10.5px] text-faint tnum mt-0.5">
            {selected.size} of {variants.length} selected
            {selectedSize > 0 ? ` · ${formatBytes(selectedSize)}${unknownSizes ? ' + unknown' : ''}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.3px]">
          <button
            className="text-faint hover:text-ink transition-colors"
            onClick={() => onSelectionChange(new Set(variants.map((_variant, index) => index)))}
          >
            Select all
          </button>
          <button
            className="text-faint hover:text-ink transition-colors"
            onClick={() => onSelectionChange(new Set())}
          >
            Select none
          </button>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-line bg-black/10">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search fetched files…"
          className="field !py-1.5 text-[11.5px]"
          spellCheck={false}
        />
      </div>

      <div className="grid grid-cols-[24px_minmax(0,1fr)_90px_70px] px-3 py-2 border-b border-line text-[10px] uppercase tracking-[0.4px] text-faint">
        <span />
        <span>Asset</span>
        <button
          className="text-right hover:text-ink transition-colors"
          title="Order by size"
          onClick={() => setSizeDirection((current) => current === 'none' ? 'desc' : current === 'desc' ? 'asc' : 'none')}
        >
          Size {sizeDirection === 'desc' ? '↓' : sizeDirection === 'asc' ? '↑' : '↕'}
        </button>
        <span className="text-right">Format</span>
      </div>

      <div className="max-h-[300px] overflow-y-auto p-1.5 text-[11.5px]">
        {visible.length === 0 && (
          <div className="py-8 text-center text-faint">No fetched files match “{query}”.</div>
        )}
        {visible.map(({ variant, index }) => {
          const name = mediaVariantName(variant)
          return (
            <label
              key={`${variant.url}-${variant.audioUrl ?? ''}-${index}`}
              className="grid grid-cols-[24px_18px_minmax(0,1fr)_90px_70px] items-center gap-2 px-2 py-2 hover:bg-white/[0.04] rounded cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.has(index)}
                onChange={(event) => {
                  const next = new Set(selected)
                  if (event.target.checked) next.add(index)
                  else next.delete(index)
                  onSelectionChange(next)
                }}
              />
              <FileIcon name={name} className="w-4 h-4" />
              <span className="truncate" title={variant.url || variant.label}>{variant.label || name}</span>
              <span className="text-right text-faint tnum">
                {variant.estimatedSize ? formatBytes(variant.estimatedSize) : '—'}
              </span>
              <span className="text-right uppercase text-faint">{youtubeContainer(variant)}</span>
            </label>
          )
        })}
      </div>
    </section>
  )
}

function MediaLoadingState({ phase }: { phase: 'page' | 'qualities' | 'file' }): React.ReactElement {
  const title = phase === 'page'
    ? 'Inspecting page and embedded players'
    : phase === 'qualities'
      ? 'Reading available qualities'
      : 'Connecting and reading file details'
  const detail = phase === 'page'
    ? 'Following media sources, checking formats, and measuring file sizes…'
    : phase === 'qualities'
      ? 'Building the best-quality download ladder…'
      : 'Checking the server, file size, type, and resume support…'
  return (
    <div className="media-loader rounded-xl border border-line overflow-hidden px-5 py-5 flex items-center gap-4">
      <div className="relative w-11 h-11 shrink-0" aria-hidden="true">
        <span className="absolute inset-0 rounded-full border border-[var(--accent-line)] animate-ping opacity-40" />
        <span className="absolute inset-1 rounded-full border-2 border-transparent border-t-[var(--accent)] border-r-[var(--accent-2)] animate-spin" />
        <span className="absolute inset-[15px] rounded-full" style={{ background: 'var(--grad)' }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold">
          {title}
        </div>
        <div className="text-[11px] text-faint mt-1">
          {detail}
        </div>
        <div className="h-1 mt-3 rounded-full bg-white/[0.06] overflow-hidden">
          <span className="loading-sweep block h-full w-1/3 rounded-full" style={{ background: 'var(--grad)' }} />
        </div>
      </div>
    </div>
  )
}

function mediaVariantName(variant: MediaVariant): string {
  try {
    return decodeURIComponent(new URL(variant.url).pathname.split('/').filter(Boolean).pop() || '') || variant.label
  } catch {
    return variant.label || 'download'
  }
}

function pageGroupName(title: string, pageUrl: string): string {
  let value = title.trim()
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, '').split('.')[0]
    value = value.replace(new RegExp(`\\s*[-–—|:]\\s*${escapeRegExp(host)}(?:\\.com)?\\s*$`, 'i'), '')
  } catch {}
  return safeFilenamePart(value || 'Page downloads').slice(0, 100) || 'Page downloads'
}

function smartPageFilename(groupName: string, variant: MediaVariant): string {
  const original = mediaVariantName(variant) || 'download'
  const dot = original.lastIndexOf('.')
  const stem = dot > 0 ? original.slice(0, dot) : original
  const extension = dot > 0 ? original.slice(dot).toLowerCase() : `.${youtubeContainer(variant)}`
  const generic = /^(?:\d{1,4}p?|video|audio|image|file|download|index|master|playlist|source|main)$/i.test(stem)
  if (!generic) return safeFilenamePart(original)
  const quality = /^(\d{3,4})p?$/i.exec(stem)?.[1]
  return `${groupName}${quality ? ` - ${quality}p` : ` - ${stem}`}${extension}`
}

function safeFilenamePart(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function TorrentContents({
  files,
  selectedFiles,
  error,
  onSelectionChange,
  onRetry
}: {
  files: ProbeResult['torrentFiles'] | null
  selectedFiles: Set<string> | null
  error: string | null
  onSelectionChange(next: Set<string>): void
  onRetry(): void
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const [sizeDirection, setSizeDirection] = useState<'none' | 'desc' | 'asc'>('none')
  const selectedCount = selectedFiles?.size ?? 0
  const selectedSize = files?.reduce(
    (sum, file) => sum + (selectedFiles?.has(file.path) ? file.size : 0),
    0
  ) ?? 0
  const visibleFiles = useMemo(() => (files ?? [])
    .filter((file) => !query.trim() || file.path.toLowerCase().includes(query.trim().toLowerCase()))
    .map((file, index) => ({ file, index }))
    .sort((a, b) => {
      if (sizeDirection === 'none') return a.index - b.index
      return sizeDirection === 'asc' ? a.file.size - b.file.size : b.file.size - a.file.size
    })
    .map(({ file }) => file), [files, query, sizeDirection])

  return (
    <section className="min-w-0 min-h-[480px] max-h-[62vh] border border-line rounded-lg bg-white/[0.02] overflow-hidden flex flex-col">
      <div className="px-3.5 py-3 bg-white/[0.04] border-b border-line flex items-center gap-2 shrink-0">
        <span className="text-[var(--accent)]">
          <TorrentIcon className="w-4 h-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold">Torrent contents</div>
          <div className="text-[10.5px] text-faint tnum mt-0.5">
            {files && selectedFiles
              ? `${selectedCount} of ${files.length} selected · ${formatBytes(selectedSize)}`
              : 'Waiting for metadata'}
          </div>
        </div>
        {files && selectedFiles && (
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.3px]">
            <button
              className="text-faint hover:text-ink transition-colors"
              onClick={() => onSelectionChange(new Set(files.map((file) => file.path)))}
            >
              Select all
            </button>
            <button
              className="text-faint hover:text-ink transition-colors"
              onClick={() => onSelectionChange(new Set())}
            >
              Select none
            </button>
          </div>
        )}
      </div>

      {files && selectedFiles && (
        <div className="px-3 py-2 border-b border-line bg-black/10 shrink-0">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search torrent files…"
            className="field !py-1.5 text-[11.5px]"
            spellCheck={false}
          />
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_100px] px-3 py-2 border-b border-line text-[10px] uppercase tracking-[0.4px] text-faint shrink-0">
        <span>Name</span>
        <button
          className="text-right hover:text-ink transition-colors"
          onClick={() => setSizeDirection((current) => current === 'none' ? 'desc' : current === 'desc' ? 'asc' : 'none')}
        >
          Size {sizeDirection === 'desc' ? '↓' : sizeDirection === 'asc' ? '↑' : '↕'}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 text-[11.5px]">
        {error ? (
          <div className="h-full grid place-items-center px-8 text-center text-warn leading-relaxed">
            <div>
              Could not load torrent contents.<br />{error}
              <button onClick={onRetry} className="block mx-auto mt-4 px-3 py-1.5 rounded-lg border border-line text-ink bg-white/[0.05] hover:bg-white/[0.1]">
                Try metadata again
              </button>
            </div>
          </div>
        ) : !files || !selectedFiles ? (
          <div className="h-full grid place-items-center px-8 text-center text-faint leading-relaxed">
            Finding peers and reading torrent metadata…
          </div>
        ) : files.length === 0 ? (
          <div className="h-full grid place-items-center text-faint">This torrent contains no files.</div>
        ) : visibleFiles.length === 0 ? (
          <div className="h-full grid place-items-center text-faint">No torrent files match “{query}”.</div>
        ) : (
          visibleFiles.map((file) => (
            <label
              key={file.path}
              className="grid grid-cols-[18px_18px_minmax(0,1fr)_100px] items-center gap-2 px-2 py-2 hover:bg-white/[0.04] rounded cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selectedFiles.has(file.path)}
                onChange={(event) => {
                  const next = new Set(selectedFiles)
                  if (event.target.checked) next.add(file.path)
                  else next.delete(file.path)
                  onSelectionChange(next)
                }}
              />
              <FileIcon name={file.path} className="w-4 h-4" />
              <span className="truncate" title={file.path}>{file.path}</span>
              <span className="text-faint tnum text-right">{formatBytes(file.size)}</span>
            </label>
          ))
        )}
      </div>
    </section>
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
    const sessionRequired = /\b(?:401|403|forbidden|unauthorized|browser session|captcha|cloudflare)\b/i.test(error)
    return (
      <div className="rounded-lg px-3 py-2.5 text-[11.5px] leading-relaxed border border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.08)] text-warn">
        Could not read the file details: {error}
        <div className="text-faint mt-1">
          {sessionRequired
            ? 'This address requires the active browser session. Start playback in your browser, then use Draco’s video Download button so it can capture the stream URL and session headers.'
            : 'You can still start the download — the engine will try again on its own.'}
        </div>
      </div>
    )
  }

  if (!probe) {
    return <MediaLoadingState phase="file" />
  }

  if (probe.torrentFiles) {
    return (
      <div className="rounded-lg px-3 py-2.5 border border-line bg-white/[0.02] grid grid-cols-3 gap-y-1.5 text-[11.5px]">
        <Fact label="Total size" value={formatBytes(probe.size ?? knownSize)} />
        <Fact label="Files" value={String(probe.torrentFiles.length)} />
        <Fact label="Type" value="BitTorrent" tone="ok" />
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

function isTorrentInput(value: string): boolean {
  const trimmed = value.trim()
  if (/^[0-9a-f]{40}$/i.test(trimmed) || /^magnet:\?/i.test(trimmed)) return true
  try {
    return /\.torrent$/i.test(new URL(trimmed).pathname)
  } catch {
    return false
  }
}

function youtubeContainer(variant: MediaVariant | null): string {
  if (variant?.container) return variant.container
  const match = /\.(mp4|mkv|webm|mov|m4v|mp3|m4a|aac|opus|ogg|flac|wav|jpg|jpeg|png|webp|gif|avif)(\?|#|$)/i.exec(variant?.url ?? '')
  return match?.[1].toLowerCase() ?? 'mp4'
}

function youtubeFilename(title: string, variant: MediaVariant | null): string {
  if (variant && !variant.youtube) {
    try {
      const fromUrl = decodeURIComponent(new URL(variant.url).pathname.split('/').filter(Boolean).pop() || '')
        .replace(/[\\/:*?"<>|]/g, '')
        .trim()
      if (fromUrl) return fromUrl
    } catch {}
  }
  const audio = variant?.youtube?.role === 'audio'
  const base = title
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s*-\s*YouTube$/i, '')
    .trim()
    .slice(0, 80) || (audio ? 'music' : 'video')
  const quality = variant?.height ? ` ${variant.height}p` : ''
  return `${base}${quality}.${youtubeContainer(variant)}`
}

function isHtmlPage(mimeType: string | null): boolean {
  return Boolean(mimeType && /^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(mimeType))
}
