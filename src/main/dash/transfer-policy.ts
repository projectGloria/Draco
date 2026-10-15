import type { RateLimiter } from '../engine/limiter.ts'

/** ffmpeg fetches MPD segments outside the limiter, so these policies cannot apply. */
export function unsupportedMpdPolicy(limiter: RateLimiter): string | null {
  if (!limiter.hasSpeedLimit && !limiter.hasTransferQuota) return null
  return 'MPEG-DASH downloads cannot honor the active speed limit or transfer quota because ffmpeg handles their network traffic. Turn off those limits before retrying this download.'
}
