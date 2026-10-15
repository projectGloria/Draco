import type { TorrentFile } from './types.ts'

export interface TorrentTreeNode {
  key: string
  name: string
  kind: 'folder' | 'file'
  size: number
  /** Original torrent paths, also for descendants hidden by a search. */
  filePaths: string[]
  children: TorrentTreeNode[]
}

/** Group display paths without changing the paths sent to the torrent engine. */
export function buildTorrentTree(
  files: readonly TorrentFile[],
  query = '',
  sizeDirection: 'none' | 'asc' | 'desc' = 'none'
): TorrentTreeNode[] {
  const roots: TorrentTreeNode[] = []
  const folders = new Map<string, TorrentTreeNode>()
  for (const file of files) {
    const parts = file.path.split(/[\\/]/).filter(Boolean)
    let children = roots
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(0, i + 1).join('/')
      let folder = folders.get(key)
      if (!folder) {
        folder = { key: `folder:${key}`, name: parts[i], kind: 'folder', size: 0, filePaths: [], children: [] }
        folders.set(key, folder)
        children.push(folder)
      }
      folder.size += file.size
      folder.filePaths.push(file.path)
      children = folder.children
    }
    children.push({
      key: `file:${file.path}`, name: parts.at(-1) ?? file.path,
      kind: 'file', size: file.size, filePaths: [file.path], children: []
    })
  }

  const needle = query.trim().replace(/\\/g, '/').toLowerCase()
  const arrange = (nodes: TorrentTreeNode[]): TorrentTreeNode[] => nodes
    .map((node) => node.kind === 'folder' ? { ...node, children: arrange(node.children) } : node)
    .filter((node) => node.kind === 'folder'
      ? node.children.length > 0
      : node.filePaths[0].replace(/\\/g, '/').toLowerCase().includes(needle))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
      return sizeDirection === 'none' ? 0 : sizeDirection === 'asc' ? a.size - b.size : b.size - a.size
    })
  return arrange(roots)
}

export function selectTorrentPaths(selected: ReadonlySet<string>, paths: readonly string[], checked: boolean): Set<string> {
  const next = new Set(selected)
  for (const path of paths) {
    if (checked) next.add(path)
    else next.delete(path)
  }
  return next
}
