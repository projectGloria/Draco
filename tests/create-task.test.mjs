import test from 'node:test'
import assert from 'node:assert/strict'
import { createTask, validateUrl } from '../src/main/engine/create.ts'

test('task creation preserves adaptive-stream metadata needed for muxing and refresh', () => {
  const task = createTask({
    url: 'https://cdn.example/video.mp4',
    audioUrl: 'https://cdn.example/audio.m4a',
    youtube: {
      pageUrl: 'https://www.youtube.com/watch?v=abc123',
      videoFormatId: '137',
      audioFormatId: '140'
    },
    dir: 'C:/Downloads',
    filename: 'video.mp4'
  })

  assert.equal(task.audioUrl, 'https://cdn.example/audio.m4a')
  assert.equal(task.dir, 'C:\\Downloads')
  assert.deepEqual(task.youtube, {
    pageUrl: 'https://www.youtube.com/watch?v=abc123',
    videoFormatId: '137',
    audioFormatId: '140',
    role: 'video'
  })
})

test('task creation preserves an audio-only extractor choice', () => {
  const task = createTask({
    url: 'https://cdn.example/audio.webm',
    youtube: {
      pageUrl: 'https://www.youtube.com/watch?v=abc123',
      videoFormatId: '251',
      role: 'audio'
    },
    dir: 'C:/Downloads',
    filename: 'music.webm'
  })

  assert.equal(task.audioUrl, null)
  assert.equal(task.youtube.role, 'audio')
  assert.equal(task.youtube.videoFormatId, '251')
})

test('task creation cannot retain a drive-relative root', () => {
  const task = createTask({ url: 'https://example.test/file.bin', dir: 'D:' })
  assert.equal(task.dir, 'D:\\')
})

test('a bare torrent info hash becomes a discoverable magnet link', () => {
  const hash = '0123456789abcdef0123456789abcdef01234567'
  const result = new URL(validateUrl(hash))

  assert.equal(result.protocol, 'magnet:')
  assert.equal(result.searchParams.get('xt'), `urn:btih:${hash}`)
  assert.ok(result.searchParams.getAll('tr').length >= 3)
  assert.match(validateUrl(hash), /^magnet:\?xt=urn:btih:/)
})

test('task creation retains a torrent file selection', () => {
  const selectedFiles = ['release/image.iso', 'release/README.txt']
  const task = createTask({
    url: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567',
    dir: 'C:\\Downloads',
    kind: 'torrent',
    selectedFiles
  })

  assert.deepEqual(task.selectedFiles, selectedFiles)
})

test('page batch identity survives task creation', () => {
  const task = createTask({
    url: 'https://cdn.example.test/1080.mp4',
    sourceUrl: 'https://example.test/watch/feature',
    groupId: 'page-batch-1',
    groupName: 'Feature title',
    groupFolder: 'Feature title',
    dir: 'C:/Downloads/Feature title',
    filename: 'Feature title - 1080p.mp4'
  })

  assert.equal(task.groupId, 'page-batch-1')
  assert.equal(task.groupName, 'Feature title')
  assert.equal(task.groupFolder, 'Feature title')
  assert.equal(task.dir, 'C:\\Downloads\\Feature title')
})
