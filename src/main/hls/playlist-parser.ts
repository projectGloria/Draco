import type { MediaVariant } from '../../shared/types.ts'

export interface HlsSegment {
  url: string
  byteRange: { offset: number; length: number } | null
  key: { url: string; iv: string | null } | null
  duration: number
}

export interface MediaPlaylist {
  segments: HlsSegment[]
  initSegment: { url: string; byteRange: { offset: number; length: number } | null } | null
  totalDuration: number
  mediaSequence: number
  isLive: boolean
}

/** Splits `KEY=VALUE,KEY="quoted,value"` without breaking on commas inside quotes. */
function parseAttributes(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-z0-9-]+)=("[^"]*"|[^,]*)/gi
  let match: RegExpExecArray | null

  while ((match = re.exec(line))) {
    out[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '')
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
    const height = /\d+x(\d+)/i.exec(resolution)?.[1]
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
  let pendingRange: { length: number; offset: number | null } | null = null
  let currentKey: { url: string; iv: string | null } | null = null
  let initSegment: { url: string; byteRange: { offset: number; length: number } | null } | null = null
  let mediaSequence = 0
  const nextRangeOffsetByUrl = new Map<string, number>()

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice(8)) || 0
      continue
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      const parsed = Number(line.slice(22))
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid HLS media sequence')
      mediaSequence = parsed
      continue
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const [len, off] = line.slice(17).split('@')
      const length = Number(len)
      const offset = off === undefined ? null : Number(off)
      if (!Number.isSafeInteger(length) || length <= 0 || (offset !== null && (!Number.isSafeInteger(offset) || offset < 0))) {
        throw new Error('Invalid HLS byte range')
      }
      pendingRange = { length, offset }
      continue
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice(11))
      const method = attrs.METHOD
      if (!method || method === 'NONE') {
        currentKey = null
      } else if (method === 'AES-128') {
        if (attrs.KEYFORMAT && attrs.KEYFORMAT !== 'identity') {
          throw new Error(`Unsupported HLS AES-128 key format: ${attrs.KEYFORMAT}`)
        }
        if (attrs.KEYFORMATVERSIONS && attrs.KEYFORMATVERSIONS !== '1') {
          throw new Error(`Unsupported HLS AES-128 key format version: ${attrs.KEYFORMATVERSIONS}`)
        }
        if (!attrs.URI) throw new Error('HLS AES-128 key is missing URI')
        if (attrs.IV && !/^0x[0-9a-f]{32}$/i.test(attrs.IV)) throw new Error('HLS IV must be a 128-bit hexadecimal value')
        currentKey = { url: resolve(attrs.URI, baseUrl), iv: attrs.IV ?? null }
      } else {
        throw new Error(`Unsupported HLS encryption method: ${method}`)
      }
      continue
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice(11))
      if (!attrs.URI) throw new Error('HLS initialization map is missing URI')
      let byteRange: { offset: number; length: number } | null = null
      if (attrs.BYTERANGE) {
        const [lengthText, offsetText] = attrs.BYTERANGE.split('@')
        const length = Number(lengthText)
        const offset = offsetText === undefined ? 0 : Number(offsetText)
        if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset) || offset < 0) {
          throw new Error('Invalid HLS initialization byte range')
        }
        byteRange = { offset, length }
      }
      initSegment = { url: resolve(attrs.URI, baseUrl), byteRange }
      continue
    }

    if (line.startsWith('#')) continue

    const url = resolve(line, baseUrl)
    let byteRange: { offset: number; length: number } | null = null
    if (pendingRange) {
      let offset = pendingRange.offset
      if (offset === null) {
        const previous = nextRangeOffsetByUrl.get(url)
        if (previous === undefined) throw new Error(`HLS byte range for ${url} has no previous offset`)
        offset = previous
      }
      byteRange = { offset, length: pendingRange.length }
      nextRangeOffsetByUrl.set(url, offset + pendingRange.length)
    }

    segments.push({
      url,
      byteRange,
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
    isLive: !text.includes('#EXT-X-ENDLIST')
  }
}

