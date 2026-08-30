import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chosenYouTubeUrls,
  preparedYouTubeUrl,
  variantsPreparedForStart
} from '../src/main/youtube-url.ts'

test('prepared YouTube resources are constrained to the expected CDN, path, and itag', () => {
  const valid = 'https://rr2---sn-x.googlevideo.com/videoplayback?expire=1&itag=399'
  assert.equal(preparedYouTubeUrl(valid, 399), valid)
  assert.equal(preparedYouTubeUrl(valid, 137), null)
  assert.equal(preparedYouTubeUrl('https://googlevideo.com.evil.example/videoplayback?itag=399', 399), null)
  assert.equal(preparedYouTubeUrl('https://rr2.googlevideo.com/redirect?itag=399', 399), null)
  assert.equal(preparedYouTubeUrl('http://rr2.googlevideo.com/videoplayback?itag=399', 399), null)
})

test('the final confirmation contract requires and returns already-prepared streams', () => {
  const variants = [{
    url: 'https://rr2.googlevideo.com/videoplayback?itag=399',
    audioUrl: 'https://rr2.googlevideo.com/videoplayback?itag=140',
    label: '1080p', height: 1080, bandwidth: null, codecs: null, estimatedSize: null,
    youtube: { videoFormatId: '399', audioFormatId: '140' }
  }]
  assert.equal(variantsPreparedForStart(variants), true)
  assert.deepEqual(
    chosenYouTubeUrls(variants, 'https://www.youtube.com/watch?v=abc', variants[0].youtube),
    { url: variants[0].url, audioUrl: variants[0].audioUrl }
  )

  const incomplete = [{ ...variants[0], audioUrl: null }]
  assert.equal(variantsPreparedForStart(incomplete), false)
  assert.deepEqual(
    chosenYouTubeUrls(incomplete, 'https://www.youtube.com/watch?v=abc', incomplete[0].youtube),
    {
      url: 'https://www.youtube.com/watch?v=abc',
      audioUrl: 'https://www.youtube.com/watch?v=abc'
    }
  )
})
