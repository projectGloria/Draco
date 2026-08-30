import type { RequestHeaders } from '../../shared/types.ts'
import { buildHeaders } from '../engine/probe.ts'

/** Serializes captured browser headers for ffmpeg without permitting injection. */
export function ffmpegHeaders(headers: RequestHeaders): string {
  const values = buildHeaders(headers)
  return Object.entries(values)
    .filter(([name, value]) => !/[\r\n]/.test(name) && !/[\r\n]/.test(value))
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join('')
}
