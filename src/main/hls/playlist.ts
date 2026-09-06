import type { MediaVariant, RequestHeaders } from '../../shared/types.ts'
import { mapConcurrent } from '../engine/concurrency.ts'
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
      // BANDWIDTH is useful for sorting, but it is not trustworthy enough for
      // a size estimate. Sample a small number of media segments instead.
      const estimates = new Map<string, Promise<number | null>>()
      const estimate = (mediaUrl: string): Promise<number | null> => {
        let pending = estimates.get(mediaUrl)
        if (!pending) {
          pending = estimateMediaPlaylistSize(mediaUrl, headers).catch(() => null)
          estimates.set(mediaUrl, pending)
        }
        return pending
      }
      await mapConcurrent(variants, 2, async (variant) => {
        const videoSize = await estimate(variant.url)
        const audioUrls = [...new Set(variant.audioTracks?.map((track) => track.url) ?? [])]
        const sizes = [videoSize, ...await Promise.all(audioUrls.map((audioUrl) => estimate(audioUrl)))]
        variant.estimatedSize = sizes.every((size): size is number => size !== null)
          ? sizes.reduce((total, size) => total + size, 0)
          : null
      })
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

async function estimateMediaPlaylistSize(
  url: string,
  headers: RequestHeaders | undefined
): Promise<number | null> {
  const playlist = await loadMediaPlaylist(url, headers)
  if (playlist.isLive || playlist.totalDuration <= 0 || playlist.segments.length === 0) return null

  // Spread the probes across the whole programme. Capped at 6 to avoid
  // excessive round trips.
  const sampleCount = Math.min(6, playlist.segments.length)
  const positions = [...new Set(Array.from({ length: sampleCount }, (_, index) =>
    sampleCount === 1 ? 0 : Math.round((index * (playlist.segments.length - 1)) / (sampleCount - 1))
  ))]
  const samples = await mapConcurrent(positions, 8, async (position) => {
    const segment = playlist.segments[position]
    if (!segment || segment.duration <= 0) return null
    const size = segment.byteRange?.length ?? await remoteObjectSize(segment.url, headers)
    return size ? { size, duration: segment.duration } : null
  })
  const measured = samples.filter((sample): sample is { size: number; duration: number } => sample !== null)
  const sampledBytes = measured.reduce((total, sample) => total + sample.size, 0)
  const sampledDuration = measured.reduce((total, sample) => total + sample.duration, 0)

  if (sampledBytes <= 0 || sampledDuration <= 0) return null
  const estimate = Math.round((sampledBytes / sampledDuration) * playlist.totalDuration)
  return Number.isSafeInteger(estimate) && estimate > 0 ? estimate : null
}

async function remoteObjectSize(
  url: string,
  headers: RequestHeaders | undefined
): Promise<number | null> {
  const response = await fetch(url, {
    headers: { ...buildHeaders(headers), range: 'bytes=0-0' },
    redirect: 'follow',
    dispatcher: getDispatcher(30_000)
  } as RequestInit)
  try {
    if (!response.ok) return null
    const contentRange = response.headers.get('content-range')
    const rangedSize = contentRange ? Number(/\/(\d+)\s*$/.exec(contentRange)?.[1]) : NaN
    if (Number.isSafeInteger(rangedSize) && rangedSize > 0) return rangedSize

    const contentLength = Number(response.headers.get('content-length'))
    return Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : null
  } finally {
    await response.body?.cancel().catch(() => undefined)
  }
}

export async function loadMediaPlaylist(
  url: string,
  headers: RequestHeaders | undefined
): Promise<MediaPlaylist> {
  return loadMediaPlaylistDepth(url, headers, 0)
}

export interface HlsMediaInspection {
  hasVideo: boolean
  hasAudio: boolean
}

/**
 * Identifies split MPEG-TS renditions without relying on misleading URL/file
 * extensions. Some CDNs deliberately name TS chunks `.jpg`; the PAT/PMT inside
 * the packet is still authoritative about whether it carries video or audio.
 */
export async function inspectHlsMedia(
  url: string,
  headers: RequestHeaders | undefined
): Promise<HlsMediaInspection> {
  const playlist = await loadMediaPlaylist(url, headers)
  const sample = playlist.initSegment?.url ?? playlist.segments[0]?.url
  if (!sample) return { hasVideo: false, hasAudio: false }

  const response = await fetch(sample, {
    headers: { ...buildHeaders(headers), range: 'bytes=0-262143' },
    redirect: 'follow',
    dispatcher: getDispatcher(30_000)
  } as RequestInit)
  if (!response.ok) throw new Error(`HLS sample request failed with ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  return inspectTransportStream(bytes)
}

const VIDEO_STREAM_TYPES = new Set([0x01, 0x02, 0x10, 0x1b, 0x24, 0x42, 0xd1])
const AUDIO_STREAM_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87, 0xac])

export function inspectTransportStream(bytes: Uint8Array): HlsMediaInspection {
  let sync = -1
  for (let offset = 0; offset < Math.min(188, bytes.length); offset++) {
    if (bytes[offset] === 0x47 && bytes[offset + 188] === 0x47) {
      sync = offset
      break
    }
  }
  if (sync < 0) return { hasVideo: false, hasAudio: false }

  let pmtPid: number | null = null
  let hasVideo = false
  let hasAudio = false

  for (let packet = sync; packet + 188 <= bytes.length; packet += 188) {
    if (bytes[packet] !== 0x47) continue
    const payloadStart = (bytes[packet + 1] & 0x40) !== 0
    const pid = ((bytes[packet + 1] & 0x1f) << 8) | bytes[packet + 2]
    const control = (bytes[packet + 3] >> 4) & 0x03
    if (control !== 1 && control !== 3) continue
    let cursor = packet + 4
    if (control === 3) cursor += 1 + bytes[cursor]
    if (cursor >= packet + 188) continue
    if (payloadStart) cursor += 1 + bytes[cursor]
    if (cursor + 12 >= packet + 188) continue

    if (pid === 0 && bytes[cursor] === 0x00) {
      const sectionLength = ((bytes[cursor + 1] & 0x0f) << 8) | bytes[cursor + 2]
      const end = Math.min(cursor + 3 + sectionLength - 4, packet + 188)
      for (let entry = cursor + 8; entry + 4 <= end; entry += 4) {
        const program = (bytes[entry] << 8) | bytes[entry + 1]
        if (program !== 0) {
          pmtPid = ((bytes[entry + 2] & 0x1f) << 8) | bytes[entry + 3]
          break
        }
      }
      continue
    }

    if (pmtPid !== null && pid === pmtPid && bytes[cursor] === 0x02) {
      const sectionLength = ((bytes[cursor + 1] & 0x0f) << 8) | bytes[cursor + 2]
      const programInfoLength = ((bytes[cursor + 10] & 0x0f) << 8) | bytes[cursor + 11]
      const end = Math.min(cursor + 3 + sectionLength - 4, packet + 188)
      for (let entry = cursor + 12 + programInfoLength; entry + 5 <= end;) {
        const streamType = bytes[entry]
        if (VIDEO_STREAM_TYPES.has(streamType)) hasVideo = true
        if (AUDIO_STREAM_TYPES.has(streamType)) hasAudio = true
        const infoLength = ((bytes[entry + 3] & 0x0f) << 8) | bytes[entry + 4]
        entry += 5 + infoLength
      }
      if (hasVideo || hasAudio) break
    }
  }

  return { hasVideo, hasAudio }
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
