/**
 * Playlists and channels: one link that means many videos.
 *
 * `isSupportedYouTubeUrl` has always accepted these, and every one of them then
 * resolved to exactly one video - whichever the URL happened to also name, or
 * an error. Dropping a 40-video playlist in and getting one video back is the
 * kind of wrong that looks like the feature working.
 *
 * The URL reading lives in `shared/youtube-link.ts` and is re-exported here, so
 * the renderer's "which dialog opens" check and main's "is this really a
 * playlist" check can no longer drift apart. What is left in this file is the
 * part that needs yt-dlp's output shape: turning a flat listing into entries.
 */

import { youtubeThumbnailUrl } from '../shared/youtube-link.ts'

export {
  isPlaylistUrl,
  isSupportedYouTubeUrl,
  normalizeLinkInput,
  playlistIdOf,
  singleVideoUrl
} from '../shared/youtube-link.ts'

/** How many entries one link may turn into. A channel can list thousands. */
export const MAX_PLAYLIST_ENTRIES = 400

export interface PlaylistEntry {
  /** The watch URL Draco will resolve when this entry becomes a download. */
  url: string
  title: string
  /** Seconds, when the flat listing knew; playlists of live items often do not. */
  duration: number | null
  /**
   * Poster image for the entry, or null when neither the listing nor the URL
   * gave one. A flat listing is the only description of these videos anyone
   * gets - nothing is resolved until a download starts - so a wall of titles is
   * genuinely hard to pick from, and this is what the dialog draws instead.
   */
  thumbnailUrl: string | null
}

export interface PlaylistListing {
  title: string
  entries: PlaylistEntry[]
  /** True when the source had more entries than `MAX_PLAYLIST_ENTRIES`. */
  truncated: boolean
}

/**
 * How deep the nested-listing walk will go. A channel is a playlist of tabs,
 * each of which is a playlist of videos - two levels. Three is slack.
 */
const MAX_LISTING_DEPTH = 3

/**
 * Turns yt-dlp's `--flat-playlist` JSON into entries.
 *
 * Flat means yt-dlp lists what is in the playlist without resolving any of it -
 * one quick call instead of one lookup per video. Each entry is resolved later,
 * as its download starts, which is also the only way the signed URLs are still
 * fresh when they are used.
 */
export function parseFlatPlaylist(raw: unknown): PlaylistListing {
  const root = raw as Record<string, unknown> | null
  const rawEntries = Array.isArray(root?.entries) ? root!.entries : []

  const entries: PlaylistEntry[] = []
  /*
   * Set only when a usable entry was reached and refused for want of room.
   *
   * This used to be `rawEntries.length > entries.length`, which is also true
   * whenever an entry was skipped for being unusable - a private or deleted
   * video, of which a long playlist has several. A listing of thirty that
   * happened to contain two deleted videos reported itself as having been cut
   * off at four hundred.
   */
  let truncated = false

  for (const entry of flattenEntries(rawEntries)) {
    const url = watchUrlOf(entry)
    if (!url) continue

    if (entries.length >= MAX_PLAYLIST_ENTRIES) {
      truncated = true
      break
    }

    const duration = typeof entry.duration === 'number' && Number.isFinite(entry.duration)
      ? Math.max(0, Math.round(entry.duration))
      : null

    entries.push({
      url,
      title: typeof entry.title === 'string' && entry.title.trim()
        ? entry.title.trim().slice(0, 300)
        : 'Untitled',
      duration,
      thumbnailUrl: thumbnailOf(entry) ?? youtubeThumbnailUrl(url)
    })
  }

  return {
    title: typeof root?.title === 'string' && root.title.trim()
      ? root.title.trim().slice(0, 200)
      : 'Playlist',
    entries,
    truncated
  }
}

/**
 * The videos inside a listing, however deeply yt-dlp nested them.
 *
 * A bare channel link - `youtube.com/@someone`, with no `/videos` on the end -
 * does not produce a list of videos. yt-dlp answers with a playlist *of
 * playlists*: one entry per channel tab (Videos, Shorts, Live), each carrying
 * `_type: "playlist"` and its own `entries`. Nothing here used to check
 * `_type`, so each tab was read as though it were a video: its 24-character
 * channel id failed the video-id test, `watchUrlOf` fell through to
 * `entry.url`, and the dialog cheerfully offered to download three tab pages.
 * All three then failed at resolve time with no useful explanation.
 */
function* flattenEntries(
  raw: readonly unknown[],
  depth = 0
): Generator<Record<string, unknown>> {
  if (depth >= MAX_LISTING_DEPTH) return

  for (const item of raw) {
    const entry = item as Record<string, unknown> | null
    if (!entry || typeof entry !== 'object') continue

    if (Array.isArray(entry.entries)) {
      yield* flattenEntries(entry.entries, depth + 1)
      continue
    }
    // A nested listing yt-dlp did not expand in this pass has nothing
    // downloadable in it and must not be offered as though it did.
    if (entry._type === 'playlist') continue

    yield entry
  }
}

/**
 * The poster image a flat entry carries, if any.
 *
 * yt-dlp orders `thumbnails` smallest first, so the last usable entry is the
 * largest it knows about. Only https is taken: the URL is handed to main's
 * thumbnail fetcher, and http here would be a plaintext request made on the
 * strength of a string that came out of a web page. Non-YouTube extractors are
 * the reason this is read at all - a YouTube entry's id already derives one.
 */
function thumbnailOf(entry: Record<string, unknown>): string | null {
  const raw = Array.isArray(entry.thumbnails) ? entry.thumbnails : []
  for (let i = raw.length - 1; i >= 0; i--) {
    const url = (raw[i] as Record<string, unknown> | null)?.url
    if (typeof url === 'string' && /^https:\/\/[^\s]{1,1500}$/i.test(url)) return url
  }
  return null
}

/**
 * The watch URL for one flat entry.
 *
 * yt-dlp gives a bare id for a YouTube entry and a full URL for some other
 * extractors, and a private or deleted video appears as an entry with neither.
 * Building from the id is preferred: the `url` field of a flat entry is
 * sometimes a shortened form that carries the playlist along with it.
 */
function watchUrlOf(entry: Record<string, unknown>): string | null {
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (/^[A-Za-z0-9_-]{5,20}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`

  const url = typeof entry.url === 'string' ? entry.url.trim() : ''
  if (!/^https:\/\/[^\s]+$/i.test(url) || url.length >= 2000) return null

  // A tab or channel page is not a video. Accepting one produced an entry that
  // could only ever fail, and it looked identical to a real one in the dialog.
  try {
    const parsed = new URL(url)
    if (/(^|\.)youtube\.com$/i.test(parsed.hostname)) {
      const hasVideo = parsed.searchParams.has('v') ||
        /^\/(?:shorts|embed|live)\/[^/]+/i.test(parsed.pathname)
      if (!hasVideo) return null
    }
  } catch {
    return null
  }

  return url
}
