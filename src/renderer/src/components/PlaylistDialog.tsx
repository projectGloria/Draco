import { useEffect, useState } from 'react'
import type { PlaylistListing } from '@shared/types'
import { formatEta } from '../lib/format'
import { useApp } from '../store/app'
import { reportError, toast } from '../store/toasts'
import Dialog, { GhostButton, PrimaryButton } from './Dialog'

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
  { label: 'Best available', height: null },
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
  const queues = useApp((state) => state.queues)
  const [listing, setListing] = useState<PlaylistListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [height, setHeight] = useState<number | null>(1080)
  const [audioOnly, setAudioOnly] = useState(false)
  const [queueId, setQueueId] = useState('')
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api
      .resolvePlaylist(url)
      .then((result) => {
        if (!cancelled) setListing(result)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [url])

  const add = async (): Promise<void> => {
    if (!listing) return
    setAdding(true)
    try {
      const { accepted } = await window.api.addPlaylist({
        entries: listing.entries,
        title: listing.title,
        height: audioOnly ? null : height,
        audioOnly,
        queueId: queueId || null
      })
      // Deliberately not "added": each entry still has to be looked up, and
      // rows appear as that happens.
      toast('info', `Resolving ${accepted} video(s) from ${listing.title}…`)
      onClose()
    } catch (err) {
      reportError('Could not add that playlist', err)
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog
      title={listing ? listing.title : 'Playlist'}
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
              Just this video
            </GhostButton>
          )}
          <span className="flex-1" />
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={() => void add()} disabled={!listing || adding}>
            {listing ? `Add ${listing.entries.length} video${listing.entries.length === 1 ? '' : 's'}` : 'Add'}
          </PrimaryButton>
        </>
      }
    >
      {error ? (
        <div className="rounded-lg px-3 py-2.5 text-[12px] leading-relaxed border border-[rgba(248,113,113,0.25)] bg-[rgba(248,113,113,0.08)] text-err">
          {error}
        </div>
      ) : !listing ? (
        <p className="text-[12.5px] text-muted py-6 text-center">Reading the listing…</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">Quality</label>
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
                    {quality.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Format</label>
              <select
                value={audioOnly ? 'audio' : 'video'}
                onChange={(event) => setAudioOnly(event.target.value === 'audio')}
                className="field text-[12.5px]"
              >
                <option value="video">Video</option>
                <option value="audio">Audio only</option>
              </select>
            </div>
            <div>
              <label className="label">Queue</label>
              <select
                value={queueId}
                onChange={(event) => setQueueId(event.target.value)}
                className="field text-[12.5px]"
              >
                <option value="">Start right away</option>
                {queues.map((queue) => (
                  <option key={queue.id} value={queue.id}>
                    {queue.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="mt-2.5 text-[11.5px] text-faint leading-relaxed">
            Each video is looked up as its download starts, so a rung is chosen rather than an exact
            format — whatever is closest without going over. They land together in a folder named
            after the playlist.
            {listing.truncated && ' This listing was longer than Draco takes in one go; the first 400 are shown.'}
          </p>

          <div className="mt-3 border border-line rounded-lg overflow-hidden max-h-[240px] overflow-y-auto">
            {listing.entries.map((entry, index) => (
              <div
                key={`${entry.url}-${index}`}
                className="grid grid-cols-[28px_minmax(0,1fr)_64px] items-center gap-2 px-2.5 py-1.5 text-[11.5px] border-b border-line last:border-b-0"
              >
                <span className="text-faint tnum text-right">{index + 1}</span>
                <span className="truncate" title={entry.title}>{entry.title}</span>
                <span className="text-right text-muted tnum">
                  {entry.duration === null ? '—' : formatEta(entry.duration)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </Dialog>
  )
}
