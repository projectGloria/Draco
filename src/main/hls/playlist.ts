import type { MediaVariant, RequestHeaders } from '@shared/types'
import { buildHeaders } from '../engine/probe.ts'
import { getDispatcher } from '../engine/http.ts'

/**
 * Minimal HLS playlist parsing - enough to offer a quality ladder and to expand
 * a stream into the list of segments that have to be fetched.
 *
 * Only the tags that change what gets downloaded are handled: variants,
 * segments, byte ranges, encryption and the init segment. Everything else in the
 * spec is presentation metadata a downloader does not need.
 */

export interface HlsSegment {
  url: string
  /** Present when the segment is a byte range of a larger resource. */
  byteRange: { offset: number; length: number } | null
  /** AES-128 key info, resolved to an absolute URL. */
  key: { url: string; iv: string | null } | null
  duration: number
}

export interface MediaPlaylist {
  segments: HlsSegment[]
  /** fMP4 streams start with an initialisation segment that is not a media one. */
  initSegment: string | null
  totalDuration: number
  /** Sequence number of the first segment, used for AES IV calculation. */
  mediaSequence: number
  /** A live playlist has no end tag; downloading one would never finish. */
  isLive: boolean
}

async function fetchText(url: string, headers: RequestHeaders | undefined): Promise<string> {
  const res = await fetch(url, {
    headers: buildHeaders(headers),
    redirect: 'follow',
    dispatcher: getDispatcher(30_000)
  } as RequestInit)

  if (!res.ok) throw new Error(`Playlist request failed with ${res.status}`)
  return res.text()
}

/** Splits `KEY=VALUE,KEY="quoted,value"` without breaking on commas inside quotes. */
function parseAttributes(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  let match: RegExpExecArray | null

  while ((match = re.exec(line))) {
    out[match[1]] = match[2].replace(/^"|"$/g, '')
  }
  return out
}

function resolve(url: string, base: string): string {
  try {
    return new URL(url, base).toString()
  } catch {
    return url
  }
}

export function isMasterPlaylist(text: string): boolean {
  return text.includes('#EXT-X-STREAM-INF')
}

/** Reads the quality ladder out of a master playlist. */
export function parseMaster(text: string, baseUrl: string): MediaVariant[] {
  const lines = text.split(/\r?\n/)
  const variants: MediaVariant[] = []
  
  // A group can have multiple audio tracks (languages). We just need the first
  // one marked DEFAULT, or any if none are.
  const audioGroups = new Map<string, string>()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
      const attrs = parseAttributes(line)
      if (attrs['GROUP-ID'] && attrs.URI) {
        if (!audioGroups.has(attrs['GROUP-ID']) || attrs.DEFAULT === 'YES') {
          audioGroups.set(attrs['GROUP-ID'], resolve(attrs.URI, baseUrl))
        }
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue

    const attrs = parseAttributes(line)
    const uri = lines[i + 1]?.trim()
    if (!uri || uri.startsWith('#')) continue

    const resolution = attrs.RESOLUTION ?? ''
    const height = /\d+x(\d+)/.exec(resolution)?.[1]
    const bandwidth = Number(attrs['AVERAGE-BANDWIDTH'] ?? attrs.BANDWIDTH) || null
    
    let audioUrl = null
    if (attrs.AUDIO && audioGroups.has(attrs.AUDIO)) {
      audioUrl = audioGroups.get(attrs.AUDIO) ?? null
    }

    variants.push({
      url: resolve(uri, baseUrl),
      audioUrl,
      label: height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)} kbps` : 'stream',
      height: height ? Number(height) : null,
      bandwidth,
      codecs: attrs.CODECS ?? null,
      estimatedSize: null
    })
  }

  // Best first, which is what the picker should default to.
  return variants.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bandwidth ?? 0) - (a.bandwidth ?? 0))
}

export function parseMediaPlaylist(text: string, baseUrl: string): MediaPlaylist {
  const lines = text.split(/\r?\n/)
  const segments: HlsSegment[] = []

  let duration = 0
  let pendingDuration = 0
  let pendingRange: { offset: number; length: number } | null = null
  let currentKey: { url: string; iv: string | null } | null = null
  let initSegment: string | null = null
  let nextOffset = 0
  let mediaSequence = 0

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice(8)) || 0
      continue
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.slice(22), 10) || 0
      continue
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      // `length[@offset]`; a missing offset continues from the previous segment.
      const [len, off] = line.slice(17).split('@')
      const length = Number(len) || 0
      const offset = off !== undefined ? Number(off) : nextOffset
      pendingRange = { offset, length }
      nextOffset = offset + length
      continue
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice(11))
      currentKey =
        attrs.METHOD && attrs.METHOD !== 'NONE' && attrs.URI
          ? { url: resolve(attrs.URI, baseUrl), iv: attrs.IV ?? null }
          : null
      continue
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice(11))
      if (attrs.URI) initSegment = resolve(attrs.URI, baseUrl)
      continue
    }

    if (line.startsWith('#')) continue

    segments.push({
      url: resolve(line, baseUrl),
      byteRange: pendingRange,
      key: currentKey,
      duration: pendingDuration
    })

    duration += pendingDuration
    pendingDuration = 0
    pendingRange = null
  }

  return {
    segments,
    initSegment,
    totalDuration: duration,
    mediaSequence,
    // Without ENDLIST the server is still appending segments, so there is no
    // "whole file" to download.
    isLive: !text.includes('#EXT-X-ENDLIST')
  }
}

/** Fetches a URL and returns its quality ladder, or a single entry for a plain file. */
export async function resolveVariants(
  url: string,
  headers: RequestHeaders | undefined
): Promise<MediaVariant[]> {
  const text = await fetchText(url, headers)

  if (isMasterPlaylist(text)) {
    const variants = parseMaster(text, url)
    if (variants.length > 0) {
      // Fetch the top variant to find the duration, then estimate sizes for all
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

  const playlist = parseMediaPlaylist(text, url)
  return [
    {
      url,
      label: playlist.isLive ? 'live stream' : 'stream',
      height: null,
      bandwidth: null,
      codecs: null,
      estimatedSize: playlist.totalDuration > 0 ? null : null // single streams rarely have bandwidth
    }
  ]
}

export async function loadMediaPlaylist(
  url: string,
  headers: RequestHeaders | undefined
): Promise<MediaPlaylist> {
  const text = await fetchText(url, headers)

  if (isMasterPlaylist(text)) {
    // Handed a master by mistake: take the best variant rather than failing.
    const best = parseMaster(text, url)[0]
    if (best) return loadMediaPlaylist(best.url, headers)
  }

  return parseMediaPlaylist(text, url)
}
