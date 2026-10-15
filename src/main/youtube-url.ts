/**
 * Which format a task is actually fetching.
 *
 * `videoFormatId` names the *primary* stream, not necessarily the video one:
 * which stream that is depends on the role. `DashRunner` splits a merged
 * download into two children that share one `youtube` block, so the audio half
 * has to resolve `audioFormatId`; an audio-only download (a music variant)
 * carries its single format in `videoFormatId` with no `audioFormatId` beside
 * it, which is why the fallback matters.
 *
 * Reading `videoFormatId` unconditionally made the audio half of every merged
 * download resolve the *video* itag. Both halves then fetched the same stream:
 * the task reported twice the video's size, and the mux failed because the file
 * handed to ffmpeg as audio held no audio track.
 */
export function youtubeFormatId(youtube: {
  videoFormatId: string
  audioFormatId?: string | null
  role?: 'video' | 'audio'
}): string {
  return youtube.role === 'audio'
    ? youtube.audioFormatId || youtube.videoFormatId
    : youtube.videoFormatId
}

/**
 * YouTube media handed over by the extension is accepted only from Google's
 * media CDN and only when its itag matches the format the page described.
 */
export function preparedYouTubeUrl(value: unknown, itag?: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 20_000) return null

  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return null
    if (!/(^|\.)googlevideo\.com$/i.test(url.hostname)) return null
    if (!/\/videoplayback$/i.test(url.pathname)) return null
    if (itag !== undefined && url.searchParams.get('itag') !== String(itag)) return null
    return url.href
  } catch {
    return null
  }
}

/**
 * Fixed YouTube media can be fetched in bounded requests even without an ETag.
 * Require Google's signed URL to bind the object, format, revision and length.
 * This permits chunks within one run, never journal resume or URL substitution.
 */
export function isFixedYouTubeResource(value: string, size: number | null): boolean {
  if (!preparedYouTubeUrl(value) || size === null || !Number.isSafeInteger(size) || size <= 0) return false
  const params = new URL(value).searchParams
  const signed = new Set((params.get('sparams') ?? '').split(','))
  return params.get('source') === 'youtube' &&
    Boolean(params.get('sig') || params.get('signature')) &&
    ['id', 'itag', 'lmt', 'clen'].every((key) => signed.has(key) && Boolean(params.get(key))) &&
    /^\d+$/.test(params.get('itag') ?? '') &&
    /^\d+$/.test(params.get('lmt') ?? '') &&
    params.get('clen') === String(size)
}

/*
 * "Is this a YouTube page we handle?" now has exactly one implementation, in
 * `shared/youtube-link.ts`, which the renderer reads too. Re-exported here so
 * the callers in main did not all have to move, and imported with a relative
 * `.ts` specifier because this module is on the engine's import graph and has
 * to resolve under bare Node for `tools/dl.ts` and the engine tests.
 */
export { isSupportedYouTubeUrl } from '../shared/youtube-link.ts'

export function variantsPreparedForStart(variants: MediaVariant[]): boolean {
  return variants.length > 0 && variants.every((variant) =>
    Boolean(variant.url) &&
    (variant.youtube?.role === 'audio' || !variant.youtube?.audioFormatId || Boolean(variant.audioUrl))
  )
}

export function chosenYouTubeUrls(
  variants: MediaVariant[],
  pageUrl: string,
  youtube: { videoFormatId: string; audioFormatId?: string | null; role?: 'video' | 'audio' }
): { url: string; audioUrl: string | null } {
  const prepared = variants.find((variant) =>
    variant.youtube?.videoFormatId === youtube.videoFormatId &&
    (variant.youtube?.audioFormatId ?? null) === (youtube.audioFormatId ?? null) &&
    (variant.youtube?.role ?? 'video') === (youtube.role ?? 'video')
  )
  if (prepared?.url && (youtube.role === 'audio' || !youtube.audioFormatId || prepared.audioUrl)) {
    return {
      url: prepared.url,
      audioUrl: youtube.role === 'audio' ? null : youtube.audioFormatId ? prepared.audioUrl ?? null : null
    }
  }

  return {
    url: pageUrl,
    audioUrl: youtube.role === 'audio' ? null : youtube.audioFormatId ? pageUrl : null
  }
}
import type { MediaVariant } from '../shared/types.ts'
