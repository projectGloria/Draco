import { useState } from 'react'
import type { MediaCandidate, MediaVariant } from '@shared/types'
import { formatBytes, hostOf } from '../lib/format'
import { useApp } from '../store/app'
import { reportError, toast } from '../store/toasts'
import { GhostButton, PrimaryButton } from './Dialog'
import { DownloadIcon, RefreshIcon, VideoIcon } from './Icons'

/**
 * Streams the extension noticed while you were browsing. Nothing here is
 * fetched until you ask: a page can reference a dozen playlists, and quietly
 * probing all of them would announce Draco to every CDN you scroll past.
 */

export default function GrabberPanel(): React.ReactElement {
  const media = useApp((s) => s.media)

  if (media.length === 0) {
    return (
      <div className="flex-1 grid place-items-center text-center px-8">
        <div className="fade-up max-w-[380px]">
          <div
            className="w-12 h-12 rounded-2xl grid place-items-center mb-3 mx-auto"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            <VideoIcon className="w-6 h-6" />
          </div>
          <p className="text-[13px] font-semibold">No streams spotted yet</p>
          <p className="text-[12px] text-faint mt-1 leading-relaxed">
            Play a video on a page with the Draco extension installed. Playlists and large media
            responses show up here with their quality ladder.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-line">
        <span className="text-[12px] text-faint flex-1">
          {media.length} stream{media.length === 1 ? '' : 's'} found
        </span>
        <GhostButton
          onClick={() => {
            void window.api.clearMedia().catch((err) => reportError('Could not clear the list', err))
          }}
        >
          Clear list
        </GhostButton>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {media.map((candidate) => (
          <Card key={candidate.id} candidate={candidate} />
        ))}
      </div>
    </div>
  )
}

function Card({ candidate }: { candidate: MediaCandidate }): React.ReactElement {
  const [busy, setBusy] = useState(false)

  const resolve = (): void => {
    setBusy(true)
    void window.api
      .resolveMedia(candidate.id)
      .catch((err) => reportError('Could not read this stream', err))
      .finally(() => setBusy(false))
  }

  const download = (variant: MediaVariant): void => {
    const name = suggestName(candidate, variant)
    void window.api
      .downloadMedia(candidate.id, {
        variantUrl: variant.url,
        filename: name,
        audioUrl: variant.audioUrl ?? null
      })
      .then(() => toast('success', 'Added', name))
      .catch((err) => reportError('Could not start the download', err))
  }

  return (
    <div className="surface-card rounded-card p-3 fade-up">
      <div className="flex items-start gap-3">
        <span
          className="w-8 h-8 rounded-lg grid place-items-center shrink-0"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          <VideoIcon className="w-4 h-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold truncate" title={candidate.pageTitle}>
            {candidate.pageTitle || hostOf(candidate.pageUrl) || 'Untitled page'}
          </div>
          <div className="text-[11px] text-faint truncate mt-0.5" title={candidate.mediaUrl}>
            <span className="uppercase tracking-[0.4px] mr-1.5">{candidate.type}</span>
            {candidate.mediaUrl}
          </div>
        </div>

        {candidate.variants.length === 0 && (
          <GhostButton onClick={resolve} disabled={busy}>
            <span className="flex items-center gap-1.5">
              <RefreshIcon className={'w-3.5 h-3.5 ' + (busy ? 'spin-slow' : '')} />
              {busy ? 'Reading…' : 'Read qualities'}
            </span>
          </GhostButton>
        )}
      </div>

      {candidate.variants.length > 0 && (
        <div className="mt-2.5 pt-2.5 border-t border-line space-y-1.5">
          {candidate.variants.map((variant, index) => (
            <div key={variant.url + index} className="flex items-center gap-3 text-[11.5px]">
              <span className="font-semibold w-[70px] shrink-0">{variant.label}</span>
              <span className="tnum text-faint w-[80px] shrink-0">
                {variant.bandwidth ? Math.round(variant.bandwidth / 1000) + ' kbps' : ''}
              </span>
              <span className="tnum text-faint w-[80px] shrink-0">
                {variant.estimatedSize ? formatBytes(variant.estimatedSize) : ''}
              </span>
              <span className="flex-1 truncate text-faint font-mono text-[10.5px]" title={variant.codecs ?? ''}>
                {variant.codecs ?? ''}
              </span>
              {index === 0 ? (
                <PrimaryButton onClick={() => download(variant)}>Download</PrimaryButton>
              ) : (
                <GhostButton onClick={() => download(variant)}>
                  <span className="flex items-center gap-1.5">
                    <DownloadIcon className="w-3.5 h-3.5" />
                    Download
                  </span>
                </GhostButton>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** A filename from the page title, since a playlist URL is rarely descriptive. */
function suggestName(candidate: MediaCandidate, variant: MediaVariant): string {
  let base = (candidate.pageTitle || hostOf(candidate.pageUrl) || 'video')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 80)

  base = base.replace(/\s*-\s*(YouTube|Vimeo|Twitch|Dailymotion)$/i, '').trim()

  const quality = variant.height ? ' ' + variant.height + 'p' : ''
  const baseName = (base || 'video') + quality

  let ext = '.mp4'
  if (candidate.type === 'file') ext = '.' + extensionFromUrl(variant.url)
  else if (/\.mkv(\?|$)/i.test(variant.url)) ext = '.mkv'
  else if (/\.webm(\?|$)/i.test(variant.url)) ext = '.webm'
  else if (/\.ts(\?|$)/i.test(variant.url)) ext = '.ts'

  return baseName + ext
}

function extensionFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname
    const match = /\.([a-z0-9]{2,5})$/i.exec(path)
    return match ? match[1].toLowerCase() : 'bin'
  } catch {
    return 'bin'
  }
}
