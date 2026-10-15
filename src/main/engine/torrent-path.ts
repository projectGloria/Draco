import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Resolves only a metadata-listed item that remains beneath the download root. */
export function resolveTorrentItemPath(
  rootDir: string,
  itemPath: string,
  allowedPaths: readonly string[]
): string | null {
  if (!allowedPaths.includes(itemPath)) return null
  const root = resolve(rootDir)
  const target = resolve(root, itemPath)
  const inside = relative(root, target)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || inside.startsWith('../') || isAbsolute(inside)) return null
  return target
}
