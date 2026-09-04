import test from 'node:test'
import assert from 'node:assert/strict'
import {
  selectedTorrentComplete,
  selectedTorrentDownloaded,
  torrentDownloadOptions
} from '../src/main/engine/torrent.ts'

test('torrent downloads begin with every file deselected', () => {
  assert.deepEqual(torrentDownloadOptions('C:\\Downloads'), {
    path: 'C:\\Downloads',
    deselect: true
  })
})

test('torrent progress counts only selected files and never exceeds their size', () => {
  const files = [
    { path: 'release/video.mkv', length: 335_000_000, downloaded: 335_000_000 },
    { path: 'release/cover.jpg', length: 1_350_000, downloaded: 2_000_000 }
  ]

  assert.equal(selectedTorrentDownloaded(files, ['release/cover.jpg']), 1_350_000)
  assert.equal(selectedTorrentDownloaded(files), 336_350_000)
})

test('a completed selected file finishes without waiting for the rest of the torrent', () => {
  const files = [
    { path: 'release/video.mkv', length: 335_000_000, downloaded: 20_000_000 },
    { path: 'release/cover.jpg', length: 1_350_000, downloaded: 1_350_000 }
  ]

  assert.equal(selectedTorrentComplete(files, ['release/cover.jpg']), true)
  assert.equal(selectedTorrentComplete(files), false)
  assert.equal(selectedTorrentComplete(files, ['release/missing.jpg']), false)
})
