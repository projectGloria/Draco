import test from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeTorrentInput, looksLikeYouTubeInput } from '../src/renderer/src/lib/format.ts'

test('clipboard fast-path accepts only torrent-related input', () => {
  assert.equal(looksLikeTorrentInput('0123456789abcdef0123456789abcdef01234567'), true)
  assert.equal(looksLikeTorrentInput('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'), true)
  assert.equal(looksLikeTorrentInput('https://example.test/release.torrent?download=1'), true)
  assert.equal(looksLikeTorrentInput('https://example.test/archive.zip'), false)
  assert.equal(looksLikeTorrentInput('https://example.test/page'), false)
})

test('clipboard fast path recognizes supported YouTube links only', () => {
  assert.equal(looksLikeYouTubeInput('https://www.youtube.com/watch?v=abc123'), true)
  assert.equal(looksLikeYouTubeInput('https://youtu.be/abc123?t=4'), true)
  assert.equal(looksLikeYouTubeInput('https://music.youtube.com/watch?v=abc123'), true)
  assert.equal(looksLikeYouTubeInput('http://youtube.com/watch?v=abc123'), false)
  assert.equal(looksLikeYouTubeInput('https://youtube.com.evil.example/watch?v=abc123'), false)
  assert.equal(looksLikeYouTubeInput('https://vimeo.com/123'), false)
})
