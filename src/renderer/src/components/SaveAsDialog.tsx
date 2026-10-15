import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardItem, DuplicateMatch, MediaVariant, NewDownload, ProbeResult, RequestHeaders, YouTubeResolution } from '@shared/types'
import { formatBytes, formatWhen, hostOf, looksLikePlaylistInput, looksLikeYouTubeInput } from '../lib/format'
import { useT } from '../i18n'
import { useApp } from '../store/app'
import { reportError } from '../store/toasts'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import FileIcon from './FileIcon'
import { ChevronIcon, FolderIcon, TorrentIcon } from './Icons'
import { buildTorrentTree, selectTorrentPaths, type TorrentTreeNode } from '@shared/torrent-tree'
import { isXPage, xPostUrl } from '@shared/x-post'
import { youtubeThumbnailUrl } from '@shared/youtube-link'
import { useThumbnail } from '../lib/icons'

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
  onPlaylist,
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
  /** Hands a playlist link on to the dialog that can actually expand it. */
  onPlaylist?(url: string): void
  onClose(): void
}): React.ReactElement {
  const categories = useApp((s) => s.categories)
  const queues = useApp((s) => s.queues)
  const t = useT()

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
    () => defaultSelection(preparedMedia?.variants ?? [])
  )
  const [detectedMedia, setDetectedMedia] = useState(clipboardItem?.kind === 'media')
  /** An existing row this download would repeat. Advisory only. */
  const [duplicate, setDuplicate] = useState<DuplicateMatch | null>(null)
  const [adding, setAdding] = useState(false)
  const submission = useRef(false)
  const torrentSelectionEmpty = selectedFiles !== null && selectedFiles.size === 0
  const torrentMode = isTorrentInput(url) || probe?.torrentFiles !== undefined
  /*
   * A playlist or channel link is explicitly not this dialog's job.
   *
   * `looksLikeYouTubeInput` is true for one, so without this check the effect
   * below called `resolveYouTube`, which runs yt-dlp with `--no-playlist`. For
   * `/playlist?list=...` that comes back with no formats at all and the user
   * saw "YouTube may be requiring an additional browser/PO token" - a message
   * about something that had not happened. For `/watch?v=X&list=...` it quietly
   * resolved video X alone and the other thirty-nine were simply lost.
   *
   * `App` routes these to `PlaylistDialog` before they get here; this is the
   * backstop, so a new entry point that forgets fails visibly and recoverably
   * rather than silently.
   */
  const playlistMode = looksLikePlaylistInput(url)
  const youtubeMode = !playlistMode && looksLikeYouTubeInput(url)
  const xPostMode = Boolean(xPostUrl(url))
  const mediaMode = youtubeMode || isXPage(url) || detectedMedia || clipboardItem?.kind === 'media'
  const previewUrl = mediaMode ? youtube?.thumbnailUrl ?? youtubeThumbnailUrl(url) : null
  const preview = useThumbnail(previewUrl)
  const xPostHasAssets = Boolean(
    xPostMode &&
    youtube?.variants.some(
      (v) =>
        (v.container && ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(v.container.toLowerCase())) ||
        v.label.startsWith('Photo') ||
        v.label.startsWith('Video ')
    )
  )
  const pageAssetMode = (mediaMode && !youtubeMode && !xPostMode) || xPostHasAssets
  const youtubeVariant = youtube?.variants[youtubeVariantIndex] ?? null
  const cannotStart = adding || playlistMode || torrentSelectionEmpty ||
    (pageAssetMode ? selectedMediaIndices.size === 0 : mediaMode && !youtubeVariant)

  useEffect(() => {
    let cancelled = false
    void window.api
      .findDuplicate({ url, pageUrl: youtubeMode ? url : null })
      .then((match) => {
        if (!cancelled) setDuplicate(match)
      })
      .catch(() => {
        // A duplicate check that fails is not worth a message: the download
        // itself is unaffected.
      })
    return () => {
      cancelled = true
    }
  }, [url, youtubeMode])

  useEffect(() => {
    if (probe?.torrentFiles) {
      setSelectedFiles(new Set(probe.torrentFiles.map(f => f.path)))
    }
  }, [probe])

  useEffect(() => {
    let cancelled = false

    // Nothing to resolve: the notice below offers the playlist dialog instead.
    if (playlistMode) return

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
          setSelectedMediaIndices(defaultSelection(result.variants))
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
          setSelectedMediaIndices(defaultSelection(result.variants))
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
          setSelectedMediaIndices(defaultSelection(media.variants))
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
            setSelectedMediaIndices(defaultSelection(media.variants))
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
  }, [url, headers, playlistMode, youtubeMode, mediaMode, clipboardItem, preparedMedia, probeRetry])

  async function browse(): Promise<void> {
    const chosen = await window.api.chooseDirectory(dir ?? undefined)
    if (chosen) setDir(chosen)
  }

  async function start(autoStart: boolean): Promise<void> {
    if (submission.current || cannotStart) return
    submission.current = true
    setAdding(true)
    try {
      await add(autoStart)
    } finally {
      submission.current = false
      setAdding(false)
    }
  }

  async function add(autoStart: boolean): Promise<void> {
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
          thumbnailUrl: youtube.thumbnailUrl,
          groupId,
          groupName: grouped ? groupName : undefined,
          groupFolder: grouped ? groupName : undefined,
          audioUrl: variant.audioUrl ?? null,
          audioTracks: variant.audioTracks,
          // The page told us the size; without this the row and the group total
          // both read "—" until each file has been probed one at a time.
          expectedSize: variant.estimatedSize,
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
        reportError(t('addFailed'), err)
      }
      return
    }

    if (mediaMode && !youtubeVariant) return

    const input: NewDownload = {
      url: youtubeVariant?.url || url,
      sourceUrl: mediaMode ? url : undefined,
      thumbnailUrl: youtube?.thumbnailUrl,
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
      filename: torrentMode ? undefined : filename.trim() || undefined,
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
      reportError(t('addOneFailed'), err)
    }
  }

  return (
    <Dialog
      title={playlistMode
        ? t('playlistTitle')
        : torrentMode
          ? t('addTorrentTitle')
          : youtubeMode
            ? t('youtubeTitle')
            : mediaMode
              ? t('mediaTitle')
              : fromBrowser
                ? t('fileInfoTitle')
                : t('saveAsTitle')}
      subtitle={hostOf(url) || url}
      width={torrentMode ? 1100 : pageAssetMode ? 760 : 560}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>{t('cancel')}</GhostButton>
          {playlistMode && onPlaylist ? (
            <PrimaryButton
              onClick={() => {
                onPlaylist(url)
                onClose()
              }}
            >
              {t('openAsPlaylist')}
            </PrimaryButton>
          ) : (
            <>
              <GhostButton disabled={cannotStart} onClick={() => void start(false)}>
                {pageAssetMode ? t('addLaterCount', { count: selectedMediaIndices.size }) : t('downloadLater')}
              </GhostButton>
              <PrimaryButton disabled={cannotStart} onClick={() => void start(true)}>
                {pageAssetMode ? t('startCount', { count: selectedMediaIndices.size }) : t('startDownload')}
              </PrimaryButton>
            </>
          )}
        </>
      }
    >
      {mediaMode && (
        <div className="mb-3.5 flex items-center gap-3 rounded-lg border border-line bg-white/[0.02] p-2">
          <div className="w-[112px] h-[72px] shrink-0 overflow-hidden rounded-md bg-white/[0.04] grid place-items-center">
            {preview ? <img src={preview} alt="Media preview" className="w-full h-full object-cover" /> : <FileIcon name={filename} className="w-7 h-7" />}
          </div>
          <div className="min-w-0 text-[12.5px] font-semibold line-clamp-2 break-words" title={youtube?.title || filename}>
            {youtube?.title || filename || hostOf(url)}
          </div>
        </div>
      )}
      {playlistMode && (
        <div className="rounded-lg px-3 py-2.5 text-[12.5px] leading-relaxed border border-[rgba(56,189,248,0.25)] bg-[rgba(56,189,248,0.08)]">
          {t('playlistNotice')}
        </div>
      )}

      {duplicate && (
        <div className="mb-3.5 rounded-lg px-3 py-2.5 text-[11.5px] leading-relaxed border border-[rgba(250,204,21,0.25)] bg-[rgba(250,204,21,0.08)] flex items-center gap-3">
          <span className="min-w-0 flex-1 text-warn">
            {duplicate.status === 'done'
              ? (duplicate.completedAt
                  ? t('duplicateDoneAt', { name: duplicate.filename, when: formatWhen(duplicate.completedAt) })
                  : t('duplicateDone', { name: duplicate.filename }))
              : t('duplicateInList', { name: duplicate.filename, status: duplicate.status })}
          </span>
          {duplicate.status === 'done' && (
            <button
              type="button"
              className="shrink-0 text-[11px] text-muted hover:text-ink underline underline-offset-2"
              onClick={() => void window.api.revealFile(duplicate.taskId)}
            >
              {t('showMe')}
            </button>
          )}
        </div>
      )}

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
            <label className="label">{pageAssetMode ? t('pageContents') : t('quality')}</label>
            {probeError ? (
              <div className="rounded-lg px-3 py-2.5 text-[11.5px] leading-relaxed border border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.08)] text-warn">
                {t('noMediaFound', { error: probeError })}
              </div>
            ) : !youtube ? (
              <MediaLoadingState phase={pageAssetMode ? 'page' : 'qualities'} />
            ) : youtube.variants.length === 0 ? (
              <div className="field text-[12.5px] text-warn">
                {pageAssetMode ? t('noDownloadableFiles') : t('noDownloadableQualities')}
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
          <label className="label">{t('fileName')}</label>
          <input
            value={filename}
            disabled={torrentMode}
            onChange={(event) => {
              touched.current = true
              setFilename(event.target.value)
            }}
            spellCheck={false}
            className="field text-[12.5px]"
          />
          {torrentMode && <p className="mt-1.5 text-[11px] text-faint">{t('torrentNameFixed')}</p>}
        </div>}

        <div>
          <label className="label">{t('saveTo')}</label>
          <button
            onClick={() => void browse()}
            className="field text-left text-[12.5px] flex items-center gap-2 hover:bg-white/[0.06] transition-colors"
          >
            <FolderIcon className="w-4 h-4 text-faint shrink-0" />
            <span className={'truncate ' + (dir ? '' : 'text-faint')}>
              {dir ?? t('automaticCategory')}
            </span>
          </button>
          {dir && (
            <button
              onClick={() => setDir(null)}
              className="mt-1.5 text-[11px] text-faint hover:text-ink transition-colors"
            >
              {t('useCategoryFolder')}
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 max-[560px]:grid-cols-1 gap-3">
          <div>
            <label className="label">{t('category')}</label>
            <select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              className="field text-[12.5px]"
            >
              <option value="">{t('automaticByExtension')}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">{t('queue')}</label>
            <select
              value={queueId}
              onChange={(event) => setQueueId(event.target.value)}
              className="field text-[12.5px]"
            >
              <option value="">{t('none')}</option>
              {queues.map((queue) => (
                <option key={queue.id} value={queue.id}>
                  {queue.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="label">{t('description')}</label>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('optional')}
            className="field text-[12.5px]"
          />
        </div>

        {!pageAssetMode && <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">{t('checksumOptional')}</label>
            <input
              value={expectedChecksum}
              onChange={(event) => setExpectedChecksum(event.target.value)}
              placeholder={t('checksumPlaceholder')}
              spellCheck={false}
              className="field text-[12.5px] font-mono placeholder:font-sans"
            />
          </div>
          <div>
            <label className="label">{t('postProcessing')}</label>
            <select
              value={postProcess}
              onChange={(event) => setPostProcess(event.target.value as any)}
              className="field text-[12.5px]"
            >
              <option value="none">{t('none')}</option>
              <option value="mp4">{t('convertMp4')}</option>
              <option value="mp3">{t('convertMp3')}</option>
            </select>
          </div>
        </div>}

          {!mediaMode && <ServerInfo probe={probe} error={probeError} knownSize={knownSize ?? null} />}

          {fromBrowser && (
            <div className="text-faint text-[11px] text-center italic mt-2">
              {t('cancelRestartHint')}
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
  const t = useT()
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
  // With a filter typed, the buttons act on what is on screen. "flac" then
  // "Select matches" is how somebody takes a whole album in one format.
  const filtered = visible.length !== variants.length
  return (
    <section className="border border-line rounded-lg bg-white/[0.02] overflow-hidden">
      <div className="px-3.5 py-2.5 bg-white/[0.04] border-b border-line flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold">{t('pageDownloads')}</div>
          <div className="text-[10.5px] text-faint tnum mt-0.5">
            {t('selectedOfSize', { selected: selected.size, total: variants.length })}
            {selectedSize > 0 ? ` · ${formatBytes(selectedSize)}${unknownSizes ? t('plusUnknown') : ''}` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.3px]">
          <button
            className="text-faint hover:text-ink transition-colors"
            onClick={() => onSelectionChange(new Set([...selected, ...visible.map(({ index }) => index)]))}
          >
            {filtered ? t('selectMatches') : t('selectAll')}
          </button>
          <button
            className="text-faint hover:text-ink transition-colors"
            onClick={() => {
              const next = new Set(selected)
              for (const { index } of visible) next.delete(index)
              onSelectionChange(next)
            }}
          >
            {filtered ? t('clearMatches') : t('selectNone')}
          </button>
        </div>
      </div>

      <div className="px-3 py-2 border-b border-line bg-black/10">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('searchFetchedPlaceholder')}
          className="field !py-1.5 text-[11.5px]"
          spellCheck={false}
        />
      </div>

      <div className="grid grid-cols-[24px_minmax(0,1fr)_90px_70px] px-3 py-2 border-b border-line text-[10px] uppercase tracking-[0.4px] text-faint">
        <span />
        <span>{t('asset')}</span>
        <button
          className="text-right hover:text-ink transition-colors"
          title={t('orderBySize')}
          onClick={() => setSizeDirection((current) => current === 'none' ? 'desc' : current === 'desc' ? 'asc' : 'none')}
        >
          {t('size')} {sizeDirection === 'desc' ? '↓' : sizeDirection === 'asc' ? '↑' : '↕'}
        </button>
        <span className="text-right">{t('format')}</span>
      </div>

      <div className="max-h-[300px] overflow-y-auto p-1.5 text-[11.5px]">
        {visible.length === 0 && (
          <div className="py-8 text-center text-faint">{t('noFetchedMatch', { query })}</div>
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
  const t = useT()
  const title = phase === 'page'
    ? t('inspectingPage')
    : phase === 'qualities'
      ? t('readingQualities')
      : t('connectingDetails')
  const detail = phase === 'page'
    ? t('inspectingPageDetail')
    : phase === 'qualities'
      ? t('readingQualitiesDetail')
      : t('connectingDetailsDetail')
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

/**
 * Which rows are ticked when the picker opens.
 *
 * Everything, unless the resolver marked rows as alternatives of one another -
 * a khinsider album lists every track as both FLAC and MP3, and ticking both
 * means downloading the album twice.
 */
function defaultSelection(variants: MediaVariant[]): Set<number> {
  return new Set(
    variants.map((_variant, index) => index).filter((index) => variants[index].defaultSelected !== false)
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
  const t = useT()
  const [query, setQuery] = useState('')
  const [sizeDirection, setSizeDirection] = useState<'none' | 'desc' | 'asc'>('none')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const selectedCount = selectedFiles?.size ?? 0
  const selectedSize = files?.reduce(
    (sum, file) => sum + (selectedFiles?.has(file.path) ? file.size : 0),
    0
  ) ?? 0
  const tree = useMemo(() => buildTorrentTree(files ?? [], query, sizeDirection), [files, query, sizeDirection])
  // Searching reveals matching descendants without losing the user's collapsed folders.
  const searching = query.trim().length > 0
  const renderNodes = (nodes: TorrentTreeNode[], depth = 0): React.ReactNode => nodes.map((node) => {
    const folder = node.kind === 'folder'
    const expanded = searching || !collapsed.has(node.key)
    const count = node.filePaths.reduce((sum, path) => sum + (selectedFiles?.has(path) ? 1 : 0), 0)
    const checked = count === node.filePaths.length
    const mixed = count > 0 && !checked
    return (
      <li key={node.key}>
        <div
          className="grid grid-cols-[16px_18px_18px_minmax(0,1fr)_80px] items-center gap-1.5 pr-2 py-1.5 hover:bg-white/[0.04] rounded"
          style={{ paddingLeft: 6 + depth * 16 }}
        >
          {folder ? (
            <button
              type="button"
              className="text-faint hover:text-ink disabled:opacity-50"
              aria-label={node.name}
              aria-expanded={expanded}
              disabled={searching}
              onClick={() => setCollapsed((current) => {
                const next = new Set(current)
                if (next.has(node.key)) next.delete(node.key)
                else next.add(node.key)
                return next
              })}
            >
              <ChevronIcon open={expanded} className="w-3.5 h-3.5" />
            </button>
          ) : <span />}
          <label className="contents cursor-pointer">
            <input
              type="checkbox"
              checked={checked}
              aria-checked={mixed ? 'mixed' : checked}
              aria-label={node.name}
              ref={(input) => { if (input) input.indeterminate = mixed }}
              onChange={(event) => onSelectionChange(selectTorrentPaths(selectedFiles ?? new Set(), node.filePaths, event.target.checked))}
            />
            {folder
              ? <FolderIcon className="w-4 h-4 text-[var(--accent)]" />
              : <FileIcon name={node.name} className="w-4 h-4" />}
            <span className={`truncate ${folder ? 'font-semibold' : ''}`} title={node.key.slice(node.key.indexOf(':') + 1)}>{node.name}</span>
            <span className="text-faint tnum text-right">{formatBytes(node.size)}</span>
          </label>
        </div>
        {folder && expanded && <ul>{renderNodes(node.children, depth + 1)}</ul>}
      </li>
    )
  })

  return (
    <section className="min-w-0 min-h-[480px] max-h-[62vh] border border-line rounded-lg bg-white/[0.02] overflow-hidden flex flex-col">
      <div className="px-3.5 py-3 bg-white/[0.04] border-b border-line flex items-center gap-2 shrink-0">
        <span className="text-[var(--accent)]">
          <TorrentIcon className="w-4 h-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold">{t('torrentContents')}</div>
          <div className="text-[10.5px] text-faint tnum mt-0.5">
            {files && selectedFiles
              ? `${t('selectedOfSize', { selected: selectedCount, total: files.length })} · ${formatBytes(selectedSize)}`
              : t('waitingMetadata')}
          </div>
        </div>
        {files && selectedFiles && (
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.3px]">
            <button
              className="text-faint hover:text-ink transition-colors"
              onClick={() => onSelectionChange(new Set(files.map((file) => file.path)))}
            >
              {t('selectAll')}
            </button>
            <button
              className="text-faint hover:text-ink transition-colors"
              onClick={() => onSelectionChange(new Set())}
            >
              {t('selectNone')}
            </button>
          </div>
        )}
      </div>

      {files && selectedFiles && (
        <div className="px-3 py-2 border-b border-line bg-black/10 shrink-0">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('searchTorrentPlaceholder')}
            className="field !py-1.5 text-[11.5px]"
            spellCheck={false}
          />
        </div>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_100px] px-3 py-2 border-b border-line text-[10px] uppercase tracking-[0.4px] text-faint shrink-0">
        <span>{t('name')}</span>
        <button
          className="text-right hover:text-ink transition-colors"
          onClick={() => setSizeDirection((current) => current === 'none' ? 'desc' : current === 'desc' ? 'asc' : 'none')}
        >
          {t('size')} {sizeDirection === 'desc' ? '↓' : sizeDirection === 'asc' ? '↑' : '↕'}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 text-[11.5px]">
        {error ? (
          <div className="h-full grid place-items-center px-8 text-center text-warn leading-relaxed">
            <div>
              {t('loadTorrentFailed')}<br />{error}
              <button onClick={onRetry} className="block mx-auto mt-4 px-3 py-1.5 rounded-lg border border-line text-ink bg-white/[0.05] hover:bg-white/[0.1]">
                {t('tryMetadataAgain')}
              </button>
            </div>
          </div>
        ) : !files || !selectedFiles ? (
          <div className="h-full grid place-items-center px-8 text-center text-faint leading-relaxed">
            {t('findingPeers')}
          </div>
        ) : files.length === 0 ? (
          <div className="h-full grid place-items-center text-faint">{t('emptyTorrent')}</div>
        ) : tree.length === 0 ? (
          <div className="h-full grid place-items-center text-faint">{t('noTorrentMatch', { query })}</div>
        ) : (
          <ul>{renderNodes(tree)}</ul>
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
  const t = useT()
  if (error) {
    const sessionRequired = /\b(?:401|403|forbidden|unauthorized|browser session|captcha|cloudflare)\b/i.test(error)
    return (
      <div className="rounded-lg px-3 py-2.5 text-[11.5px] leading-relaxed border border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.08)] text-warn">
        {t('couldNotReadDetails', { error })}
        <div className="text-faint mt-1">
          {sessionRequired ? t('sessionRequiredHint') : t('stillStartHint')}
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
        <Fact label={t('totalSize')} value={formatBytes(probe.size ?? knownSize)} />
        <Fact label={t('files')} value={String(probe.torrentFiles.length)} />
        <Fact label={t('type')} value="BitTorrent" tone="ok" />
      </div>
    )
  }

  return (
    <div className="rounded-lg px-3 py-2.5 border border-line bg-white/[0.02] grid grid-cols-3 gap-y-1.5 text-[11.5px]">
      <Fact label={t('size')} value={formatBytes(probe.size ?? knownSize)} />
      <Fact
        label={t('resumeSupport')}
        value={probe.resumable ? t('supported') : t('notSupported')}
        tone={probe.resumable ? 'ok' : 'warn'}
      />
      <Fact label={t('type')} value={probe.mimeType ?? '—'} />
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
