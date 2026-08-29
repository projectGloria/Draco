import test from 'node:test'
import assert from 'node:assert/strict'

test('probe helper recognizes an RFC 7233 empty-resource response', async () => {
  const { isEmptyRangeResponse } = await import('../src/main/engine/probe-helpers.ts')
  assert.equal(isEmptyRangeResponse(416, 'bytes */0'), true)
  assert.equal(isEmptyRangeResponse(416, 'bytes */123'), false)
  assert.equal(isEmptyRangeResponse(200, 'bytes */0'), false)
})
