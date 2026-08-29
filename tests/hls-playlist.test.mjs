import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMediaPlaylist, parseMaster } from '../src/main/hls/playlist-parser.ts'

test('HLS byte ranges continue per resource, not globally', () => {
  const text = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-BYTERANGE:5@10\n#EXTINF:1,\na.bin\n#EXT-X-BYTERANGE:3\n#EXTINF:1,\na.bin\n#EXT-X-BYTERANGE:4@0\n#EXTINF:1,\nb.bin\n#EXT-X-ENDLIST`
  const p = parseMediaPlaylist(text, 'https://cdn.test/root/')
  assert.deepEqual(p.segments.map(s => s.byteRange), [
    { offset: 10, length: 5 },
    { offset: 15, length: 3 },
    { offset: 0, length: 4 }
  ])
})

test('HLS rejects unsupported encryption methods instead of mis-decrypting them', () => {
  const text = `#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST`
  assert.throws(() => parseMediaPlaylist(text, 'https://cdn.test/'))
})

test('HLS rejects malformed AES IV values', () => {
  const text = `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1234\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST`
  assert.throws(() => parseMediaPlaylist(text, 'https://cdn.test/'))
})

test('HLS map byte ranges are retained', () => {
  const text = `#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@16"\n#EXTINF:1,seg.m4s\n#EXT-X-ENDLIST`
  const p = parseMediaPlaylist(text, 'https://cdn.test/v/')
  assert.deepEqual(p.initSegment, { url: 'https://cdn.test/v/init.mp4', byteRange: { offset: 16, length: 720 } })
})

test('HLS master parsing resolves audio groups and ranks video variants', () => {
  const text = `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/prog.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1",AUDIO="aud"\nvideo/360.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1",AUDIO="aud"\nvideo/720.m3u8`
  const v = parseMaster(text, 'https://cdn.test/master.m3u8')
  assert.equal(v[0].height, 720)
  assert.equal(v[0].audioUrl, 'https://cdn.test/audio/prog.m3u8')
})

test('HLS rejects unsupported AES-128 key formats instead of treating them as identity keys', () => {
  assert.throws(
    () => parseMediaPlaylist('#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\nseg.ts', 'https://cdn.example/stream/index.m3u8'),
    /Unsupported HLS AES-128 key format/
  )
})
