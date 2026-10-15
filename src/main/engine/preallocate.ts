import { execFile } from 'node:child_process'
import { open, truncate } from 'node:fs/promises'
import { parse } from 'node:path'
import { promisify } from 'node:util'

/**
 * Reserves the whole file before the first byte of it is fetched.
 *
 * Three ways exist to give a part file its final size on NTFS and only one of
 * them is both fast and tidy:
 *
 * - **Plain extend.** `SetEndOfFile` allocates the clusters but leaves the
 *   valid data length at zero, and NTFS honours that by zero-filling from the
 *   valid length up to wherever the next write lands. Segmented downloading
 *   writes at scattered offsets by design, so the first connection to reach the
 *   far end of the file makes the system write the entire file out in zeros
 *   before it may write its own bytes. On a large download that is minutes of
 *   disk time nobody asked for. This mode is unusable here, which is the whole
 *   reason for the other two.
 *
 * - **Sparse.** Marking the file sparse removes the zero-fill entirely, because
 *   unwritten regions have no clusters to zero. It costs nothing up front and
 *   needs no privilege, which is why it is the fallback. What it costs is
 *   afterwards: every scattered write allocates its own extent on demand, so a
 *   multi-gigabyte file arriving down sixteen connections can finish with an
 *   extent map thousands of entries long. That is paid back by whoever reads
 *   the file next - the player, the copy, the virus scanner.
 *
 * - **Valid data length.** `SetFileValidData`, which `fsutil file setvaliddata`
 *   is the built-in front end for, declares the range valid *without* writing
 *   zeros over it. The file is a normal contiguous allocation, there is no
 *   zero-fill, and the extent map stays as small as the volume's free space
 *   allows. The catch is that it needs SeManageVolumePrivilege, because
 *   declaring never-written clusters valid exposes whatever the previous
 *   tenant of those clusters left there until the download overwrites it. The
 *   privilege is held by elevated processes, and can also be granted to an
 *   account outright through "Perform volume maintenance tasks".
 *
 * So: try the good one, keep the answer, and fall back to sparse for the rest
 * of the session on a volume that said no. The probe is what an unprivileged
 * run pays, and it pays it once per volume rather than once per download.
 */

export type PreallocationMode =
  /** Contiguous, no zero-fill: `SetFileValidData` was permitted. */
  | 'valid-data'
  /** No zero-fill, fragmented on demand: the portable fallback. */
  | 'sparse'
  /** Neither worked; the file is left for the first write to extend. */
  | 'none'

export interface PreallocateDeps {
  /** Runs a console tool, rejecting on any non-zero exit. */
  run(file: string, args: string[]): Promise<void>
  /** Creates the file if it is missing and empties it if it is not. */
  create(path: string): Promise<void>
  truncate(path: string, size: number): Promise<void>
}

/**
 * Whether a volume has been seen to permit `setvaliddata`. Keyed by volume
 * root, because the privilege is the process's but the answer can still differ
 * per volume - a removable or network target refuses what the system disk
 * allows.
 */
const permitted = new Map<string, boolean>()

/**
 * Whether a volume accepted the sparse flag last time it was asked.
 *
 * This was the gap that made an unelevated run pay a process spawn on every
 * single download, forever: the `setvaliddata` failure was cached, so the
 * expensive path was skipped - and then `fsutil sparse setflag` ran
 * unconditionally underneath it. On Windows that is 50-200 ms of
 * `CreateProcess` per download, and a batch of twenty starting together is
 * twenty of them competing with the transfers for the same event loop.
 *
 * A volume that has never refused the flag is trusted to keep accepting it. The
 * cost of being wrong is one download that extends on demand instead, which is
 * exactly what the `none` mode already means.
 */
const sparseSupported = new Map<string, boolean>()

/** Only for tests, and for a settings change that could plausibly alter it. */
export function forgetPreallocationSupport(): void {
  permitted.clear()
  sparseSupported.clear()
}

export function volumeRootOf(path: string): string {
  const root = parse(path).root
  return root ? root.toLowerCase() : path.toLowerCase()
}

const execFileAsync = promisify(execFile)

/** The real thing: fsutil and the filesystem. */
export const systemPreallocateDeps: PreallocateDeps = {
  async run(file, args) {
    // windowsHide, or fsutil flashes a console window once per download.
    await execFileAsync(file, args, { windowsHide: true })
  },
  async create(path) {
    const handle = await open(path, 'w')
    await handle.close()
  },
  truncate
}

export async function preallocate(
  path: string,
  size: number,
  deps: PreallocateDeps = systemPreallocateDeps
): Promise<PreallocationMode> {
  if (!Number.isSafeInteger(size) || size <= 0) return 'none'

  await deps.create(path)
  const root = volumeRootOf(path)

  if (permitted.get(root) !== false) {
    try {
      // The range has to exist before it can be declared valid.
      await deps.truncate(path, size)
      await deps.run('fsutil', ['file', 'setvaliddata', path, String(size)])
      permitted.set(root, true)
      return 'valid-data'
    } catch {
      permitted.set(root, false)
      // Hand the clusters back before marking the file sparse: the flag only
      // governs what is allocated from here on, so an extend left in place
      // would keep both the allocation and the zero-fill it implies.
      await deps.truncate(path, 0).catch(() => {})
    }
  }

  // A volume that has already refused the sparse flag will refuse it again, and
  // asking costs a process launch. Extend the file and let the first write to
  // each region allocate, which is what `none` has always meant.
  if (sparseSupported.get(root) === false) {
    await deps.truncate(path, size).catch(() => {})
    return 'none'
  }

  try {
    await deps.run('fsutil', ['sparse', 'setflag', path])
    sparseSupported.set(root, true)
    await deps.truncate(path, size)
    return 'sparse'
  } catch {
    sparseSupported.set(root, false)
    return 'none'
  }
}

/**
 * Takes the sparse flag off a finished file.
 *
 * The flag is a property of the file, not of the download, so it outlived the
 * part file and followed the payload to its final name. Everything that reads
 * the file afterwards - the player, a copy, the virus scanner - then walks an
 * extent map that a multi-gigabyte download on sixteen connections can leave
 * thousands of entries long, for a file that is now completely written and has
 * no holes in it at all.
 *
 * Best-effort by design: a failure here costs read performance on one file and
 * must never turn a finished download into an error.
 *
 * The condition is "not known to be unnecessary" rather than "known to be
 * needed", and the difference is the whole point. `sparseSupported` is only
 * ever populated by `preallocate`, which a resumed download does not run - so
 * requiring a positive entry meant every download that was paused, survived a
 * restart and then finished kept its sparse flag and carried the fragmented
 * extent map to its final name, which is exactly what this exists to prevent.
 *
 * Being wrong the other way costs one `CreateProcess` on a file that did not
 * need it. That is paid once, after the last byte is written, rather than at
 * the start of every download the way `preallocate`'s probe would be - so the
 * asymmetry that justifies caching there does not apply here.
 */
export async function clearSparseFlag(
  path: string,
  deps: PreallocateDeps = systemPreallocateDeps
): Promise<void> {
  if (process.platform !== 'win32') return
  const root = volumeRootOf(path)
  // This volume refuses the flag outright, so nothing on it is ever sparse.
  if (sparseSupported.get(root) === false) return
  // `setvaliddata` worked here in this process, so `preallocate` never reached
  // the sparse branch for any file this run put on this volume.
  if (permitted.get(root) === true) return
  await deps.run('fsutil', ['sparse', 'setflag', path, '0']).catch(() => {})
}
