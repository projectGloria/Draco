import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectMpd, parseIsoDuration } from '../src/main/dash/manifest.ts'
import { ffmpegHeaders } from '../src/main/dash/headers.ts'
import { filenameForKind, kindForUrl } from '../src/main/engine/create.ts'
import { subtitleFilename } from '../src/main/media/subtitles.ts'

const CLEAR_MPD = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT1H2M3.5S">
  <Period>
    <AdaptationSet contentType="video" codecs="avc1.640028">
      <Representation id="v1" bandwidth="2500000" height="1080" />
      <Representation id="v2" bandwidth="900000" height="720" />
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2" />
    </AdaptationSet>
  </Period>
</MPD>`

test('DASH manifest inspection reports duration and the best available representation', () => {
  const summary = inspectMpd(CLEAR_MPD)
  assert.equal(summary.durationSeconds, 3723.5)
  assert.equal(summary.dynamic, false)
  assert.equal(summary.videoRepresentations, 2)
  assert.equal(summary.audioRepresentations, 1)
  assert.equal(summary.maxHeight, 1080)
  assert.equal(summary.maxBandwidth, 2_500_000)
  assert.deepEqual(summary.codecs.sort(), ['avc1.640028', 'mp4a.40.2'])
})

test('DASH manifest inspection identifies common DRM systems clearly', () => {
  const protectedMpd = `<MPD><Period><AdaptationSet>
    <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" />
  </AdaptationSet></Period></MPD>`
  assert.throws(() => inspectMpd(protectedMpd), /Widevine DRM is protected/)
})

test('DASH URL and output naming are classified as media, not manifest files', () => {
  assert.equal(kindForUrl('https://cdn.example/path/stream.mpd?token=x'), 'dash')
  assert.equal(kindForUrl('https://cdn.example/stream', 'application/dash+xml'), 'dash')
  assert.equal(filenameForKind('stream.mpd', 'dash'), 'stream.mp4')
  assert.equal(filenameForKind('movie.mkv', 'dash'), 'movie.mkv')
})

test('ffmpeg header serialization strips header injection characters', () => {
  const serialized = ffmpegHeaders({
    referer: 'https://example.test/watch',
    cookie: 'session=ok\r\nX-Evil: yes',
    extra: { 'x-token': 'safe' }
  })
  assert.match(serialized, /referer: https:\/\/example\.test\/watch\r\n/i)
  assert.match(serialized, /x-token: safe\r\n/i)
  assert.doesNotMatch(serialized, /X-Evil/)
})

test('ISO 8601 duration parser rejects malformed values', () => {
  assert.equal(parseIsoDuration('PT45S'), 45)
  assert.equal(parseIsoDuration('not-a-duration'), null)
})

test('subtitle sidecars are named beside their media without path traversal', () => {
  assert.equal(subtitleFilename('movie.mp4', { url: 'https://example.test/en.vtt', label: 'English', language: 'en-US', format: 'vtt' }), 'movie.en-US.vtt')
  assert.equal(subtitleFilename('movie.mkv', { url: 'https://example.test/sub', label: '../Commentary', language: null, format: 'srt' }), 'movie.download.Commentary.srt')
})
