/**
 * The wire format shared by the extension, the Go host and this app.
 *
 * It is deliberately identical to Chrome's own native-messaging framing -
 * 4-byte little-endian length followed by UTF-8 JSON - so the host can relay
 * frames through without parsing or re-encoding them.
 */

import type { MediaAudioTrack, PageFormat, SubtitleTrack } from '../../shared/types.ts'
import { preparedYouTubeUrl } from '../youtube-url.ts'
import { validateUrl } from '../engine/create.ts'

/** Chrome's own cap on a single native message. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

/** How many downloads one bulk action may enqueue in a single frame. */
export const MAX_BATCH_ITEMS = 500

export interface PingMessage {
  type: 'ping'
  /** Stable per-call identity; lets the app deduplicate native-host retries. */
  requestId?: string
}

/** The extension asks what it should be intercepting before it intercepts. */
export interface ConfigMessage {
  type: 'config'
  requestId?: string
}

export interface DownloadMessage {
  type: 'download'
  requestId?: string
  url: string
  filename?: string
  referer?: string
  cookie?: string
  userAgent?: string
  /** Bytes, when the browser already knows. Used against the size threshold. */
  size?: number | null
  mimeType?: string | null
  /**
   * Part of a bulk action such as "download all links". These skip the confirm
   * window - forty Save As dialogs in a row is not a feature.
   */
  bulk?: boolean
}

/**
 * A batch of downloads from one bulk action, in a single frame.
 *
 * `sendNativeMessage` starts a fresh host process per call, so "download all
 * links" on a page with two hundred links used to mean two hundred sequential
 * process launches, pipe connections and log appends. One frame carries the
 * lot; the app queues them the way a bulk `download` message is queued, with
 * no confirm window.
 */
export interface DownloadBatchMessage {
  type: 'downloadBatch'
  requestId?: string
  referer?: string
  userAgent?: string
  items: Array<{ url: string; filename?: string; cookie?: string }>
}

export interface YouTubeMessage {
  type: 'youtube'
  requestId?: string
  pageUrl: string
  pageTitle: string
  referer?: string
  cookie?: string
  userAgent?: string
  /**
   * The quality ladder as the page itself already knows it, so the picker can
   * be shown at once instead of after a yt-dlp round trip.
   *
   * Metadata only. These entries name formats by itag and carry no URL, because
   * this side of the bridge is web content and must never be able to choose
   * what the app fetches - only what it lists.
   */
  pageFormats?: PageFormat[]
}

/**
 * Warms YouTube extraction before a download click.
 *
 * Only when Draco is already running. The extension sends this on every
 * YouTube page load, so the native host deliberately refuses to cold-start the
 * app for it - browsing must not launch a download manager.
 */
export interface YouTubePrimeMessage {
  type: 'youtubePrime'
  requestId?: string
  pageUrl: string
  referer?: string
  cookie?: string
  userAgent?: string
}

export interface MediaMessage {
  type: 'media'
  requestId?: string
  pageUrl: string
  pageTitle: string
  mediaUrl: string
  relatedMediaUrls?: string[]
  audioUrl?: string | null
  variants?: any[]
  subtitles?: SubtitleTrack[]
  kind: 'hls' | 'dash' | 'file'
  width?: number | null
  height?: number | null
  referer?: string
  origin?: string
  cookie?: string
  userAgent?: string
  extraHeaders?: Record<string, string>
}

export type HostMessage =
  | PingMessage
  | ConfigMessage
  | DownloadMessage
  | MediaMessage
  | DownloadBatchMessage
  | YouTubeMessage
  | YouTubePrimeMessage

export interface HostReply {
  ok: boolean
  /** Only meaningful for `download`: whether Draco took the job. */
  taken?: boolean
  /** Only meaningful for `downloadBatch`: how many of the items were queued. */
  queued?: number
  error?: string
  config?: {
    enabled: boolean
    minSize: number
    extensions: string[]
    excludeHosts: string[]
  }
  version?: string
  /** Only meaningful for youtubePrime. */
  primed?: boolean
}

/** Splits a growing buffer into complete frames, returning the leftover tail. */
export function readFrames(buffer: Buffer): { frames: unknown[]; rest: Buffer } {
  const frames: unknown[] = []
  let offset = 0

  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset)

    // A bogus length would otherwise have us buffer forever waiting for bytes
    // that are never coming.
    if (length > MAX_FRAME_BYTES) throw new Error(`Frame of ${length} bytes exceeds the limit`)
    if (buffer.length - offset - 4 < length) break

    const body = buffer.subarray(offset + 4, offset + 4 + length)
    offset += 4 + length

    try {
      frames.push(JSON.parse(body.toString('utf8')))
    } catch {
      throw new Error('Frame was not valid JSON')
    }
  }

  return { frames, rest: buffer.subarray(offset) }
}

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`Frame of ${body.length} bytes exceeds the limit`)
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

function nullableDimension(value: unknown, label: string): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 32_768) {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

const UNSAFE_CAPTURED_HEADERS = new Set([
  'accept-encoding', 'connection', 'content-length', 'cookie', 'host',
  'proxy-authorization', 'proxy-connection', 'range', 'referer',
  'transfer-encoding', 'upgrade', 'user-agent'
])

function normalizeCapturedHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid extraHeaders')

  const result: Record<string, string> = {}
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 40) throw new Error('Too many extraHeaders')
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase()
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(name)) throw new Error('Invalid extraHeaders name')
    if (UNSAFE_CAPTURED_HEADERS.has(name)) continue
    if (typeof rawValue !== 'string' || rawValue.length > 16_384 || /[\r\n]/.test(rawValue)) {
      throw new Error(`Invalid extraHeaders value for ${name}`)
    }
    result[name] = rawValue
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function normalizeRelatedMediaUrls(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid relatedMediaUrls')
  const urls: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 32_768) throw new Error('Invalid related media URL')
    try {
      const parsed = new URL(item)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch {
      throw new Error('Invalid related media URL')
    }
    if (!urls.includes(item)) urls.push(item)
  }
  return urls.length > 0 ? urls : undefined
}


export function validateHostMessage(value: unknown): HostMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Native message must be an object')
  }
  const message = value as Record<string, unknown>
  const type = message.type
  if (typeof type !== 'string') throw new Error('Native message type is missing')

  const requestId = message.requestId === undefined || message.requestId === null
    ? undefined
    : typeof message.requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(message.requestId)
      ? message.requestId
      : (() => { throw new Error('Invalid requestId') })()

  const stringField = (name: string, max = 16_384): string | undefined => {
    const v = message[name]
    if (v === undefined || v === null) return undefined
    if (typeof v !== 'string' || v.length > max) throw new Error(`Invalid ${name}`)
    return v
  }
  const urlField = (name: string): string => {
    const v = stringField(name, 32_768)
    if (!v) throw new Error(`Missing ${name}`)
    try {
      const u = new URL(v)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error()
    } catch {
      throw new Error(`Invalid ${name}`)
    }
    return v
  }
  const optionalUrl = (name: string): string | undefined => {
    const v = stringField(name, 32_768)
    if (!v) return undefined
    try {
      const u = new URL(v)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error()
    } catch {
      throw new Error(`Invalid ${name}`)
    }
    return v
  }

  switch (type) {
    case 'ping':
    case 'config':
      return { type, ...(requestId ? { requestId } : {}) } as HostMessage
    case 'download': {
      const size = message.size
      if (size !== undefined && size !== null && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)) {
        throw new Error('Invalid size')
      }
      const bulk = message.bulk
      if (bulk !== undefined && typeof bulk !== 'boolean') throw new Error('Invalid bulk flag')
      return {
        type,
        ...(requestId ? { requestId } : {}),
        url: urlField('url'),
        filename: stringField('filename', 512),
        referer: optionalUrl('referer'),
        cookie: stringField('cookie', 1_000_000),
        userAgent: stringField('userAgent', 1024),
        size: (size ?? null) as number | null,
        mimeType: stringField('mimeType', 1024) ?? null,
        bulk: bulk ?? false
      }
    }
    case 'downloadBatch': {
      const items = message.items
      if (!Array.isArray(items) || items.length === 0) throw new Error('Invalid items')
      // Bounded: this arrives from a page's own link list, and one frame must
      // not be able to enqueue an unbounded amount of work.
      if (items.length > MAX_BATCH_ITEMS) throw new Error('Too many items')

      const parsed = items.map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error(`Invalid item ${index}`)
        }
        const item = raw as Record<string, unknown>
        const url = item.url
        if (typeof url !== 'string' || url.length > 32_768) throw new Error(`Invalid item ${index} url`)
        try {
          const u = new URL(url)
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error()
        } catch {
          throw new Error(`Invalid item ${index} url`)
        }
        const filename = item.filename
        if (filename !== undefined && filename !== null && (typeof filename !== 'string' || filename.length > 512)) {
          throw new Error(`Invalid item ${index} filename`)
        }
        const cookie = item.cookie
        if (cookie !== undefined && cookie !== null && (typeof cookie !== 'string' || cookie.length > 1_000_000)) {
          throw new Error(`Invalid item ${index} cookie`)
        }
        return {
          url,
          ...(typeof filename === 'string' ? { filename } : {}),
          ...(typeof cookie === 'string' ? { cookie } : {})
        }
      })

      return {
        type,
        ...(requestId ? { requestId } : {}),
        referer: optionalUrl('referer'),
        userAgent: stringField('userAgent', 1024),
        items: parsed
      }
    }
    case 'youtube': {
      const pageFormats = message.pageFormats
      if (pageFormats !== undefined) {
        // A page can publish a long ladder, but not an unbounded one.
        if (!Array.isArray(pageFormats) || pageFormats.length > 100) {
          throw new Error('Invalid pageFormats')
        }
      }
      return {
        type,
        ...(requestId ? { requestId } : {}),
        pageUrl: urlField('pageUrl'),
        pageTitle: stringField('pageTitle', 1000) ?? '',
        referer: optionalUrl('referer'),
        cookie: stringField('cookie', 1_000_000),
        userAgent: stringField('userAgent', 1024),
        pageFormats: Array.isArray(pageFormats)
          ? pageFormats.map(normalizePageFormat)
          : undefined
      }
    }
    case 'youtubePrime': {
      return {
        type,
        ...(requestId ? { requestId } : {}),
        pageUrl: urlField('pageUrl'),
        referer: optionalUrl('referer'),
        cookie: stringField('cookie', 1_000_000),
        userAgent: stringField('userAgent', 1024)
      }
    }
    case 'media': {
      const kind = message.kind
      if (kind !== 'hls' && kind !== 'dash' && kind !== 'file') throw new Error('Invalid media kind')
      const variants = message.variants
      const subtitles = message.subtitles
      if (variants !== undefined) {
        if (!Array.isArray(variants) || variants.length > 50) throw new Error('Invalid variants')
        for (const variant of variants) normalizeMediaVariant(variant)
      }
      if (subtitles !== undefined && (!Array.isArray(subtitles) || subtitles.length > 20)) {
        throw new Error('Invalid subtitles')
      }
      const width = nullableDimension(message.width, 'width')
      const height = nullableDimension(message.height, 'height')
      const extraHeaders = normalizeCapturedHeaders(message.extraHeaders)
      const relatedMediaUrls = normalizeRelatedMediaUrls(message.relatedMediaUrls)
      return {
        type,
        ...(requestId ? { requestId } : {}),
        pageUrl: urlField('pageUrl'),
        pageTitle: stringField('pageTitle', 1000) ?? '',
        mediaUrl: urlField('mediaUrl'),
        relatedMediaUrls,
        audioUrl: (() => {
          const raw = optionalUrl('audioUrl')
          return raw ? validateUrl(raw, { allowPrivate: false }) : null
        })(),
        variants: Array.isArray(variants) ? variants.map(normalizeMediaVariant) : undefined,
        subtitles: Array.isArray(subtitles) ? subtitles.map(normalizeSubtitleTrack) : undefined,
        kind,
        width,
        height,
        referer: optionalUrl('referer'),
        origin: optionalUrl('origin'),
        cookie: stringField('cookie', 1_000_000),
        userAgent: stringField('userAgent', 1024),
        extraHeaders
      }
    }
    default:
      throw new Error(`Unsupported native message type: ${type}`)
  }
}

function normalizeSubtitleTrack(value: unknown): SubtitleTrack {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid subtitle track')
  const track = value as Record<string, unknown>
  const format = track.format
  if (format !== 'vtt' && format !== 'srt' && format !== 'ttml') throw new Error('Invalid subtitle format')
  return {
    url: validateUrl(requiredUrlValue(track.url, 'subtitle url'), { allowPrivate: false }),
    label: boundedString(track.label ?? '', 100, 'subtitle label'),
    language: track.language === null || track.language === undefined
      ? null
      : boundedString(track.language, 35, 'subtitle language'),
    format
  }
}

/**
 * Rebuilds a page format from scratch rather than trusting the object handed
 * over: every field is checked and anything else the page attached is dropped.
 */
function normalizePageFormat(value: unknown): PageFormat {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid page format')
  }
  const f = value as Record<string, unknown>

  const itag = f.itag
  if (typeof itag !== 'number' || !Number.isSafeInteger(itag) || itag < 0 || itag > 100_000) {
    throw new Error('Invalid page format itag')
  }
  const url = f.url === undefined || f.url === null
    ? null
    : preparedYouTubeUrl(f.url, itag)
  if (f.url !== undefined && f.url !== null && !url) {
    throw new Error('Invalid page format URL')
  }

  return {
    itag,
    mimeType:
      f.mimeType === undefined || f.mimeType === null
        ? null
        : boundedString(f.mimeType, 200, 'page format mimeType'),
    bitrate: nonNegativeNumber(f.bitrate, 'page format bitrate'),
    width: nonNegativeNumber(f.width, 'page format width'),
    height: nonNegativeNumber(f.height, 'page format height'),
    fps: nonNegativeNumber(f.fps, 'page format fps'),
    contentLength: nonNegativeNumber(f.contentLength, 'page format contentLength'),
    url
  }
}

function normalizeMediaVariant(value: unknown): {
  url: string
  audioUrl: string | null
  audioTracks?: MediaAudioTrack[]
  label: string | null
  height: number | null
  bandwidth: number | null
  codecs: string | null
  estimatedSize: number | null
  container: string | null
  youtube?: { videoFormatId: string; audioFormatId?: string | null; role?: 'video' | 'audio' }
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid media variant')
  const v = value as Record<string, unknown>
  const rawUrl = requiredUrlValue(v.url, 'variant url')
  const url = validateUrl(rawUrl, { allowPrivate: false })
  const rawAudioUrl = v.audioUrl === undefined || v.audioUrl === null ? null : optionalUrlValue(v.audioUrl, 'variant audioUrl')
  const audioUrl = rawAudioUrl ? validateUrl(rawAudioUrl, { allowPrivate: false }) : null
  const audioTracks = normalizeAudioTracks(v.audioTracks)
  const label = v.label === undefined || v.label === null ? null : boundedString(v.label, 200, 'variant label')
  const codecs = v.codecs === undefined || v.codecs === null ? null : boundedString(v.codecs, 1000, 'variant codecs')
  const height = nonNegativeNumber(v.height, 'height')
  const bandwidth = nonNegativeNumber(v.bandwidth, 'bandwidth')
  const estimatedSize = nonNegativeNumber(v.estimatedSize, 'estimatedSize')

  // Named on the wire so a page-derived ladder can say what the file will be,
  // but constrained to something that can only ever be a file extension.
  const container =
    v.container === undefined || v.container === null
      ? null
      : (() => {
          const text = boundedString(v.container, 8, 'variant container').toLowerCase()
          if (!/^[a-z0-9]{1,8}$/.test(text)) throw new Error('Invalid variant container')
          return text
        })()

  let youtube: { videoFormatId: string; audioFormatId?: string | null; role?: 'video' | 'audio' } | undefined
  if (v.youtube !== undefined) {
    if (!v.youtube || typeof v.youtube !== 'object' || Array.isArray(v.youtube)) throw new Error('Invalid YouTube variant')
    const y = v.youtube as Record<string, unknown>
    const videoFormatId = boundedString(y.videoFormatId, 200, 'YouTube video format id')
    if (!videoFormatId) throw new Error('Invalid YouTube video format id')
    const audioFormatId = y.audioFormatId === undefined || y.audioFormatId === null
      ? null
      : boundedString(y.audioFormatId, 200, 'YouTube audio format id')
    const role = y.role === undefined ? 'video' : boundedString(y.role, 10, 'YouTube media role')
    if (role !== 'video' && role !== 'audio') throw new Error('Invalid YouTube media role')
    youtube = { videoFormatId, audioFormatId, role }
  }

  return { url, audioUrl, ...(audioTracks ? { audioTracks } : {}), label, height, bandwidth, codecs, estimatedSize, container, ...(youtube ? { youtube } : {}) }
}

function normalizeAudioTracks(value: unknown): MediaAudioTrack[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid audio tracks')
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid audio track')
    const track = entry as Record<string, unknown>
    const rawTrackUrl = requiredUrlValue(track.url, `audio track ${index + 1} url`)
    return {
      url: validateUrl(rawTrackUrl, { allowPrivate: false }),
      label: boundedString(track.label ?? '', 100, 'audio track label'),
      language: track.language === undefined || track.language === null
        ? null
        : boundedString(track.language, 35, 'audio track language'),
      isDefault: track.isDefault === true
    }
  })
}

function boundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || value.length > max) throw new Error(`Invalid ${label}`)
  return value
}

function requiredUrlValue(value: unknown, label: string): string {
  return optionalUrlValue(value, label)
}

function optionalUrlValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 32_768) throw new Error(`Invalid ${label}`)
  try {
    const u = new URL(value)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error()
  } catch {
    throw new Error(`Invalid ${label}`)
  }
  return value
}

function nonNegativeNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid variant ${label}`)
  }
  return value
}
