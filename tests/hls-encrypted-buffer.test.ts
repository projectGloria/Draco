import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  EncryptedSegmentBuffer,
  EncryptedSegmentTooLargeError,
  MAX_ENCRYPTED_SEGMENT_BYTES
} from '../src/main/hls/encrypted-buffer.ts'

test('encrypted HLS buffering stops at 32 MiB and releases bytes on retry', () => {
  const buffer = new EncryptedSegmentBuffer()
  buffer.write(Buffer.alloc(MAX_ENCRYPTED_SEGMENT_BYTES, 1))
  assert.throws(() => buffer.write(Buffer.from([2])), EncryptedSegmentTooLargeError)
  buffer.reset()
  buffer.write(Buffer.from('new attempt'))
  assert.equal(buffer.value().toString(), 'new attempt')
})
