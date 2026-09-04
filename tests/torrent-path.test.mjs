import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveTorrentItemPath } from '../src/main/engine/torrent-path.ts'

test('torrent item actions stay inside the destination and require a listed path', () => {
  const root = 'C:\\Downloads\\Draco'
  const allowed = ['release/cover.jpg', '../outside.txt']

  assert.equal(
    resolveTorrentItemPath(root, 'release/cover.jpg', allowed),
    'C:\\Downloads\\Draco\\release\\cover.jpg'
  )
  assert.equal(resolveTorrentItemPath(root, 'release/unlisted.jpg', allowed), null)
  assert.equal(resolveTorrentItemPath(root, '../outside.txt', allowed), null)
})
