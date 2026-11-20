import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadReadOnlyChunkStore } from '../src/main/engine/torrent-readonly-store.ts'

/**
 * A finished torrent goes on seeding. WebTorrent's default store keeps every
 * payload file open read-write for that whole time, and on Windows a program
 * that opens the file without sharing it with writers - WinRAR opening an
 * archive - is refused until the row is removed. The seeding store reads only.
 */

const CHUNK = 16 * 1024

/** Opens the file the way WinRAR does: read access, shared with readers only. */
function openSharingReadOnly(path: string): boolean {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; $f=[System.IO.File]::Open('${path.replace(/'/g, "''")}','Open','Read','Read'); $f.Close(); 'ok'`
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.includes('ok')
  } catch {
    return false
  }
}

const call = <T>(fn: (cb: (error: Error | null, value?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => fn((error, value) => error ? reject(error) : resolve(value as T)))

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'draco-ro-store-'))
  const file = join(dir, 'archive.rar')
  await writeFile(file, Buffer.alloc(CHUNK * 2, 7))
  return { dir, file, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('read-only torrent seeding store', () => {
  it('serves pieces and refuses writes', async () => {
    const { dir, cleanup } = await fixture()
    try {
      const Store = await loadReadOnlyChunkStore()
      const store = new Store(CHUNK, { path: dir, files: [{ path: 'archive.rar', length: CHUNK * 2 }] })
      const piece = await call<Buffer>((cb) => store.get(1, cb))
      strictEqual(piece.length, CHUNK)
      strictEqual(piece[0], 7)
      const error = await call((cb) => store.put(0, Buffer.alloc(CHUNK), cb)).then(() => null, (e) => e)
      ok(error instanceof Error, 'a seeding store must not write')
      await call((cb) => store.close(cb))
    } finally {
      await cleanup()
    }
  })

  it('never creates a file that is missing', async () => {
    const { dir, cleanup } = await fixture()
    try {
      const Store = await loadReadOnlyChunkStore()
      const store = new Store(CHUNK, { path: dir, files: [{ path: 'gone.bin', length: CHUNK }] })
      const error = await call((cb) => store.get(0, cb)).then(() => null, (e) => e)
      ok(error instanceof Error)
      strictEqual(existsSync(join(dir, 'gone.bin')), false)
      await call((cb) => store.close(cb))
    } finally {
      await cleanup()
    }
  })

  it('leaves the file openable by a reader that refuses to share with writers', { skip: process.platform !== 'win32' }, async () => {
    const { dir, file, cleanup } = await fixture()
    try {
      const FSChunkStore = (await (new Function('return import("fs-chunk-store")')() as Promise<any>)).default
      const writable = new FSChunkStore(CHUNK, { path: dir, files: [{ path: 'archive.rar', length: CHUNK * 2 }] })
      await call((cb) => writable.get(0, cb))
      // The control: this is the lock the user hit.
      strictEqual(openSharingReadOnly(file), false, 'the default store holds a writable handle')
      await call((cb) => writable.close(cb))

      const Store = await loadReadOnlyChunkStore()
      const store = new Store(CHUNK, { path: dir, files: [{ path: 'archive.rar', length: CHUNK * 2 }] })
      await call((cb) => store.get(0, cb))
      strictEqual(openSharingReadOnly(file), true, 'a seeding torrent must not lock the finished file')
      await call((cb) => store.close(cb))
    } finally {
      await cleanup()
    }
  })
})
