import { open, rm, stat } from 'node:fs/promises'
import { extname, join, basename } from 'node:path'

/**
 * Filename handling for downloads. Deliberately free of Electron imports so the
 * engine can be exercised from `node tools/dl.ts` without a build step.
 */

/** Characters NTFS rejects outright. */
const ILLEGAL_PATH_CHARS = /[<>:"/\\|?*]/g
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Turns an arbitrary string into a name Windows will actually accept.
 *
 * Reserved device names (CON, PRN, ...) fail at open() rather than at write, and
 * a trailing dot or space is silently trimmed by the OS - which would make the
 * file we create and the file we later look for disagree.
 */
export function sanitizeFilename(name: string, fallback = 'download'): string {
  // Control characters are filtered by codepoint: putting them in a regex
  // literal invites exactly the kind of source corruption this avoids.
  const printable = Array.from(name.trim())
    .filter((ch) => (ch.codePointAt(0) ?? 0) >= 32)
    .join('')

  const cleaned = printable
    .replace(ILLEGAL_PATH_CHARS, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim()

  if (!cleaned) return fallback

  const ext = extname(cleaned)
  const stem = ext ? cleaned.slice(0, -ext.length) : cleaned

  // Cap the stem, not the whole name, so a long title never eats the extension.
  const cappedStem = Array.from(stem).slice(0, 150).join('').replace(/[.\s]+$/, '') || fallback
  const safeStem = RESERVED_DEVICE_NAMES.test(cappedStem) ? cappedStem + '_' : cappedStem

  return safeStem + ext.slice(0, 16)
}

/** Lowercase extension without the dot, or '' when there is none. */
export function extensionOf(filename: string): string {
  const ext = extname(filename)
  return ext ? ext.slice(1).toLowerCase() : ''
}

/**
 * Pulls a filename out of a Content-Disposition header.
 * RFC 5987's `filename*=UTF-8''...` wins over plain `filename=` when both are
 * present, which is the case whenever the name is not pure ASCII.
 */
export function filenameFromDisposition(header: string | undefined): string | null {
  if (!header) return null

  const extended = /filename\*\s*=\s*([^']*)'([^']*)'([^;]+)/i.exec(header)
  if (extended) {
    try {
      return decodeURIComponent(extended[3].trim())
    } catch {
      // A malformed percent-escape should fall through to the plain form
      // rather than sink the whole download.
    }
  }

  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(header)
  if (plain) {
    const raw = (plain[2] ?? plain[3] ?? '').trim()
    if (raw) {
      try {
        return decodeHeaderText(decodeURIComponent(raw))
      } catch {
        return decodeHeaderText(raw)
      }
    }
  }

  return null
}

/**
 * Repairs a header value whose UTF-8 bytes were decoded as Latin-1.
 *
 * HTTP header values are bytes, and both the spec and every client decode them
 * as ISO-8859-1 - so a server that writes a Japanese filename straight into
 * `filename=` hands us one JS character per *byte*. Left alone that reaches the
 * UI as mojibake and then becomes the name of the file on disk.
 *
 * Re-decoding is only attempted when the string could be raw bytes and those
 * bytes are valid UTF-8. That combination is vanishingly unlikely to occur by
 * accident: a genuinely Latin-1 name such as "Gruesse" spelled with U+00FC
 * fails the UTF-8 check and is returned untouched.
 */
export function decodeHeaderText(value: string): string {
  // Tested by codepoint rather than with a regex literal, for the same reason
  // the control-character filter above is: those bytes do not survive editors.
  let hasHighByte = false
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    // Something past Latin-1 is a real string, not a run of misread bytes.
    if (code > 0xff) return value
    if (code >= 0x80) hasHighByte = true
  }
  if (!hasHighByte) return value

  const bytes = Uint8Array.from(value, (ch) => ch.charCodeAt(0))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return value
  }
}

/** Last path segment of a URL, percent-decoded, query and fragment stripped. */
export function filenameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const last = basename(parsed.pathname)
    if (!last) return null
    try {
      return decodeURIComponent(last)
    } catch {
      return last
    }
  } catch {
    return null
  }
}

/**
 * Finds a path that does not exist yet, appending " (1)", " (2)" and so on
 * before the extension the way Explorer does.
 */
export async function uniquePath(dir: string, filename: string): Promise<string> {
  const ext = extname(filename)
  const stem = ext ? filename.slice(0, -ext.length) : filename

  for (let i = 0; i < 1000; i++) {
    const candidate = join(dir, i === 0 ? filename : `${stem} (${i})${ext}`)
    try {
      // `wx` creates the file or fails - one atomic step, so the name is taken
      // the moment it is chosen. Checking with access() and then returning left
      // a window in which two downloads finishing together were both handed the
      // same free name, and the second overwrote the first.
      //
      // The empty placeholder is harmless: every caller either renames over it
      // or hands it to ffmpeg with -y.
      const handle = await open(candidate, 'wx')
      await handle.close()
      return candidate
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') continue
      // A directory we cannot create in is not a naming problem; fall back to
      // the non-reserving answer and let the real write report the reason.
      return candidate
    }
  }

  // Pathological case: a thousand collisions. A timestamp always terminates.
  return join(dir, `${stem} (${Date.now()})${ext}`)
}

/**
 * Gives back a name `uniquePath` reserved but that nothing was written to.
 *
 * The reservation is an empty file, so a caller that reserves a name and then
 * fails - a mux that could not run, a move that was refused - would otherwise
 * leave a 0-byte file beside the real download and take the good name with it.
 * Only ever removes a file that is still empty, so it can never delete a
 * finished download.
 */
export async function discardReservedPath(path: string): Promise<void> {
  try {
    const info = await stat(path)
    if (info.isFile() && info.size === 0) await rm(path, { force: true })
  } catch {
    // Never there, already gone, or not ours to remove. Nothing to do.
  }
}

/**
 * Moves a file, falling back to a copy-and-delete if the source and destination
 * are on different drives (which throws EXDEV on rename).
 */
export async function moveFile(src: string, dest: string): Promise<void> {
  const { rename, copyFile, unlink } = await import('node:fs/promises')
  try {
    await rename(src, dest)
  } catch (err: any) {
    if (err && err.code === 'EXDEV') {
      await copyFile(src, dest)
      await unlink(src)
    } else {
      throw err
    }
  }
}
