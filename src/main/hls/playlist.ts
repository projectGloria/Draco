import type { MediaVariant, RequestHeaders } from '../../shared/types.ts'
import { buildHeaders } from '../engine/probe.ts'
import { getDispatcher } from '../engine/http.ts'
import { isMasterPlaylist, parseMaster, parseMediaPlaylist, type MediaPlaylist } from './playlist-parser.ts'

export type { HlsSegment } from './playlist-parser.ts'
export type { MediaPlaylist } from './playlist-parser.ts'
export { isMasterPlaylist, parseMaster, parseMediaPlaylist } from './playlist-parser.ts'

async function fetchText(url: string, headers: RequestHeaders | undefined): Promise<{ text: string; finalUrl: string }> {
  const res = await fetch(url, {
    headers: buildHeaders(headers),
    redirect: 'follow',
    dispatcher: getDispatcher(30_000)
  } as RequestInit)

  if (!res.ok) throw new Error(`Playlist request failed with ${res.status}`)
  return { text: await res.text(), finalUrl: res.url || url }
}

/** Fetches a URL and returns its quality ladder, or a single entry for a plain file. */
export async function resolveVariants(
  url: string,
  headers: RequestHeaders | undefined
): Promise<MediaVariant[]> {
  const fetched = await fetchText(url, headers)
  const text = fetched.text
  const baseUrl = fetched.finalUrl

  if (isMasterPlaylist(text)) {
    const variants = parseMaster(text, baseUrl)
    if (variants.length > 0) {
      try {
        const topPlaylist = await loadMediaPlaylist(variants[0].url, headers)
        if (topPlaylist.totalDuration > 0) {
          for (const variant of variants) {
            if (variant.bandwidth) {
              variant.estimatedSize = Math.round((variant.bandwidth / 8) * topPlaylist.totalDuration)
            }
          }
        }
      } catch {
        // Ignore failures, sizes just stay null
      }
      return variants
    }
  }

  const playlist = parseMediaPlaylist(text, baseUrl)
  return [
    {
      url: baseUrl,
      label: playlist.isLive ? 'live stream' : 'stream',
      height: null,
      bandwidth: null,
      codecs: null,
      estimatedSize: null
    }
  ]
}

export async function loadMediaPlaylist(
  url: string,
  headers: RequestHeaders | undefined
): Promise<MediaPlaylist> {
  return loadMediaPlaylistDepth(url, headers, 0)
}

const MAX_PLAYLIST_NESTING = 5

async function loadMediaPlaylistDepth(
  url: string,
  headers: RequestHeaders | undefined,
  depth: number
): Promise<MediaPlaylist> {
  if (depth > MAX_PLAYLIST_NESTING) throw new Error('HLS playlist nesting is too deep')

  const fetched = await fetchText(url, headers)
  const text = fetched.text
  const baseUrl = fetched.finalUrl

  if (isMasterPlaylist(text)) {
    const best = parseMaster(text, baseUrl)[0]
    if (best) return loadMediaPlaylistDepth(best.url, headers, depth + 1)
  }

  return parseMediaPlaylist(text, baseUrl)
}
