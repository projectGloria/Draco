import type { MediaVariant, RequestHeaders, YouTubeResolution } from '../shared/types.ts'
import { xStatusId } from '../shared/x-post.ts'
import { logger } from './log.ts'
import { fetchGuarded } from './fetch-guard.ts'
import { readResponseText } from './response-limit.ts'

const log = logger('twitter')

interface TwitterMediaDetail {
  type?: 'photo' | 'video' | 'animated_gif' | string
  media_url_https?: string
  original_info?: {
    width?: number
    height?: number
  }
  sizes?: {
    large?: { w?: number; h?: number }
    medium?: { w?: number; h?: number }
  }
  video_info?: {
    aspect_ratio?: [number, number]
    duration_millis?: number
    variants?: Array<{
      bitrate?: number
      content_type?: string
      url?: string
    }>
  }
}

interface TwitterTweetResult {
  text?: string
  user?: {
    name?: string
    screen_name?: string
    profile_image_url_https?: string
  }
  mediaDetails?: TwitterMediaDetail[]
  video?: {
    variants?: Array<{
      bitrate?: number
      content_type?: string
      url?: string
    }>
  }
}

/** Computes the verification token required by Twitter's syndication endpoint. */
export function tokenForTweet(id: string): string {
  // Snowflake IDs exceed Number.MAX_SAFE_INTEGER. The syndication token uses
  // JavaScript's floating-point conversion of the decimal ID intentionally.
  if (!/^\d{1,20}$/.test(id)) return ''
  const num = Number(id)
  if (!Number.isFinite(num) || num <= 0) return ''
  return ((num / 1e15) * Math.PI)
    .toString(36)
    .replace(/(0+|\.)/g, '')
}

/**
 * Resolves media from an X (Twitter) post via the syndication endpoint.
 * This directly extracts full-resolution photos, animated GIFs, and videos
 * without depending on external scrapers or authentication.
 */
export async function resolveTwitterPost(
  pageUrl: string,
  headers?: RequestHeaders
): Promise<YouTubeResolution | null> {
  const statusId = xStatusId(pageUrl)
  if (!statusId) return null

  const token = tokenForTweet(statusId)
  if (!token) return null

  const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(statusId)}&token=${encodeURIComponent(token)}&lang=en`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)

  try {
    const reqHeaders: Record<string, string> = {
      'user-agent':
        headers?.userAgent ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      accept: 'application/json'
    }

    const res = await fetchGuarded(syndicationUrl, {
      headers: reqHeaders,
      signal: controller.signal,
      timeoutMs: 15_000,
      requireHttps: true
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      log.warn(`syndication endpoint returned HTTP ${res.status} for tweet ${statusId}`)
      return null
    }

    const text = await readResponseText(res, 2 * 1024 * 1024)
    if (!text.startsWith('{')) return null

    const data = JSON.parse(text) as TwitterTweetResult
    const mediaList = data.mediaDetails ?? []
    if (mediaList.length === 0 && !data.video) {
      log.info(`tweet ${statusId} carries no declared media details`)
      return null
    }

    const variants: MediaVariant[] = []
    let primaryThumbnail: string | null = null

    let photoIndex = 1
    let videoIndex = 1

    const hasMultipleItems = mediaList.length > 1

    for (const item of mediaList) {
      if (item.type === 'photo' && item.media_url_https) {
        if (!primaryThumbnail) primaryThumbnail = item.media_url_https
        const width = item.original_info?.width ?? item.sizes?.large?.w ?? null
        const height = item.original_info?.height ?? item.sizes?.large?.h ?? null
        const dimLabel = width && height ? ` (${width}x${height})` : ''
        const photoUrl = item.media_url_https.includes('?')
          ? item.media_url_https
          : `${item.media_url_https}?name=orig`

        const extMatch = /\.([a-z0-9]+)(?:\?|$)/i.exec(item.media_url_https)
        const container = extMatch ? extMatch[1].toLowerCase() : 'jpg'

        variants.push({
          label: hasMultipleItems ? `Photo ${photoIndex++}${dimLabel}` : `Photo${dimLabel}`,
          container,
          url: photoUrl,
          audioUrl: null,
          height,
          bandwidth: null,
          codecs: null,
          estimatedSize: null
        })
      } else if ((item.type === 'video' || item.type === 'animated_gif') && item.video_info?.variants) {
        if (!primaryThumbnail && item.media_url_https) primaryThumbnail = item.media_url_https
        const mp4s = item.video_info.variants
          .filter((v) => v.url && /video\/mp4/i.test(v.content_type ?? ''))
          .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))

        const isGif = item.type === 'animated_gif'
        if (hasMultipleItems && !isGif) {
          const best = mp4s[0]
          if (best?.url) {
            const dimMatch = /\/(\d+)x(\d+)\//.exec(best.url)
            const h = dimMatch ? Number(dimMatch[2]) : null
            const w = dimMatch ? Number(dimMatch[1]) : null
            const resolvedHeight = h && w ? (h > w ? w : h) : h

            const label = `Video ${videoIndex}${resolvedHeight ? ` (${resolvedHeight}p)` : ''}`
            variants.push({
              label,
              container: 'mp4',
              url: best.url,
              audioUrl: null,
              height: resolvedHeight,
              bandwidth: best.bitrate ?? null,
              codecs: 'avc1',
              estimatedSize: null
            })
          }
        } else {
          for (const v of mp4s) {
            if (!v.url) continue
            // Derive height from dimensions in URL (e.g. /720x1280/) or bitrate
            const dimMatch = /\/(\d+)x(\d+)\//.exec(v.url)
            const h = dimMatch ? Number(dimMatch[2]) : null
            const w = dimMatch ? Number(dimMatch[1]) : null
            const resolvedHeight = h && w ? (h > w ? w : h) : h

            const label = isGif
              ? `GIF${dimMatch ? ` (${dimMatch[1]}x${dimMatch[2]})` : ''}`
              : resolvedHeight
                ? `${resolvedHeight}p`
                : v.bitrate
                  ? `${Math.round(v.bitrate / 1000)} kbps`
                  : `Video ${videoIndex}`

            variants.push({
              label,
              container: 'mp4',
              url: v.url,
              audioUrl: null,
              height: resolvedHeight,
              bandwidth: v.bitrate ?? null,
              codecs: 'avc1',
              estimatedSize: null
            })
          }
        }
        videoIndex++
      }
    }

    if (variants.length === 0 && data.video?.variants) {
      const mp4s = data.video.variants
        .filter((v) => v.url && /video\/mp4/i.test(v.content_type ?? ''))
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
      for (const v of mp4s) {
        if (!v.url) continue
        const dimMatch = /\/(\d+)x(\d+)\//.exec(v.url)
        const h = dimMatch ? Number(dimMatch[2]) : null
        const w = dimMatch ? Number(dimMatch[1]) : null
        const resolvedHeight = h && w ? (h > w ? w : h) : h
        const label = resolvedHeight ? `${resolvedHeight}p` : v.bitrate ? `${Math.round(v.bitrate / 1000)} kbps` : 'Video'
        variants.push({
          label,
          container: 'mp4',
          url: v.url,
          audioUrl: null,
          height: resolvedHeight,
          bandwidth: v.bitrate ?? null,
          codecs: 'avc1',
          estimatedSize: null
        })
      }
    }

    if (variants.length === 0) return null

    const userName = data.user?.name || data.user?.screen_name || 'X'
    const tweetSnippet = data.text ? data.text.trim().slice(0, 60).replace(/\s+/g, ' ') : ''
    const title = tweetSnippet ? `${userName}: "${tweetSnippet}"` : `${userName} on X`

    return {
      id: statusId,
      title,
      variants,
      thumbnailUrl: primaryThumbnail
    }
  } catch (err) {
    log.warn(`failed to resolve twitter post ${statusId}: ${String(err)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}
