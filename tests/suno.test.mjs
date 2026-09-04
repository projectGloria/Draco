import assert from 'node:assert/strict'
import test from 'node:test'
import { sunoMediaFromHtml } from '../src/main/suno.ts'

test('Suno metadata produces a stable MP3 download and artwork', () => {
  const result = sunoMediaFromHtml(
    'https://suno.com/song/abc-123',
    'abc-123',
    '<meta property="og:title" content="Night Drive | Suno">' +
      '<meta property="og:audio" content="https://cdn1.suno.ai/abc-123.mp3">' +
      '<meta property="og:image" content="https://cdn2.suno.ai/image_abc.jpeg">'
  )
  assert.equal(result.title, 'Night Drive')
  assert.equal(result.variants[0].url, 'https://cdn1.suno.ai/abc-123.mp3')
  assert.equal(result.variants[0].container, 'mp3')
  assert.equal(result.thumbnailUrl, 'https://cdn2.suno.ai/image_abc.jpeg')
})

test('Suno silence placeholders are replaced with the song CDN URL', () => {
  const result = sunoMediaFromHtml(
    'https://suno.com/song/abc-123',
    'abc-123',
    '<meta property="og:audio" content="https://cdn1.suno.ai/silence.mp3">'
  )
  assert.equal(result.variants[0].url, 'https://cdn1.suno.ai/abc-123.mp3')
  assert.equal(result.variants[0].youtube, undefined)
})
