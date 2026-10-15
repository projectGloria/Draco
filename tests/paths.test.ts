import { ok, strictEqual, throws } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveTorrentItemPath } from '../src/main/engine/torrent-path.ts'
import {
  intermediatePathsFor,
  isDracoIntermediate,
  partPathFor,
  workspaceDir
} from '../src/main/engine/workspace.ts'
import { normalizeDownloadDirectory, safeDownloadDirectory } from '../src/main/destination-path.ts'
import { toFolderName } from '../src/main/store-sanitize-path.ts'

it('escapes reserved Windows names before the first dot in category and group folders', () => {
  strictEqual(toFolderName('CON.tar'), 'CON_.tar')
  strictEqual(toFolderName('LPT³.backup'), 'LPT³_.backup')
})

/**
 * Path handling, which is both a correctness rule (one owner for every
 * intermediate) and a security boundary (a torrent names its own files, and a
 * peer chooses what those names are).
 */

describe('resolveTorrentItemPath', () => {
  const root = 'C:\\Downloads\\show'
  const allowed = ['show\\ep1.mkv', 'show\\extras\\clip.mkv']

  it('resolves a listed item beneath the root', () => {
    const target = resolveTorrentItemPath(root, 'show\\ep1.mkv', allowed)
    strictEqual(target, 'C:\\Downloads\\show\\show\\ep1.mkv')
  })

  it('resolves a nested listed item', () => {
    ok(resolveTorrentItemPath(root, 'show\\extras\\clip.mkv', allowed)?.endsWith('extras\\clip.mkv'))
  })

  it('refuses a path the metadata never listed', () => {
    // The allow-list is the whole defence: without it, a renderer bug or a
    // hostile torrent could name any file on the disk.
    strictEqual(resolveTorrentItemPath(root, 'show\\secret.mkv', allowed), null)
  })

  it('refuses traversal even when the torrent lists it', () => {
    strictEqual(resolveTorrentItemPath(root, '..\\..\\Windows\\System32\\drivers\\etc\\hosts', [
      '..\\..\\Windows\\System32\\drivers\\etc\\hosts'
    ]), null)
    strictEqual(resolveTorrentItemPath(root, 'show\\..\\..\\other.txt', ['show\\..\\..\\other.txt']), null)
    strictEqual(resolveTorrentItemPath(root, '..\\outside.txt', ['..\\outside.txt']), null)
  })

  it('permits filenames starting with dots that are not directory traversal', () => {
    const target = resolveTorrentItemPath(root, 'show\\..notes.txt', ['show\\..notes.txt'])
    strictEqual(target, 'C:\\Downloads\\show\\show\\..notes.txt')
  })

  it('refuses an absolute path that escapes the root', () => {
    strictEqual(resolveTorrentItemPath(root, 'C:\\Windows\\notepad.exe', ['C:\\Windows\\notepad.exe']), null)
  })

  it('refuses the root itself', () => {
    strictEqual(resolveTorrentItemPath(root, '.', ['.']), null, 'the root is not an item in it')
  })
})

describe('workspaceDir', () => {
  it('uses the shared temp dir only when it shares a volume with the destination', () => {
    // Across volumes the finishing move becomes a full copy - minutes of disk
    // time on a large download, and twice the space transiently.
    strictEqual(workspaceDir('C:\\Downloads', 'C:\\Temp'), 'C:\\Temp')
    strictEqual(workspaceDir('D:\\Downloads', 'C:\\Temp'), 'D:\\Downloads')
    strictEqual(workspaceDir('C:\\Downloads'), 'C:\\Downloads', 'no temp dir means beside the file')
  })

  it('isolates equal filenames by task identity on the destination volume', () => {
    const first = partPathFor('C:\\Downloads', 'clip.mp4', 'first', 'C:\\Temp')
    const second = partPathFor('C:\\Downloads', 'clip.mp4', 'second', 'C:\\Temp')
    ok(first.startsWith('C:\\Temp\\.draco-tasks\\'))
    ok(second.startsWith('C:\\Temp\\.draco-tasks\\'))
    ok(first.endsWith('\\clip.mp4.dracodl'))
    ok(first !== second)
    ok(partPathFor('D:\\Downloads', 'clip.mp4', 'first', 'C:\\Temp').startsWith('D:\\Downloads\\.draco-tasks\\'))
  })
})

describe('isDracoIntermediate', () => {
  it('claims only Draco\'s own leftovers', () => {
    ok(isDracoIntermediate('clip.mp4.dracodl'))
    ok(isDracoIntermediate('clip.mp4.dracodl.json'))
    strictEqual(isDracoIntermediate('clip.mp4'), false, 'a finished download is not a leftover')
    strictEqual(isDracoIntermediate('holiday.jpg'), false)
  })
})

describe('intermediatePathsFor', () => {
  it('cleans only the task-owned workspace', () => {
    const { files, dirs } = intermediatePathsFor(
      { id: 'first', dir: 'C:\\Downloads', filename: 'clip.mp4', audioUrl: null },
      'C:\\Temp'
    )
    strictEqual(files.length, 0)
    strictEqual(dirs.length, 1)
    ok(dirs[0].startsWith('C:\\Temp\\.draco-tasks\\'))
  })

  it('does not remove another task sharing the final name', () => {
    const first = intermediatePathsFor(
      { id: 'first', dir: 'C:\\Downloads', filename: 'clip.mp4', audioUrl: 'https://example.test/audio.m4a' },
      'C:\\Temp'
    )
    const second = intermediatePathsFor(
      {
        id: 'second',
        dir: 'C:\\Downloads',
        filename: 'clip.mp4',
        audioUrl: 'https://example.test/audio.m4a',
        youtube: { videoFormatId: '137', audioFormatId: '140', pageUrl: 'https://youtube.com/watch?v=abc' }
      },
      'C:\\Temp'
    )
    ok(first.dirs[0] !== second.dirs[0])
  })
})

describe('download directory safety', () => {
  it('converts a picked path into an unambiguous Windows one', () => {
    strictEqual(normalizeDownloadDirectory('C:/Users/me/Downloads'), 'C:\\Users\\me\\Downloads')
    strictEqual(normalizeDownloadDirectory('C:\\Users\\me\\..\\me\\Downloads'), 'C:\\Users\\me\\Downloads')
    // A bare `D:` is drive-relative to Node but means the drive root to anyone
    // who picked it in a folder browser.
    strictEqual(normalizeDownloadDirectory('D:'), 'D:\\')
  })

  it('refuses anything that is not an absolute path', () => {
    throws(() => normalizeDownloadDirectory('Downloads'))
    throws(() => normalizeDownloadDirectory('   '))
    throws(() => normalizeDownloadDirectory('\\Downloads'))
    throws(() => normalizeDownloadDirectory('/Downloads'))
    throws(() => normalizeDownloadDirectory('D:Downloads'))
    strictEqual(normalizeDownloadDirectory('\\\\server\\share\\Media'), '\\\\server\\share\\Media')
  })

  it('falls back rather than trusting a stored value that is not an absolute path', () => {
    const fallback = 'C:\\Users\\me\\Downloads'
    strictEqual(safeDownloadDirectory('..\\..\\Windows', fallback), fallback)
    strictEqual(safeDownloadDirectory('', fallback), fallback)
    strictEqual(safeDownloadDirectory(42, fallback), fallback)
    strictEqual(safeDownloadDirectory(null, fallback), fallback)
    strictEqual(safeDownloadDirectory('D:\\Media', fallback), 'D:\\Media', 'a real path is kept')
  })
})

describe('toFolderName', () => {
  it('produces a Windows-safe subfolder from an arbitrary title', () => {
    strictEqual(toFolderName('Season 1: "Pilot"/Extras'), 'Season 1 PilotExtras')
    strictEqual(toFolderName('   '), 'Untitled')
    strictEqual(toFolderName('nul'), 'nul_')
    strictEqual(toFolderName('con.txt'), 'con_.txt', 'the device name must be escaped before the extension')
    strictEqual(toFolderName('aux.backup'), 'aux_.backup')
    strictEqual(toFolderName('x'.repeat(200)).length, 60, 'capped so the full path stays openable')
    strictEqual(toFolderName('x'.repeat(59) + '.continued'), 'x'.repeat(59), 'truncation must not leave a trailing dot')
  })
})
