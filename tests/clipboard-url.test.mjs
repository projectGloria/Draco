import assert from 'node:assert/strict'
import test from 'node:test'
import { looksDownloadable } from '../src/main/clipboard-url.ts'

test('clipboard inbox accepts files, media pages, ordinary pages, torrents, and magnets', () => {
  assert.equal(looksDownloadable('https://example.test/archive.zip?download=1'), true)
  assert.equal(looksDownloadable('https://www.youtube.com/watch?v=abc'), true)
  assert.equal(looksDownloadable('https://soundcloud.com/artist/track-name'), true)
  assert.equal(looksDownloadable('https://suno.com/song/12345678-abcd'), true)
  assert.equal(looksDownloadable('https://example.test/file.torrent'), true)
  assert.equal(looksDownloadable('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'), true)
  assert.equal(looksDownloadable('0123456789abcdef0123456789abcdef01234567'), true)
  assert.equal(looksDownloadable('https://example.test/page'), true)
  assert.equal(looksDownloadable('https://www.youtube.com/'), true)
})

test('clipboard inbox ignores prose and unsafe protocols', () => {
  assert.equal(looksDownloadable('look at https://example.test'), false)
  assert.equal(looksDownloadable('javascript:alert(1)'), false)
  assert.equal(looksDownloadable('file:///C:/secret.txt'), false)
  assert.equal(looksDownloadable('not a link'), false)
  assert.equal(
    looksDownloadable('https://1337x.to/torrent/6713664/The-Blood-of-Dawnwalker-RUNE/'),
    true
  )
  assert.equal(looksDownloadable('https://soundcloud.com/discover'), true)
  assert.equal(looksDownloadable('https://suno.com/'), true)
})
