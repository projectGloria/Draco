/**
 * The wire format shared by the extension, the Go host and this app.
 *
 * It is deliberately identical to Chrome's own native-messaging framing -
 * 4-byte little-endian length followed by UTF-8 JSON - so the host can relay
 * frames through without parsing or re-encoding them.
 */

/** Chrome's own cap on a single native message. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

export interface PingMessage {
  type: 'ping'
}

/** The extension asks what it should be intercepting before it intercepts. */
export interface ConfigMessage {
  type: 'config'
}

export interface DownloadMessage {
  type: 'download'
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

export interface MediaMessage {
  type: 'media'
  pageUrl: string
  pageTitle: string
  mediaUrl: string
  audioUrl?: string | null
  variants?: any[]
  kind: 'hls' | 'dash' | 'file'
  referer?: string
  cookie?: string
  userAgent?: string
}

export type HostMessage = PingMessage | ConfigMessage | DownloadMessage | MediaMessage

export interface HostReply {
  ok: boolean
  /** Only meaningful for `download`: whether Draco took the job. */
  taken?: boolean
  error?: string
  config?: {
    enabled: boolean
    minSize: number
    extensions: string[]
    excludeHosts: string[]
  }
  version?: string
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
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}
