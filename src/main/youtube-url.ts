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
 * The one answer to "is this a YouTube page we handle?".
 *
 * There used to be two, and they disagreed: the handoff path took `http:` but
 * refused `music.youtube.com`, while the priming path did the opposite - so a
 * video could be primed and then declined, or vice versa. Subdomains are in
 * (music, m, www), other protocols are not.
 */
export function isSupportedYouTubeUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    return /(^|\.)youtube\.com$/i.test(url.hostname) || /(^|\.)youtu\.be$/i.test(url.hostname)
  } catch {
    return false
  }
}

export function variantsPreparedForStart(variants: MediaVariant[]): boolean {
  return variants.length > 0 && variants.every((variant) =>
    Boolean(variant.url) && (!variant.youtube?.audioFormatId || Boolean(variant.audioUrl))
  )
}

export function chosenYouTubeUrls(
  variants: MediaVariant[],
  pageUrl: string,
  youtube: { videoFormatId: string; audioFormatId?: string | null }
): { url: string; audioUrl: string | null } {
  const prepared = variants.find((variant) =>
    variant.youtube?.videoFormatId === youtube.videoFormatId &&
    (variant.youtube?.audioFormatId ?? null) === (youtube.audioFormatId ?? null)
  )
  if (prepared?.url && (!youtube.audioFormatId || prepared.audioUrl)) {
    return {
      url: prepared.url,
      audioUrl: youtube.audioFormatId ? prepared.audioUrl ?? null : null
    }
  }

  return {
    url: pageUrl,
    audioUrl: youtube.audioFormatId ? pageUrl : null
  }
}
import type { MediaVariant } from '../shared/types.ts'
