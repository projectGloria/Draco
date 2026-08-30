import { win32 } from 'node:path'
import { mkdir, stat } from 'node:fs/promises'

/** Converts a selected Windows destination into an unambiguous absolute path. */
export function normalizeDownloadDirectory(value: string): string {
  if (typeof value !== 'string') throw new Error('Download directory must be a path')
  let input = value.trim()
  if (!input) throw new Error('Download directory cannot be empty')
  // `D:` is drive-relative to Node, while a folder picker means the drive root.
  if (/^[a-z]:$/i.test(input)) input += '\\'

  const normalized = win32.normalize(input)
  if (!win32.isAbsolute(normalized)) {
    throw new Error('Download directory must be an absolute Windows path')
  }
  return normalized
}

export function safeDownloadDirectory(value: unknown, fallback: string): string {
  try {
    return normalizeDownloadDirectory(typeof value === 'string' ? value : '')
  } catch {
    return normalizeDownloadDirectory(fallback)
  }
}

/** Ensures the destination exists without calling mkdir on an existing Windows
 * drive root. Node reports EPERM for some system/hidden roots even with
 * recursive:true, despite the directory already being perfectly usable. */
export async function ensureDownloadDirectory(value: string): Promise<string> {
  const normalized = normalizeDownloadDirectory(value)
  try {
    const existing = await stat(normalized)
    if (!existing.isDirectory()) throw new Error('Download destination is not a directory')
    return normalized
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  await mkdir(normalized, { recursive: true })
  return normalized
}
