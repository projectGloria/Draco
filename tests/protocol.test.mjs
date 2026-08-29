import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeFrame, readFrames, validateHostMessage, MAX_FRAME_BYTES } from '../src/main/bridge/protocol.ts'

test('native-message framing survives split frames', () => {
  const input = Buffer.concat([encodeFrame({ type: 'ping' }), encodeFrame({ type: 'config' })])
  const first = readFrames(input.subarray(0, 6))
  assert.equal(first.frames.length, 0)
  const second = readFrames(Buffer.concat([first.rest, input.subarray(6)]))
  assert.deepEqual(second.frames, [{ type: 'ping' }, { type: 'config' }])
  assert.equal(second.rest.length, 0)
})

test('native-message validator rejects malformed and dangerous messages', () => {
  assert.deepEqual(validateHostMessage({ type: 'ping' }), { type: 'ping' })
  assert.throws(() => validateHostMessage({ type: 'download', url: 'file:///x' }))
  assert.throws(() => validateHostMessage({ type: 'download', url: 'https://example.com', bulk: 'yes' }))
  assert.throws(() => validateHostMessage({ type: 'media', pageUrl: 'https://example.com', pageTitle: '', mediaUrl: 'https://example.com/x', kind: 'file', variants: new Array(101).fill({}) }))
})

test('frame size guard rejects oversized frames', () => {
  const header = Buffer.alloc(4)
  header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0)
  assert.throws(() => readFrames(header))
})

test('native-message media variants are normalized to the supported shape', () => {
  const result = validateHostMessage({
    type: 'media',
    pageUrl: 'https://example.com/watch',
    pageTitle: 'Video',
    mediaUrl: 'https://cdn.example/master.m3u8',
    kind: 'hls',
    variants: [{
      url: 'https://cdn.example/1080.m3u8',
      label: '1080p',
      height: 1080,
      bandwidth: 4_000_000,
      codecs: 'avc1.640028',
      estimatedSize: 12_345,
      container: 'MP4',
      ignoredByCaller: { anything: true }
    }]
  })
  assert.deepEqual(result.variants, [{
    url: 'https://cdn.example/1080.m3u8',
    audioUrl: null,
    label: '1080p',
    height: 1080,
    bandwidth: 4_000_000,
    codecs: 'avc1.640028',
    estimatedSize: 12_345,
    container: 'mp4'
  }])
})

test('frame encoder rejects oversized payloads', async () => {
  const { encodeFrame, MAX_FRAME_BYTES } = await import('../src/main/bridge/protocol.ts')
  assert.throws(() => encodeFrame('x'.repeat(MAX_FRAME_BYTES + 1)), /exceeds the limit/)
})

test('native-message validator preserves a bounded request id', () => {
  assert.deepEqual(validateHostMessage({ type: 'download', requestId: 'abc-123', url: 'https://example.com/file.bin' }), {
    type: 'download', requestId: 'abc-123', url: 'https://example.com/file.bin', filename: undefined,
    referer: undefined, cookie: undefined, userAgent: undefined, size: null, mimeType: null, bulk: false
  })
  assert.throws(() => validateHostMessage({ type: 'ping', requestId: 'bad id' }))
  assert.throws(() => validateHostMessage({ type: 'ping', requestId: 'x'.repeat(129) }))
})
