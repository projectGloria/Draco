import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildTorrentTree, selectTorrentPaths } from '../src/shared/torrent-tree.ts'

const files = [
  { path: 'Series/Episode 1.mkv', size: 100 },
  { path: 'Series/Episode 2.mkv', size: 200 },
  { path: 'Series/Featurettes/Interview.mkv', size: 30 },
  { path: 'Series/Soundtrack/01.flac', size: 10 },
  { path: 'Series/Soundtrack/02.flac', size: 20 }
]

describe('torrent contents tree', () => {
  it('preserves the root and nested folders, showing only each leaf name', () => {
    const [root] = buildTorrentTree(files)
    strictEqual(root.name, 'Series')
    strictEqual(root.size, 360)
    deepStrictEqual(root.children.map((node) => node.name), ['Featurettes', 'Soundtrack', 'Episode 1.mkv', 'Episode 2.mkv'])
    strictEqual(root.children[0].children[0].name, 'Interview.mkv')
    strictEqual(root.children[1].size, 30)
    deepStrictEqual(root.filePaths, files.map((file) => file.path))
  })

  it('selects an entire folder without changing unrelated selections or original paths', () => {
    const [root] = buildTorrentTree(files)
    const soundtrack = root.children.find((node) => node.name === 'Soundtrack')!
    const initial = new Set([files[0].path, files[3].path])
    const all = selectTorrentPaths(initial, soundtrack.filePaths, true)
    deepStrictEqual([...all], [files[0].path, files[3].path, files[4].path])
    deepStrictEqual([...selectTorrentPaths(all, soundtrack.filePaths, false)], [files[0].path])
    strictEqual(initial.size, 2, 'selection updates must not mutate React state')
  })

  it('retains search ancestors and complete folder selection even when siblings are hidden', () => {
    const [root] = buildTorrentTree(files, '01.flac')
    deepStrictEqual(root.children.map((node) => node.name), ['Soundtrack'])
    const soundtrack = root.children[0]
    deepStrictEqual(soundtrack.children.map((node) => node.name), ['01.flac'])
    deepStrictEqual(soundtrack.filePaths, [files[3].path, files[4].path])
    strictEqual(soundtrack.size, 30)
    strictEqual(buildTorrentTree(files, 'absent').length, 0)
    strictEqual(buildTorrentTree(files, 'soundtrack')[0].children[0].children.length, 2)
  })

  it('sorts sizes within each folder without flattening the hierarchy', () => {
    const [root] = buildTorrentTree(files, '', 'desc')
    deepStrictEqual(root.children.filter((node) => node.kind === 'file').map((node) => node.name), ['Episode 2.mkv', 'Episode 1.mkv'])
    const soundtrack = root.children.find((node) => node.name === 'Soundtrack')!
    deepStrictEqual(soundtrack.children.map((node) => node.name), ['02.flac', '01.flac'])
  })

  it('supports Windows separators, repeated leaf names, and single-file torrents', () => {
    const paths = [
      { path: 'Root\\A\\sample.mkv', size: 1 },
      { path: 'Root\\B\\sample.mkv', size: 2 }
    ]
    const [root] = buildTorrentTree(paths)
    deepStrictEqual(root.children.map((node) => node.name), ['A', 'B'])
    deepStrictEqual(root.filePaths, paths.map((file) => file.path))
    strictEqual(buildTorrentTree(paths, 'root/a')[0].children[0].name, 'A')
    const [single] = buildTorrentTree([{ path: 'movie.mkv', size: 42 }])
    strictEqual(single.kind, 'file')
    strictEqual(single.name, 'movie.mkv')
    deepStrictEqual(buildTorrentTree([]), [])
  })
})
