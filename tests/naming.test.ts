import { ok, rejects, strictEqual } from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  decodeHeaderText,
  discardReservedPath,
  extensionOf,
  filenameFromDisposition,
  filenameFromUrl,
  moveFile,
  sanitizeFilename,
  uniquePath
} from '../src/main/engine/naming.ts'

/**
 * Names are where a download meets the filesystem, and every rule here exists
 * because some server or some OS quirk broke a download that had already
 * finished transferring.
 */

let dir = ''

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'draco-naming-'))
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sanitizeFilename', () => {
  it('strips the characters NTFS refuses', () => {
    strictEqual(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j.txt'), 'abcdefghij.txt')
  })

  it('drops control characters, which are written by escape so this file stays text', () => {
    const bell = String.fromCodePoint(7)
    strictEqual(sanitizeFilename(`clip${bell} recording.mp4`), 'clip recording.mp4')
    strictEqual(sanitizeFilename(`a${String.fromCodePoint(0)}b.txt`), 'ab.txt')
  })

  it('escapes reserved device names, which fail at open() rather than at write', () => {
    strictEqual(sanitizeFilename('CON'), 'CON_')
    strictEqual(sanitizeFilename('com4.txt'), 'com4_.txt')
    strictEqual(sanitizeFilename('console.txt'), 'console.txt', 'only the exact names are reserved')
    strictEqual(sanitizeFilename('CON.tar.gz'), 'CON_.tar.gz')
    strictEqual(sanitizeFilename('COM¹.mp4'), 'COM¹_.mp4')
    strictEqual(sanitizeFilename('lpt².backup.zip'), 'lpt²_.backup.zip')
  })

  it('removes the trailing dots and spaces Windows would silently eat', () => {
    // Left in place, the file we create and the file we look for disagree.
    strictEqual(sanitizeFilename('report...'), 'report')
    strictEqual(sanitizeFilename('report   '), 'report')
  })

  it('caps the stem, never the extension', () => {
    const long = sanitizeFilename('x'.repeat(400) + '.mkv')
    ok(long.endsWith('.mkv'), 'a long title must not eat the extension')
    strictEqual(long.length, 154)
  })

  it('falls back when nothing usable is left', () => {
    strictEqual(sanitizeFilename('///'), 'download')
    strictEqual(sanitizeFilename('   ', 'fallback.bin'), 'fallback.bin')
  })

  it('keeps non-ASCII names intact', () => {
    strictEqual(sanitizeFilename('Böhmische Träume.flac'), 'Böhmische Träume.flac')
    strictEqual(sanitizeFilename('東京.mp4'), '東京.mp4')
  })
})

describe('extensionOf', () => {
  it('lowercases and drops the dot', () => {
    strictEqual(extensionOf('Movie.MKV'), 'mkv')
    strictEqual(extensionOf('archive.tar.gz'), 'gz')
    strictEqual(extensionOf('README'), '')
  })
})

describe('filenameFromDisposition', () => {
  it('prefers RFC 5987 over the plain form', () => {
    const header = `attachment; filename="fallback.txt"; filename*=UTF-8''%E6%97%A5%E6%9C%AC.txt`
    strictEqual(filenameFromDisposition(header), '日本.txt')
  })

  it('falls back to the plain form when the extended one is malformed', () => {
    const header = `attachment; filename="good.txt"; filename*=UTF-8''%E6%9`
    strictEqual(filenameFromDisposition(header), 'good.txt')
  })

  it('reads quoted and bare values', () => {
    strictEqual(filenameFromDisposition('attachment; filename="my file.zip"'), 'my file.zip')
    strictEqual(filenameFromDisposition('attachment; filename=plain.zip'), 'plain.zip')
    strictEqual(filenameFromDisposition('attachment'), null)
    strictEqual(filenameFromDisposition(undefined), null)
  })
})

describe('decodeHeaderText', () => {
  it('repairs UTF-8 bytes that were decoded as Latin-1', () => {
    // What a server sends as UTF-8 arrives one JS character per byte.
    const misread = Buffer.from('日本.txt', 'utf8').toString('latin1')
    strictEqual(decodeHeaderText(misread), '日本.txt')
  })

  it('leaves a genuinely Latin-1 name alone', () => {
    strictEqual(decodeHeaderText('Grüße.txt'), 'Grüße.txt')
  })

  it('leaves plain ASCII and real Unicode alone', () => {
    strictEqual(decodeHeaderText('plain.txt'), 'plain.txt')
    strictEqual(decodeHeaderText('日本.txt'), '日本.txt')
  })
})

describe('filenameFromUrl', () => {
  it('takes the last segment, percent-decoded, without query or fragment', () => {
    strictEqual(filenameFromUrl('https://example.test/a/b/my%20file.zip?token=1#frag'), 'my file.zip')
    strictEqual(filenameFromUrl('https://example.test/'), null)
    strictEqual(filenameFromUrl('not a url'), null)
  })

  it('survives a broken percent-escape', () => {
    strictEqual(filenameFromUrl('https://example.test/bad%zz.bin'), 'bad%zz.bin')
  })
})

describe('uniquePath', () => {
  it('fails when it cannot reserve a name', async () => {
    await rejects(uniquePath(join(dir, 'missing-directory'), 'clip.mp4'), { code: 'ENOENT' })
  })

  it('reserves the name it returns, so two downloads cannot be handed the same one', async () => {
    const first = await uniquePath(dir, 'clip.mp4')
    strictEqual(basename(first), 'clip.mp4')
    strictEqual((await stat(first)).size, 0, 'the reservation is an empty placeholder')

    const second = await uniquePath(dir, 'clip.mp4')
    strictEqual(basename(second), 'clip (1).mp4')

    const third = await uniquePath(dir, 'clip.mp4')
    strictEqual(basename(third), 'clip (2).mp4')
  })

  it('numbers before the extension, and handles names without one', async () => {
    await uniquePath(dir, 'notes')
    strictEqual(basename(await uniquePath(dir, 'notes')), 'notes (1)')
  })

  it('hands back a name it reserved but nothing was written to', async () => {
    const reserved = await uniquePath(dir, 'abandoned.bin')
    await discardReservedPath(reserved)
    strictEqual(basename(await uniquePath(dir, 'abandoned.bin')), 'abandoned.bin', 'the good name is free again')
  })

  it('never deletes a file that has content', async () => {
    const real = join(dir, 'finished.bin')
    await writeFile(real, 'data', 'utf8')
    await discardReservedPath(real)
    strictEqual((await readFile(real, 'utf8')), 'data')
  })

  it('discards a stranded 0-byte reservation before reserving so retries get the original name', async () => {
    const stranded = await uniquePath(dir, 'dash-crash.mp4')
    strictEqual(basename(stranded), 'dash-crash.mp4')
    await discardReservedPath(join(dir, 'dash-crash.mp4'))
    const retry = await uniquePath(dir, 'dash-crash.mp4')
    strictEqual(basename(retry), 'dash-crash.mp4')
    await discardReservedPath(retry)
  })
})

describe('moveFile', () => {
  it('moves within a volume and leaves nothing behind', async () => {
    const src = join(dir, 'src.bin')
    const dest = join(dir, 'dest.bin')
    await writeFile(src, 'payload', 'utf8')

    await moveFile(src, dest)

    strictEqual(await readFile(dest, 'utf8'), 'payload')
    strictEqual(await stat(src).then(() => true, () => false), false)
  })
})
