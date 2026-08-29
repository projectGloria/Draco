import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeFilename } from '../src/main/engine/naming.ts'

test('filename sanitizer cannot create a path traversal', () => {
  const value = sanitizeFilename('..\\..\\secret.txt')
  assert.ok(!value.includes('\\'))
  assert.ok(!value.includes('/'))
  assert.notEqual(value, '')
})

test('filename sanitizer handles Windows device names', () => {
  assert.equal(sanitizeFilename('CON.txt'), 'CON_.txt')
  assert.equal(sanitizeFilename('CON'), 'CON_')
})
