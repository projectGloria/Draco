import test from 'node:test'
import assert from 'node:assert/strict'
import { filenameFromDisposition, sanitizeFilename } from '../src/main/engine/naming.ts'

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

test('a filename sanitizer leaves non-Latin scripts alone', () => {
  assert.equal(sanitizeFilename('日本語の動画.mp4'), '日本語の動画.mp4')
})

test('a UTF-8 filename sent as raw header bytes is read back as itself', () => {
  // What the server wrote, seen the way an HTTP client is obliged to decode a
  // header: one character per byte.
  const raw = Buffer.from('日本語.zip', 'utf8').toString('latin1')
  assert.equal(
    filenameFromDisposition(`attachment; filename="${raw}"`),
    '日本語.zip'
  )
})

test('a genuinely Latin-1 filename is not mangled by the repair', () => {
  assert.equal(
    filenameFromDisposition('attachment; filename="Grüße.pdf"'),
    'Grüße.pdf'
  )
})

test('RFC 5987 still wins over the plain form', () => {
  assert.equal(
    filenameFromDisposition("attachment; filename=\"fallback.zip\"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.zip"),
    '日本.zip'
  )
})
