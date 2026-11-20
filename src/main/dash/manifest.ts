import type { MediaVariant, RequestHeaders } from '../../shared/types.ts'
import { documentIsPrivate, fetchGuarded } from '../fetch-guard.ts'
import { readResponseText } from '../response-limit.ts'
import { isPrivateHost } from '../engine/create.ts'
import { hostResolvesPrivate } from '../engine/http.ts'
import { buildHeaders } from '../engine/probe.ts'

export interface MpdSummary {
  durationSeconds: number | null
  dynamic: boolean
  videoRepresentations: number
  audioRepresentations: number
  maxHeight: number | null
  maxBandwidth: number | null
  codecs: string[]
}

/** A manifest can be inspected safely, but encrypted media is never bypassed. */
export interface MpdSource {
  /** Where the manifest was fetched from (its final URL). Relative URLs resolve against it. */
  url?: string
  /**
   * The manifest's host is on a private network (by where it resolves). A LAN
   * server pointing at itself or a neighbour is expected; only a public
   * manifest reaching into a private network is refused, matching HLS.
   */
  private?: boolean
}

/** Every address the manifest declares: BaseURLs plus absolute SegmentTemplate/SegmentURL ones. */
function declaredAddresses(xml: string): string[] {
  const out: string[] = []
  for (const match of xml.matchAll(/<BaseURL\b[^>]*>([\s\S]*?)<\/BaseURL>/gi)) out.push(match[1].trim())
  for (const match of xml.matchAll(/<(?:SegmentTemplate|SegmentURL|Initialization|RepresentationIndex)\b([^>]*)>/gi)) {
    for (const name of ['media', 'initialization', 'index', 'sourceURL']) {
      const value = attribute(match[1], name)
      // Only absolute addresses can leave the manifest's own host.
      if (value && /^[a-z][a-z0-9+.-]*:/i.test(value.trim())) out.push(value.trim())
    }
  }
  return out
}

function assertSafeAddresses(xml: string, source: MpdSource): void {
  const base = source.url ?? 'https://placeholder.invalid'
  for (const raw of declaredAddresses(xml)) {
    let parsed: URL
    try {
      // `$Number$`-style template identifiers are not valid in a host, but
      // they only appear in paths; parse with them blanked out.
      parsed = new URL(raw.replace(/\$[A-Za-z]+(?:%0\d+d)?\$/g, '0'), base)
    } catch {
      continue
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('DASH manifest specifies an invalid or private BaseURL')
    }
    if (!source.private && parsed.hostname && isPrivateHost(parsed.hostname)) {
      throw new Error('DASH manifest specifies an invalid or private BaseURL')
    }
  }
}

export function inspectMpd(xml: string, source: MpdSource = {}): MpdSummary {
  if (!/<MPD\b/i.test(xml)) throw new Error('The server did not return an MPEG-DASH manifest')

  const protection = [...xml.matchAll(/<ContentProtection\b([^>]*)>/gi)]
  if (protection.length > 0) {
    const declarations = protection.map((match) => match[1]).join(' ')
    let system = 'DRM or encrypted media'
    if (/widevine|edef8ba9/i.test(declarations)) system = 'Widevine DRM'
    else if (/playready|9a04f079/i.test(declarations)) system = 'PlayReady DRM'
    else if (/fairplay|94ce86fb/i.test(declarations)) system = 'FairPlay DRM'
    else if (/clearkey|e2719d58/i.test(declarations)) system = 'ClearKey DRM'
    throw new Error(`${system} is protected and cannot be downloaded by Draco`)
  }

  assertSafeAddresses(xml, source)

  const mpdTag = /<MPD\b([^>]*)>/i.exec(xml)?.[1] ?? ''
  const durationText = attribute(mpdTag, 'mediaPresentationDuration')
  const durationSeconds = durationText ? parseIsoDuration(durationText) : null
  const dynamic = attribute(mpdTag, 'type')?.toLowerCase() === 'dynamic'

  let videoRepresentations = 0
  let audioRepresentations = 0
  let maxHeight: number | null = null
  let maxBandwidth: number | null = null
  const codecs = new Set<string>()

  for (const adaptation of xml.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)) {
    const adaptationAttrs = adaptation[1]
    const body = adaptation[2]
    const contentType = (
      attribute(adaptationAttrs, 'contentType') ??
      attribute(adaptationAttrs, 'mimeType') ??
      ''
    ).toLowerCase()
    const representations = [...body.matchAll(/<Representation\b([^>]*)/gi)]
    const count = Math.max(1, representations.length)

    if (contentType.includes('video')) videoRepresentations += count
    else if (contentType.includes('audio')) audioRepresentations += count

    for (const representation of representations) {
      const attrs = representation[1]
      const mime = (attribute(attrs, 'mimeType') ?? contentType).toLowerCase()
      if (!contentType) {
        if (mime.includes('video')) videoRepresentations++
        else if (mime.includes('audio')) audioRepresentations++
      }
      const height = numberAttribute(attrs, 'height')
      const bandwidth = numberAttribute(attrs, 'bandwidth')
      if (height !== null) maxHeight = Math.max(maxHeight ?? 0, height)
      if (bandwidth !== null) maxBandwidth = Math.max(maxBandwidth ?? 0, bandwidth)
      const codec = attribute(attrs, 'codecs') ?? attribute(adaptationAttrs, 'codecs')
      if (codec) codecs.add(codec)
    }
  }

  return {
    durationSeconds,
    dynamic,
    videoRepresentations,
    audioRepresentations,
    maxHeight,
    maxBandwidth,
    codecs: [...codecs]
  }
}

export async function resolveMpd(
  url: string,
  headers: RequestHeaders,
  timeoutMs = 30_000,
  signal?: AbortSignal
): Promise<{ summary: MpdSummary; variants: MediaVariant[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal

  try {
    const startsPrivate = await hostResolvesPrivate(new URL(url).hostname)
    const response = await fetchGuarded(url, {
      headers: buildHeaders(headers),
      signal: requestSignal,
      timeoutMs,
      startsPrivate
    })
    let xml: string
    try {
      if (!response.ok) throw new Error(`Could not fetch DASH manifest (HTTP ${response.status})`)
      xml = await readResponseText(response, 10_000_000)
    } finally {
      await response.body?.cancel().catch(() => {})
    }
    const manifestUrl = response.url || url
    const summary = inspectMpd(xml, {
      url: manifestUrl,
      private: documentIsPrivate(url, manifestUrl, startsPrivate)
    })
    if (summary.dynamic) throw new Error('Live MPEG-DASH streams are not supported yet')

    const detail = summary.maxHeight ? `${summary.maxHeight}p max` : 'automatic quality'
    const tracks = [
      summary.videoRepresentations ? `${summary.videoRepresentations} video` : null,
      summary.audioRepresentations ? `${summary.audioRepresentations} audio` : null
    ].filter(Boolean).join(', ')

    return {
      summary,
      variants: [{
        url: response.url || url,
        label: `Best available (${detail}${tracks ? `; ${tracks}` : ''})`,
        height: summary.maxHeight,
        bandwidth: summary.maxBandwidth,
        codecs: summary.codecs.join(', ') || null,
        estimatedSize: null,
        container: 'mp4'
      }]
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Timed out fetching the DASH manifest')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function parseIsoDuration(value: string): number | null {
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value)
  if (!match) return null
  const seconds =
    Number(match[1] ?? 0) * 86_400 +
    Number(match[2] ?? 0) * 3_600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0)
  return Number.isFinite(seconds) ? seconds : null
}

function attribute(source: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(source)
  return match?.[2] ?? null
}

function numberAttribute(source: string, name: string): number | null {
  const value = attribute(source, name)
  if (!value || !/^\d+$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}
