import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Category } from '@shared/types'
import { extensionOf } from './engine/naming.ts'
import { normalizeDownloadDirectory } from './destination-path.ts'

/**
 * IDM's category model: a finished file is filed into a subfolder chosen by its
 * extension. The defaults below are IDM's own set, which is the set most people
 * already have muscle memory for.
 */

export function defaultCategories(): Category[] {
  return [
    {
      id: randomUUID(),
      name: 'Compressed',
      folder: 'Compressed',
      builtin: true,
      hosts: [],
      extensions: ['zip', 'rar', '7z', 'gz', 'bz2', 'xz', 'tar', 'tgz', 'cab', 'arj', 'lzh', 'ace']
    },
    {
      id: randomUUID(),
      name: 'Documents',
      folder: 'Documents',
      builtin: true,
      hosts: [],
      extensions: [
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'rtf',
        'txt', 'epub', 'mobi', 'djvu', 'chm'
      ]
    },
    {
      id: randomUUID(),
      name: 'Music',
      folder: 'Music',
      builtin: true,
      hosts: [],
      extensions: ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'aiff', 'ape']
    },
    {
      id: randomUUID(),
      name: 'Programs',
      folder: 'Programs',
      builtin: true,
      hosts: [],
      extensions: ['exe', 'msi', 'msix', 'appx', 'bat', 'cmd', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'iso', 'img']
    },
    {
      id: randomUUID(),
      name: 'Video',
      folder: 'Video',
      builtin: true,
      hosts: [],
      extensions: ['mkv', 'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', '3gp']
    }
  ]
}

/**
 * Picks the category a filename belongs to.
 *
 * Extension first because it is what the user sees and edits. The MIME type is
 * only a fallback, for the `/download?id=123` style URL that arrives with no
 * usable extension at all.
 */
export function categoryFor(
  categories: Category[],
  filename: string,
  mimeType: string | null
): Category | null {
  const ext = extensionOf(filename)

  if (ext) {
    const byExt = categories.find((c) => c.extensions.includes(ext))
    if (byExt) return byExt
  }

  if (mimeType) {
    const base = mimeType.split(';')[0].trim().toLowerCase()
    const family = base.split('/')[0]
    const familyName =
      family === 'audio' ? 'Music' : family === 'video' ? 'Video' : family === 'text' ? 'Documents' : null

    if (familyName) {
      const byFamily = categories.find((c) => c.name === familyName)
      if (byFamily) return byFamily
    }
  }

  return null
}

/**
 * The directory a task should land in. Uncategorised downloads stay in the root
 * rather than being swept into a catch-all folder the user never asked for.
 */
export function directoryFor(
  downloadDir: string,
  categories: Category[],
  filename: string,
  mimeType: string | null,
  explicitCategoryId: string | null,
  sourceUrl?: string
): { dir: string; categoryId: string | null } {
  downloadDir = normalizeDownloadDirectory(downloadDir)
  if (explicitCategoryId) {
    const explicit = categories.find((c) => c.id === explicitCategoryId)
    if (explicit) return { dir: join(downloadDir, explicit.folder), categoryId: explicit.id }
  }

  if (sourceUrl) {
    try {
      const host = new URL(sourceUrl).hostname.toLowerCase()
      const byHost = categories.find((category) =>
        (category.hosts ?? []).some((rule) => host === rule || host.endsWith('.' + rule))
      )
      if (byHost) return { dir: join(downloadDir, byHost.folder), categoryId: byHost.id }
    } catch {}
  }

  const match = categoryFor(categories, filename, mimeType)
  if (!match) return { dir: downloadDir, categoryId: null }

  return { dir: join(downloadDir, match.folder), categoryId: match.id }
}
