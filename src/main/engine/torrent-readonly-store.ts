/**
 * A WebTorrent chunk store that can only read.
 *
 * WebTorrent's default `fs-chunk-store` opens every payload file read-write and
 * keeps the handle for as long as the torrent lives. A finished torrent that
 * goes on seeding therefore holds a writable handle on the user's file, and on
 * Windows any program that opens the file while refusing to share it with a
 * writer - WinRAR opening an archive does exactly that - fails with "the file is
 * being used by another process" until the row is removed from Draco.
 *
 * Seeding only ever reads, so once a download is complete the torrent is
 * re-added on this store instead. A read-only handle is compatible with every
 * share mode a reader asks for.
 */

// Bypass Vite's CommonJS transpilation, as the runner does for `webtorrent`.
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

let loaded: Promise<any> | null = null

export function loadReadOnlyChunkStore(): Promise<any> {
  loaded ??= (async () => {
    const [storeModule, rafModule] = await Promise.all([
      importModule('fs-chunk-store'),
      importModule('random-access-file')
    ])
    const FSChunkStore = storeModule.default ?? storeModule
    const RandomAccessFile = rafModule.default ?? rafModule

    return class ReadOnlyChunkStore extends FSChunkStore {
      constructor(chunkLength: number, opts: unknown) {
        super(chunkLength, opts)
        for (const file of (this as any).files as Array<{ path: string; open: (cb: (error: Error | null, file?: unknown) => void) => void }>) {
          let handle: unknown = null
          file.open = (cb) => {
            if ((this as any).closed) return cb(new Error('Storage is closed'))
            // Never `O_CREAT` and never writable: a missing file is an error to
            // report, not something to recreate as an empty placeholder.
            handle ??= new RandomAccessFile(file.path, { writable: false })
            cb(null, handle)
          }
        }
      }

      put(_index: number, _buf: unknown, cb?: (error: Error) => void): void {
        queueMicrotask(() => cb?.(new Error('This torrent is seeding read-only')))
      }
    }
  })()
  loaded.catch(() => { loaded = null })
  return loaded
}
