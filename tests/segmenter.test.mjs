import test from 'node:test'
import assert from 'node:assert/strict'

test('segmenter treats zero-byte files as complete', async () => {
  const { Segmenter } = await import('../src/main/engine/segmenter.ts')
  const s = new Segmenter(0, 1024)
  assert.equal(s.complete, true)
  assert.equal(s.received, 0)
})

test('segmenter closes an unknown-size stream when its final size is learned', async () => {
  const { Segmenter } = await import('../src/main/engine/segmenter.ts')
  const s = new Segmenter(null, 1024)
  s.segments[0].position = 1234
  s.setSize(1234)
  assert.equal(s.complete, true)
  assert.equal(s.received, 1234)
})
