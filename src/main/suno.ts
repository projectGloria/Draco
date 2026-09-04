import type { MediaVariant, RequestHeaders, YouTubeResolution } from '../shared/types.ts'

export async function resolveSuno(
  pageUrl: string,
  headers: RequestHeaders | undefined
): Promise<YouTubeResolution> {
  const parsed = new URL(pageUrl)
  const match = /^\/(?:song|s)\/([^/?#]+)/i.exec(parsed.pathname)
  if (!match) throw new Error('Not a supported Suno song URL')
  const id = match[1]

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        ...(headers?.userAgent ? { 'user-agent': headers.userAgent } : {}),
        ...(headers?.referer ? { referer: headers.referer } : {})
      }
    })
    if (!response.ok) throw new Error(`Suno returned HTTP ${response.status}`)
    return sunoMediaFromHtml(pageUrl, id, await response.text())
  } finally {
    clearTimeout(timer)
  }
}

export function sunoMediaFromHtml(pageUrl: string, id: string, html: string): YouTubeResolution {
  const title = metaContent(html, 'og:title')?.replace(/\s*[|·-]\s*Suno\s*$/i, '').trim() || 'Suno song'
  const advertisedAudio = safeSunoAsset(metaContent(html, 'og:audio'), 'mp3')
  const audioUrl = advertisedAudio && !/\/silence\.mp3(?:[?#]|$)/i.test(advertisedAudio)
    ? advertisedAudio
    : `https://cdn1.suno.ai/${encodeURIComponent(id)}.mp3`
  const thumbnailUrl = safeHttps(metaContent(html, 'og:image'))

  const variant: MediaVariant = {
    url: audioUrl,
    label: 'Audio · MP3',
    height: null,
    bandwidth: null,
    codecs: 'mp3',
    estimatedSize: null,
    container: 'mp3'
  }
  return { id, title, variants: [variant], thumbnailUrl }
}

function metaContent(html: string, key: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    const attrs = new Map<string, string>()
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gi)) {
      attrs.set(match[1].toLowerCase(), decodeHtml(match[3]))
    }
    if ((attrs.get('property') ?? attrs.get('name'))?.toLowerCase() === key.toLowerCase()) {
      return attrs.get('content') ?? null
    }
  }
  return null
}

function safeSunoAsset(value: string | null, extension: string): string | null {
  const safe = safeHttps(value)
  if (!safe) return null
  const parsed = new URL(safe)
  return /(^|\.)suno\.ai$/i.test(parsed.hostname) && new RegExp(`\\.${extension}$`, 'i').test(parsed.pathname)
    ? safe
    : null
}

function safeHttps(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}
