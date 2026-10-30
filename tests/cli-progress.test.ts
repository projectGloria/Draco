import { deepStrictEqual, equal, ok } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MediaProgress, MEDIA_PROGRESS_ARGS } from '../src/cli/media-download.ts'
import { formatBytes, formatDuration, friendlyError, painter, progressBar, stepName, transfer, transferLines } from '../src/cli/progress.ts'
import { iconRows, ICON_COLUMNS, ICON_ROWS } from '../src/cli/terminal-view.ts'
import { cleanText, richGlyphs, width, wrap } from '../src/cli/text.ts'

/**
 * The progress card and the yt-dlp line protocol behind it. The sample lines
 * are verbatim output of yt-dlp 2026.10.26 for a merged bv*+ba download.
 */

const plain = painter(false, true)

describe('progress bar', () => {
  it('is exactly the requested width at every fraction, smooth or not', () => {
    for (const rich of [true, false]) {
      const p = painter(true, rich)
      for (const size of [1, 7, 24, 93]) {
        for (const fraction of [0, 0.004, 0.33, 0.5, 0.999, 1, null]) {
          equal(width(progressBar(fraction, size, p, 12345)), size, `${rich} ${size} ${fraction}`)
        }
      }
    }
  })

  it('uses eighth blocks only where the font has them', () => {
    ok(/[▏▎▍▌▋▊▉]/.test(progressBar(0.33, 10, painter(false, true))))
    ok(!/[▏▎▍▌▋▊▉]/.test(progressBar(0.33, 10, painter(false, false))))
  })

  it('sweeps while the size is unknown', () => {
    ok(progressBar(null, 30, plain, 0) !== progressBar(null, 30, plain, 900))
  })
})

describe('progress card', () => {
  const card = transfer('a', 'The International Archives: Gyro Diffusal', 'downloading',
    { step: 'Video', part: 1, parts: 2, received: 20.1 * 1048576, total: 58.8 * 1048576, speed: 4.5 * 1048576, eta: 8 })

  it('says what, how far, how fast and how long, in plain words', () => {
    const [head, bar, detail] = transferLines(card, 80, plain, 0)
    ok(head.includes('Gyro Diffusal') && head.endsWith('Video · 1 of 2'))
    ok(bar.trimEnd().endsWith('34%'))
    equal(detail, '20.1 MB of 58.8 MB · 4.5 MB/s · 8s left')
  })

  it('fits any width, with wide titles and every phase', () => {
    const titles = ['x', '日本語のタイトル'.repeat(12), '\x1b[2Jevil\x07']
    for (const phase of ['waiting', 'preparing', 'downloading', 'finishing'] as const) {
      for (const title of titles) {
        for (const columns of [8, 20, 47, 120]) {
          const lines = transferLines({ ...card, title, phase }, columns, painter(true, true), 0)
          equal(lines.length, 3)
          ok(lines.every(line => width(line) <= columns), `${phase} ${columns}: ${JSON.stringify(lines.map(cleanText))}`)
          ok(!lines.join('').includes('\x1b[2J'))
        }
      }
    }
  })

  it('formats sizes and durations for people', () => {
    equal(formatBytes(0), '0 B')
    equal(formatBytes(61_656_268), '58.8 MB')
    equal(formatBytes(150 * 1048576), '150 MB')
    equal(formatBytes(null), '?')
    equal(formatDuration(8), '8s')
    equal(formatDuration(128), '2m 08s')
    equal(formatDuration(3840), '1h 04m')
    equal(formatDuration(null), null)
  })
})

describe('yt-dlp progress protocol', () => {
  it('asks yt-dlp for raw numbers rather than its formatted strings', () => {
    const templates = MEDIA_PROGRESS_ARGS.join(' ')
    ok(templates.includes('%(progress.downloaded_bytes)s'))
    ok(!templates.includes('_percent_str'))
  })

  it('follows a merged download from video to audio to finishing', () => {
    const progress = new MediaProgress()
    equal(progress.current.phase, 'preparing')
    progress.receive('DRACO_ITEM:||395+251|Me at the zoo')
    equal(progress.current.title, 'Me at the zoo')
    progress.receive('DRACO_STEP:ThumbnailsConvertor|started')
    equal(progress.current.phase, 'preparing', 'cover art before the download is still preparing')

    progress.receive('DRACO_PROGRESS:395|av01.0.00M.08.0.110.05.01.06.0|1024|223779|NA|327460.1476059774|0')
    deepStrictEqual([progress.current.phase, progress.current.step, progress.current.part, progress.current.parts],
      ['downloading', 'Video', 1, 2])
    equal(progress.current.received, 1024)
    equal(progress.current.total, 223779)

    progress.receive('DRACO_PROGRESS:251|none|1024|NA|252182|253300.73|NA')
    deepStrictEqual([progress.current.step, progress.current.part, progress.current.total, progress.current.eta], ['Audio', 2, 252182, null])

    progress.receive('DRACO_STEP:Merger|started')
    deepStrictEqual([progress.current.phase, progress.current.step], ['finishing', 'Merging video and audio'])
    equal(progress.receive('DRACO_STEP:Merger|finished'), null)

    deepStrictEqual(progress.receive('DRACO_DONE:C:\\Videos\\Me at the zoo [jNQXAC9IVRw].mkv'),
      { kind: 'done', path: 'C:\\Videos\\Me at the zoo [jNQXAC9IVRw].mkv' })
  })

  it('numbers playlist items and survives a "|" in a title', () => {
    const progress = new MediaProgress()
    progress.receive('DRACO_ITEM:3|12|22|Part A | Part B')
    equal(progress.current.title, 'Part A | Part B (3 of 12)')
    progress.receive('DRACO_PROGRESS:22|avc1|10|100|NA|NA|NA')
    equal(progress.current.step, null, 'a single-file format has no video/audio steps')
  })

  it('ignores the chatter it did not ask for', () => {
    equal(new MediaProgress().receive('[youtube] jNQXAC9IVRw: Downloading android player API JSON'), null)
  })

  it('names postprocessors in plain words', () => {
    equal(stepName('EmbedThumbnail'), 'Adding cover art')
    equal(stepName('FixupM3u8'), 'Tidying up the file')
    equal(stepName('SomethingNew'), 'Finishing your file')
  })
})

describe('friendly errors', () => {
  it('turns common failures into advice', () => {
    ok(friendlyError("ERROR: [youtube] abc123: Sign in to confirm you're not a bot. Use --cookies-from-browser").includes('draco.cfg'))
    ok(friendlyError('ERROR: [youtube] abc: Private video. Sign in if you have access').startsWith('This video is private'))
    ok(friendlyError('ERROR: [youtube] abc: Video unavailable').startsWith('This video is not available'))
    ok(friendlyError('getaddrinfo ENOTFOUND example.com').includes('internet connection'))
    ok(friendlyError('ENOSPC: no space left on device, write').includes('disk is full'))
    ok(friendlyError("EPERM: operation not permitted, open 'C:\\Windows\\x'").includes('F2 Settings'))
  })

  it('keeps unknown errors but drops developer noise', () => {
    equal(friendlyError('ERROR: [generic] xyz: Something odd happened; please report this issue on GitHub'), 'Something odd happened')
  })
})

describe('terminal text', () => {
  it('wraps words, hard-splits long ones and caps the line count', () => {
    deepStrictEqual(wrap('one two three', 7), ['one two', 'three'])
    deepStrictEqual(wrap('https://example.com/very/long', 10), ['https://ex', 'ample.com/', 'very/long'])
    const capped = wrap('a b c d e f g h', 3, 2)
    equal(capped.length, 2)
    ok(capped[1].endsWith('…'))
  })

  it('uses Cascadia-only symbols only in terminals that ship Cascadia', () => {
    equal(richGlyphs({ WT_SESSION: '1' }, 'win32'), true)
    equal(richGlyphs({}, 'win32'), false)
    equal(richGlyphs({}, 'linux'), true)
  })

  it('draws the icon as a square-pixel block that matches its declared size', () => {
    for (const color of [true, false]) {
      const rows = iconRows(color)
      equal(rows.length, ICON_ROWS)
      ok(rows.every(row => width(row) === ICON_COLUMNS))
    }
  })
})
