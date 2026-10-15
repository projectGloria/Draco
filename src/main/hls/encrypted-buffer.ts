export const MAX_ENCRYPTED_SEGMENT_BYTES = 32 * 1024 * 1024

export class EncryptedSegmentTooLargeError extends Error {
  constructor() {
    super('Encrypted HLS segment exceeds 32 MiB; this stream needs smaller segments')
  }
}

/** Holds one AES-CBC segment until decryption, with a strict memory ceiling. */
export class EncryptedSegmentBuffer {
  private chunks: Buffer[] = []
  private size = 0

  reset(): void {
    this.chunks = []
    this.size = 0
  }

  write(chunk: Buffer): void {
    if (chunk.length > MAX_ENCRYPTED_SEGMENT_BYTES - this.size) {
      throw new EncryptedSegmentTooLargeError()
    }
    this.size += chunk.length
    this.chunks.push(chunk)
  }

  value(): Buffer {
    return Buffer.concat(this.chunks, this.size)
  }
}
