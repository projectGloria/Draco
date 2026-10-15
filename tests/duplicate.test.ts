import { ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { comparableUrl, findDuplicate, sameResource } from '../src/main/engine/duplicate.ts'
import { buildTransferFile, buildUrlList, parseTransferFile } from '../src/main/transfer-list.ts'
import type { DownloadTask } from '../src/shared/types.ts'

/** Enough of a task for the two things this file asks about. */
function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'task-1',
    url: 'https://example.test/file.bin',
    finalUrl: 'https://example.test/file.bin',
    filename: 'file.bin',
    filenameLocked: false,
    dir: 'C:\\Downloads',
    categoryId: null,
    queueId: null,
    queueRetryCount: 0,
    nextQueueAttemptAt: null,
    manualPause: false,
    kind: 'file',
    size: 1000,
    received: 1000,
    status: 'done',
    resumable: true,
    singleConnectionFallback: false,
    segments: [],
    connections: 8,
    speed: 0,
    eta: null,
    error: null,
    detail: null,
    createdAt: 1,
    startedAt: 1,
    completedAt: 2,
    etag: null,
    lastModified: null,
    headers: {},
    mimeType: null,
    description: '',
    ...overrides
  }
}

describe('comparableUrl', () => {
  it('ignores what never reaches the server', () => {
    strictEqual(
      comparableUrl('https://Example.test/file.bin#section'),
      comparableUrl('https://example.test/file.bin')
    )
  })

  it('ignores a default port', () => {
    strictEqual(comparableUrl('https://example.test:443/f'), comparableUrl('https://example.test/f'))
    strictEqual(comparableUrl('http://example.test:80/f'), comparableUrl('http://example.test/f'))
    ok(comparableUrl('https://example.test:8443/f') !== comparableUrl('https://example.test/f'))
  })

  it('keeps the query, which is often the identity of the file', () => {
    ok(comparableUrl('https://example.test/get?id=1') !== comparableUrl('https://example.test/get?id=2'))
  })

  it('reduces a magnet link to its info hash', () => {
    const hash = 'a'.repeat(40)
    strictEqual(
      comparableUrl(`magnet:?xt=urn:btih:${hash}&dn=Some+Name&tr=http://tracker.test`),
      comparableUrl(`magnet:?xt=urn:btih:${hash.toUpperCase()}&tr=http://other.test`)
    )
  })

  it('has no answer for something that is not a URL', () => {
    strictEqual(comparableUrl('not a url'), null)
    strictEqual(sameResource('not a url', 'not a url'), false, 'two unparseable strings are not a match')
  })
})

describe('findDuplicate', () => {
  it('finds nothing in an empty list', () => {
    strictEqual(findDuplicate([], { url: 'https://example.test/file.bin' }), null)
  })

  it('matches the same URL', () => {
    const match = findDuplicate([task()], { url: 'https://example.test/file.bin#anchor' })
    strictEqual(match?.taskId, 'task-1')
    strictEqual(match?.reason, 'url')
    strictEqual(match?.status, 'done')
  })

  it('reports an unfinished duplicate too - it is already in the list', () => {
    const match = findDuplicate([task({ status: 'downloading' })], { url: 'https://example.test/file.bin' })
    strictEqual(match?.status, 'downloading')
  })

  it('matches a signed media URL by the page it came from', () => {
    // Two lookups of the same video an hour apart share nothing but the path;
    // the page URL is the identity that outlives the signature.
    const existing = task({
      url: 'https://rr1.googlevideo.com/videoplayback?itag=137&expire=111',
      youtube: { pageUrl: 'https://www.youtube.com/watch?v=abc', videoFormatId: '137' }
    })

    const match = findDuplicate([existing], {
      url: 'https://rr9.googlevideo.com/videoplayback?itag=137&expire=999',
      pageUrl: 'https://www.youtube.com/watch?v=abc'
    })
    strictEqual(match?.taskId, 'task-1')
  })

  it('matches a finished download by where it landed', () => {
    // The same file offered from a second address, or a row that was renamed.
    const match = findDuplicate([task()], {
      url: 'https://mirror.test/other-name.bin',
      dir: 'c:\\downloads',
      filename: 'file.bin'
    })
    strictEqual(match?.reason, 'destination')
  })

  it('prefers a URL match over a destination match', () => {
    const byDestination = task({ id: 'dest', url: 'https://other.test/x' })
    const byUrl = task({ id: 'url', filename: 'different.bin' })

    const match = findDuplicate([byDestination, byUrl], {
      url: 'https://example.test/file.bin',
      dir: 'C:\\Downloads',
      filename: 'file.bin'
    })
    strictEqual(match?.taskId, 'url')
  })

  it('does not match an unfinished download by destination', () => {
    // Nothing has landed there yet, so there is nothing to have already got.
    const match = findDuplicate([task({ status: 'downloading' })], {
      url: 'https://mirror.test/x.bin',
      dir: 'C:\\Downloads',
      filename: 'file.bin'
    })
    strictEqual(match, null)
  })

  it('ignores the task being re-examined', () => {
    strictEqual(findDuplicate([task()], { url: 'https://example.test/file.bin' }, 'task-1'), null)
  })
})

describe('transfer lists', () => {
  it('round-trips Draco\'s own format with the decisions intact', () => {
    const file = buildTransferFile([
      task({ description: 'notes', categoryId: 'video', queueId: 'q1' })
    ])
    strictEqual(file.format, 'draco-downloads')

    const [imported] = parseTransferFile(JSON.stringify(file))
    strictEqual(imported.url, 'https://example.test/file.bin')
    strictEqual(imported.filename, 'file.bin')
    strictEqual(imported.dir, 'C:\\Downloads')
    strictEqual(imported.categoryId, 'video')
    strictEqual(imported.queueId, 'q1')
  })

  it('never starts an imported download by itself', () => {
    // Fifty downloads beginning at once is not what dropping a list in means.
    const [imported] = parseTransferFile(JSON.stringify(buildTransferFile([task()])))
    strictEqual(imported.autoStart, false)
  })

  it('exports the page URL of a signed download, which still resolves tomorrow', () => {
    const youtube = task({
      url: 'https://rr1.googlevideo.com/videoplayback?expire=1',
      youtube: { pageUrl: 'https://www.youtube.com/watch?v=abc', videoFormatId: '137' }
    })

    strictEqual(buildUrlList([youtube]).trim(), 'https://www.youtube.com/watch?v=abc')
    strictEqual(buildTransferFile([youtube]).items[0].url,
      'https://www.youtube.com/watch?v=abc')
    strictEqual(parseTransferFile(JSON.stringify(buildTransferFile([youtube])))[0].url,
      'https://www.youtube.com/watch?v=abc')
  })

  it('writes a plain list without repeats', () => {
    const list = buildUrlList([task(), task({ id: 'two' }), task({ id: 'three', url: 'https://example.test/b.bin' })])
    strictEqual(list.trim().split(/\r\n/).length, 2)
  })

  it('reads a plain list, skipping comments and noise', () => {
    const items = parseTransferFile([
      '# my list',
      '; another comment',
      'https://example.test/a.bin',
      '',
      'not a url',
      'https://example.test/b.bin   trailing note',
      'magnet:?xt=urn:btih:' + 'a'.repeat(40)
    ].join('\n'))

    strictEqual(items.length, 3)
    strictEqual(items[1].url, 'https://example.test/b.bin')
  })

  it('reads a file that claims to be JSON but is not, as a list', () => {
    const items = parseTransferFile('{ broken\nhttps://example.test/a.bin')
    strictEqual(items.length, 1)
  })

  it('refuses schemes that are not downloads', () => {
    const items = parseTransferFile([
      'file:///C:/Windows/notepad.exe',
      'javascript:alert(1)',
      'https://example.test/ok.bin'
    ].join('\n'))
    strictEqual(items.length, 1)
    strictEqual(items[0].url, 'https://example.test/ok.bin')
  })

  it('has nothing to say about an empty file', () => {
    strictEqual(parseTransferFile('').length, 0)
    strictEqual(parseTransferFile('   \n\n').length, 0)
  })

  it('ignores JSON of some other shape', () => {
    strictEqual(parseTransferFile('{"format":"something-else","items":[{"url":"https://x.test/a"}]}').length, 0)
  })
})
