import test from 'node:test'
import assert from 'node:assert/strict'
import { createTask } from '../src/main/engine/create.ts'

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
  assert.deepEqual(task.youtube, {
    pageUrl: 'https://www.youtube.com/watch?v=abc123',
    videoFormatId: '137',
    audioFormatId: '140',
    role: 'video'
  })
})
