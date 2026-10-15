import { useEffect, useState } from 'react'
import type { PlaylistEntryInfo, PlaylistListing } from '@shared/types'
import { formatEta } from '../lib/format'
import { useThumbnail } from '../lib/icons'
import { useApp } from '../store/app'
import { reportError, toast } from '../store/toasts'
import { useT } from '../i18n'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'
import { PlayIcon } from './Icons'

/**
 * What to do with a link that stands for many videos.
 *
 * The listing is cheap - one `--flat-playlist` call, however long it is - but
 * every entry still has to be resolved individually before it can be
 * downloaded. That happens in the background after this closes, which is why
 * this asks for a quality *rung* rather than a format: the exact formats differ
 * from video to video, and are only known once each one is looked up.
 */

/** Rungs offered. `null` means the best each video happens to have. */
const QUALITIES: Array<{ label: string; height: number | null }> = [
  { label: 'BEST', height: null },
  { label: '1080p', height: 1080 },
  { label: '720p', height: 720 },
  { label: '480p', height: 480 },
  { label: '360p', height: 360 }
]

export default function PlaylistDialog({
  url,
  onClose,
  onSingleVideo
}: {
  url: string
  onClose(): void
  /** Falls back to the ordinary Save As flow for the one video in the link. */
  onSingleVideo(url: string): void
}): React.ReactElement {
  const t = useT()
  const queues = useApp((state) => state.queues)
  const [listing, setListing] = useState<PlaylistListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState<number | null>(1080)
  const [audioOnly, setAudioOnly] = useState(false)
  const [queueId, setQueueId] = useState('')
  const [adding, setAdding] = useState(false)
  /**
   * Which entries will be added, by index into `listing.entries`.
   *
   * Everything, until the user says otherwise: the link they followed meant the
   * whole playlist, so the old all-or-nothing button was the right default -
   * it was only the inability to say "all but those three" that was missing.
   */
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const chosen = listing ? listing.entries.filter((_entry, index) => selected.has(index)) : []

  useEffect(() => {
    let cancelled = false
    window.api
      .resolvePlaylist(url)
      .then((result) => {
        if (cancelled) return
        setListing(result)
        setSelected(new Set(result.entries.map((_entry, index) => index)))
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [url])

  const add = async (): Promise<void> => {
    if (!listing || chosen.length === 0) return
    setAdding(true)
    try {
      const { accepted } = await window.api.addPlaylist({
        entries: chosen,
        title: listing.title,
        height: audioOnly ? null : height,
        audioOnly,
        queueId: queueId || null
      })
      // Deliberately not "added": each entry still has to be looked up, and
      // rows appear as that happens.
      toast('info', t('resolvingFrom', { count: accepted, title: listing.title }))
      onClose()
    } catch (err) {
      reportError(t('playlistAddFailed'), err)
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog
      title={listing ? listing.title : t('playlistTitle')}
      subtitle={url}
      width={620}
      onClose={onClose}
      footer={
        <>
          {listing?.singleVideoUrl && (
            <GhostButton
              onClick={() => {
                onSingleVideo(listing.singleVideoUrl!)
                onClose()
              }}
            >
              {t('justThisVideo')}
            </GhostButton>
          )}
          <span className="flex-1" />
          <GhostButton onClick={onClose}>{t('cancel')}</GhostButton>
          <PrimaryButton onClick={() => void add()} disabled={!listing || adding || chosen.length === 0}>
            {listing ? t('addVideosCount', { count: chosen.length }) : t('add')}
          </PrimaryButton>
        </>
      }
    >
      {error ? (
        <div className="rounded-lg px-3 py-2.5 text-[12px] leading-relaxed border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.08)] text-err">
          {error}
        </div>
      ) : !listing ? (
        <p className="text-[12.5px] text-muted py-6 text-center">{t('readingListing')}</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">{t('quality')}</label>
              <select
                value={height === null ? 'best' : String(height)}
                onChange={(event) =>
                  setHeight(event.target.value === 'best' ? null : Number(event.target.value))
                }
                disabled={audioOnly}
                className="field text-[12.5px]"
              >
                {QUALITIES.map((quality) => (
                  <option key={quality.label} value={quality.height === null ? 'best' : String(quality.height)}>
                    {quality.label === 'BEST' ? t('bestAvailable') : quality.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t('format')}</label>
              <select
                value={audioOnly ? 'audio' : 'video'}
                onChange={(event) => setAudioOnly(event.target.value === 'audio')}
                className="field text-[12.5px]"
              >
                <option value="video">{t('video')}</option>
                <option value="audio">{t('audioOnly')}</option>
              </select>
            </div>
            <div>
              <label className="label">{t('queue')}</label>
              <select
                value={queueId}
                onChange={(event) => setQueueId(event.target.value)}
                className="field text-[12.5px]"
              >
                <option value="">{t('startRightAway')}</option>
                {queues.map((queue) => (
                  <option key={queue.id} value={queue.id}>
                    {queue.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="mt-2.5 text-[11.5px] text-faint leading-relaxed">
            {t('playlistRungNote')}
            {listing.truncated ? ` ${t('playlistTruncated')}` : ''}
          </p>

          <section className="mt-3 border border-line rounded-lg bg-white/[0.02] overflow-hidden">
            <div className="px-3.5 py-2.5 bg-white/[0.04] border-b border-line flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-semibold">{t('videos')}</div>
                <div className="text-[10.5px] text-faint tnum mt-0.5">
                  {t('selectedOfSize', { selected: chosen.length, total: listing.entries.length })}
                  {totalDuration(chosen) !== null && ` · ${formatEta(totalDuration(chosen)!)}`}
                </div>
              </div>
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.3px]">
                <button
                  className="text-faint hover:text-ink transition-colors"
                  onClick={() => setSelected(new Set(listing.entries.map((_entry, index) => index)))}
                >
                  {t('selectAll')}
                </button>
                <button
                  className="text-faint hover:text-ink transition-colors"
                  onClick={() => setSelected(new Set())}
                >
                  {t('selectNone')}
                </button>
              </div>
            </div>

            <div className="max-h-[260px] overflow-y-auto p-1.5">
              {listing.entries.map((entry, index) => (
                <PlaylistRow
                  key={`${entry.url}-${index}`}
                  entry={entry}
                  index={index}
                  checked={selected.has(index)}
                  onToggle={(next) =>
                    setSelected((current) => {
                      const updated = new Set(current)
                      if (next) updated.add(index)
                      else updated.delete(index)
                      return updated
                    })
                  }
                />
              ))}
            </div>
          </section>
        </>
      )}
    </Dialog>
  )
}

/**
 * One entry, with the poster image the flat listing carried.
 *
 * Its own component because `useThumbnail` is a hook and the list is a map:
 * four hundred rows means four hundred independent lookups, each cached at
 * module scope, rather than one effect trying to manage the lot.
 */
function PlaylistRow({
  entry,
  index,
  checked,
  onToggle
}: {
  entry: PlaylistEntryInfo
  index: number
  checked: boolean
  onToggle(next: boolean): void
}): React.ReactElement {
  const thumbnail = useThumbnail(entry.thumbnailUrl)

  return (
    <label className="grid grid-cols-[18px_24px_72px_minmax(0,1fr)_58px] items-center gap-2.5 px-2 py-1.5 rounded hover:bg-white/[0.04] cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(event) => onToggle(event.target.checked)} />
      <span className="text-faint tnum text-right text-[11px]">{index + 1}</span>
      <span className="w-[72px] h-[40px] rounded bg-black/30 border border-line overflow-hidden grid place-items-center">
        {thumbnail ? (
          <img src={thumbnail} alt="" draggable={false} className="w-full h-full object-cover" />
        ) : (
          <PlayIcon className="w-3.5 h-3.5 text-faint opacity-60" />
        )}
      </span>
      <span className="truncate text-[11.5px]" title={entry.title}>{entry.title}</span>
      <span className="text-right text-muted tnum text-[11px]">
        {entry.duration === null ? '—' : formatEta(entry.duration)}
      </span>
    </label>
  )
}

/**
 * Total runtime of the chosen entries, or null when none of them knew theirs -
 * a listing of live items has no durations at all, and "0s" would be a lie.
 */
function totalDuration(entries: PlaylistEntryInfo[]): number | null {
  const known = entries.filter((entry) => entry.duration !== null)
  if (known.length === 0) return null
  return known.reduce((total, entry) => total + (entry.duration ?? 0), 0)
}
