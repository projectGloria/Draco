import test from 'node:test'
import assert from 'node:assert/strict'
import { journalSegmentsValid, journalMatches } from '../src/main/engine/journal.ts'

test('journal segment validation rejects overlap and out-of-bounds records', () => {
  assert.equal(journalSegmentsValid([
    { start: 0, end: 99, position: 100, active: false },
    { start: 100, end: 199, position: 150, active: false }
  ], 200), true)
  assert.equal(journalSegmentsValid([
    { start: 0, end: 100, position: 50, active: false },
    { start: 100, end: 199, position: 150, active: false }
  ], 200), false)
  assert.equal(journalSegmentsValid([
    { start: 0, end: 200, position: 100, active: false }
  ], 200), false)
})

test('journal segment validation rejects a snapshot with a hole in it', () => {
  // Every segment reached its own end, so `Segmenter.complete` would say the
  // file is finished - while bytes 100-149 were never fetched at all.
  assert.equal(journalSegmentsValid([
    { start: 0, end: 99, position: 100, active: false },
    { start: 150, end: 199, position: 200, active: false }
  ], 200), false)
  // Missing the head and missing the tail are the same mistake.
  assert.equal(journalSegmentsValid([
    { start: 50, end: 199, position: 200, active: false }
  ], 200), false)
  assert.equal(journalSegmentsValid([
    { start: 0, end: 149, position: 150, active: false }
  ], 200), false)
})

test('journal matching refuses weak validators and changed sizes', () => {
  const base = { url: 'https://cdn.example/file', finalUrl: 'https://cdn.example/file', filename: 'x.bin', size: 100, etag: null, lastModified: null, segments: [], updatedAt: 1 }
  assert.equal(journalMatches({ ...base, etag: 'W/"abc"' }, { finalUrl: base.finalUrl, filename: base.filename, size: 100, resumable: true, etag: '"abc"', lastModified: null, mimeType: null, statusCode: 206 }), false)
  assert.equal(journalMatches({ ...base, etag: '"abc"' }, { finalUrl: base.finalUrl, filename: base.filename, size: 100, resumable: true, etag: '"abc"', lastModified: null, mimeType: null, statusCode: 206 }), true)
  assert.equal(journalMatches({ ...base, size: 100 }, { finalUrl: base.finalUrl, filename: base.filename, size: 101, resumable: true, etag: null, lastModified: null, mimeType: null, statusCode: 206 }), false)
})

test('journal without validators refuses a changed redirect target', async () => {
  const base = {
    finalUrl: 'https://cdn-a.example/file.bin',
    size: 100,
    etag: null,
    lastModified: null,
    mimeType: 'application/octet-stream',
    statusCode: 206
  }
  const journal = {
    version: 1,
    url: 'https://example.test/download',
    finalUrl: base.finalUrl,
    filename: 'file.bin',
    size: 100,
    etag: null,
    lastModified: null,
    segments: [{ start: 0, end: 99, position: 50, active: false }],
    updatedAt: Date.now()
  }

  const probe = { ...base, finalUrl: 'https://cdn-b.example/file.bin' }
  const { journalMatches } = await import('../src/main/engine/journal.ts')
  assert.equal(journalMatches(journal, probe), false)
  assert.equal(journalMatches(journal, probe, { allowFinalUrlChange: true }), true)
})
