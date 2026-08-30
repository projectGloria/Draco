import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureDownloadDirectory, normalizeDownloadDirectory, safeDownloadDirectory } from '../src/main/destination-path.ts'

test('bare drive designators become drive roots', () => {
  assert.equal(normalizeDownloadDirectory('D:'), 'D:\\')
  assert.equal(normalizeDownloadDirectory(' d: '), 'd:\\')
})

test('absolute drive and UNC directories are normalized', () => {
  assert.equal(normalizeDownloadDirectory('C:/Downloads/video'), 'C:\\Downloads\\video')
  assert.equal(normalizeDownloadDirectory('\\\\server\\share\\folder\\..\\video'), '\\\\server\\share\\video')
})

test('relative and empty directories are rejected', () => {
  assert.throws(() => normalizeDownloadDirectory('Downloads'), /absolute Windows path/)
  assert.throws(() => normalizeDownloadDirectory('  '), /cannot be empty/)
})

test('persisted invalid directories fall back safely', () => {
  assert.equal(safeDownloadDirectory('Downloads', 'C:/Downloads'), 'C:\\Downloads')
})

test('an existing destination is accepted without recreating it', async () => {
  const existing = await ensureDownloadDirectory(process.cwd())
  assert.equal(existing, normalizeDownloadDirectory(process.cwd()))
})
