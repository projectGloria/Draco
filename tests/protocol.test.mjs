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

test('native-message subtitle tracks are bounded and normalized', () => {
  const result = validateHostMessage({
    type: 'media',
    pageUrl: 'https://example.com/watch',
    pageTitle: 'Video',
    mediaUrl: 'https://cdn.example/video.mp4',
    kind: 'file',
    subtitles: [{
      url: 'https://cdn.example/en.vtt',
      label: 'English',
      language: 'en',
      format: 'vtt',
      ignored: true
    }]
  })
  assert.deepEqual(result.subtitles, [{
    url: 'https://cdn.example/en.vtt', label: 'English', language: 'en', format: 'vtt'
  }])
  assert.throws(() => validateHostMessage({
    type: 'media', pageUrl: 'https://example.com', pageTitle: '',
    mediaUrl: 'https://cdn.example/video.mp4', kind: 'file',
    subtitles: [{ url: 'javascript:bad', label: '', language: null, format: 'vtt' }]
  }))
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

test('YouTube page formats accept only matching Googlevideo resources', () => {
  const direct = 'https://rr2---sn.example.googlevideo.com/videoplayback?itag=137&expire=9999999999'
  const result = validateHostMessage({
    type: 'youtube', pageUrl: 'https://www.youtube.com/watch?v=abc', pageTitle: 'Video',
    pageFormats: [{
      itag: 137, mimeType: 'video/mp4', bitrate: 1, width: 1, height: 1,
      fps: 1, contentLength: 1, url: direct
    }]
  })
  assert.equal(result.pageFormats[0].url, direct)

  for (const url of [
    'https://evil.example/videoplayback?itag=137',
    'https://rr2.googlevideo.com/videoplayback?itag=140',
    'http://rr2.googlevideo.com/videoplayback?itag=137'
  ]) {
    assert.throws(() => validateHostMessage({
      type: 'youtube', pageUrl: 'https://www.youtube.com/watch?v=abc', pageTitle: 'Video',
      pageFormats: [{
        itag: 137, mimeType: 'video/mp4', bitrate: 1, width: 1, height: 1,
        fps: 1, contentLength: 1, url
      }]
    }), /Invalid page format URL/)
  }
})

test('YouTube prefetch messages retain only bounded browser context', () => {
  assert.deepEqual(validateHostMessage({
    type: 'youtubePrime', requestId: 'prime-1',
    pageUrl: 'https://www.youtube.com/watch?v=abc',
    referer: 'https://www.youtube.com/watch?v=abc',
    cookie: 'session=example', userAgent: 'Browser'
  }), {
    type: 'youtubePrime', requestId: 'prime-1',
    pageUrl: 'https://www.youtube.com/watch?v=abc',
    referer: 'https://www.youtube.com/watch?v=abc',
    cookie: 'session=example', userAgent: 'Browser'
  })
  assert.throws(() => validateHostMessage({
    type: 'youtubePrime', pageUrl: 'file:///not-youtube'
  }))
})
