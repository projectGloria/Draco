import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseArgs, parseFormat, parseRate, pickVariant, UsageError } from '../src/cli/args.ts'
import type { MediaVariant } from '../src/shared/types.ts'

const URL = 'https://www.youtube.com/watch?v=x'

function video(height: number, bandwidth: number, extra: Partial<MediaVariant> = {}): MediaVariant {
  return {
    url: `https://cdn/${height}-${bandwidth}`,
    audioUrl: 'https://cdn/audio',
    label: `${height}p`,
    height,
    bandwidth,
    codecs: null,
    estimatedSize: null,
    container: 'mp4',
    youtube: { videoFormatId: String(height), audioFormatId: '140', role: 'video' },
    ...extra
  }
}

function audio(bandwidth: number): MediaVariant {
  return {
    url: `https://cdn/a-${bandwidth}`,
    label: `${bandwidth}k`,
    height: null,
    bandwidth,
    codecs: null,
    estimatedSize: null,
    container: 'm4a',
    youtube: { videoFormatId: `a${bandwidth}`, role: 'audio' }
  }
}

describe('cli parseArgs', () => {
  it('reads `draco <url> -best` the way people type it', () => {
    const options = parseArgs([URL, '-best'])
    deepStrictEqual(options.urls, [URL])
    deepStrictEqual(options.format, { kind: 'best' })
    strictEqual(options.formatExplicit, true)
  })

  it('defaults to best without marking the format explicit', () => {
    const options = parseArgs([URL])
    deepStrictEqual(options.format, { kind: 'best' })
    strictEqual(options.formatExplicit, false)
  })

  it('accepts yt-dlp style values and --flag=value', () => {
    deepStrictEqual(parseArgs([URL, '-f', '720p']).format, { kind: 'height', height: 720 })
    deepStrictEqual(parseArgs([URL, '--format=bestaudio']).format, { kind: 'bestaudio' })
    strictEqual(parseArgs([URL, '-P', 'D:\\Videos']).dir, 'D:\\Videos')
    strictEqual(parseArgs([URL, '--limit-rate=2M']).rateLimit, 2 * 1024 * 1024)
  })

  it('refuses two formats that disagree instead of silently taking the last', () => {
    throws(() => parseArgs([URL, '-best', '-x']), UsageError)
    // Repeating the same one is not a conflict.
    deepStrictEqual(parseArgs([URL, '-best', '-best']).format, { kind: 'best' })
  })

  it('rejects unknown options, missing values, and a URL-less run', () => {
    throws(() => parseArgs([URL, '--bogus']), /unknown option/)
    throws(() => parseArgs([URL, '-f']), /needs a value/)
    throws(() => parseArgs(['-best']), /no URL/)
    throws(() => parseArgs([URL, '-N', '0']), /1 to 64/)
    throws(() => parseArgs(['']), /empty URL/)
  })

  it('only allows -o with a single URL', () => {
    throws(() => parseArgs([URL, URL + '2', '-o', 'a.mp4']), /one file/)
  })

  it('treats everything after -- as a URL', () => {
    deepStrictEqual(parseArgs(['--', '-weird']).urls, ['-weird'])
  })

  it('lets --help through without a URL', () => {
    strictEqual(parseArgs(['--help']).help, true)
  })
})

describe('cli parseFormat / parseRate', () => {
  it('understands the common yt-dlp height selectors', () => {
    deepStrictEqual(parseFormat('bv*[height<=1080]+ba'), { kind: 'height', height: 1080 })
    deepStrictEqual(parseFormat('#3'), { kind: 'index', index: 3 })
    throws(() => parseFormat('9000x'), UsageError)
  })

  it('uses binary multiples like yt-dlp', () => {
    strictEqual(parseRate('500K'), 500 * 1024)
    strictEqual(parseRate('1.5MiB'), Math.floor(1.5 * 1024 * 1024))
    throws(() => parseRate('fast'), UsageError)
  })
})

describe('cli pickVariant', () => {
  const ladder = [video(1080, 3_000_000), video(1080, 4_000_000), video(720, 2_000_000), video(360, 500_000), audio(128_000), audio(256_000)]

  it('best is the tallest rung, ties broken by bitrate', () => {
    strictEqual(pickVariant(ladder, { kind: 'best' })?.bandwidth, 4_000_000)
  })

  it('worst is the shortest video rung, never an audio track', () => {
    strictEqual(pickVariant(ladder, { kind: 'worst' })?.height, 360)
  })

  it('bestaudio is the highest-bitrate audio-only stream', () => {
    strictEqual(pickVariant(ladder, { kind: 'bestaudio' })?.bandwidth, 256_000)
  })

  it('a height never goes above the request unless nothing is that short', () => {
    strictEqual(pickVariant(ladder, { kind: 'height', height: 900 })?.height, 720)
    strictEqual(pickVariant(ladder, { kind: 'height', height: 144 })?.height, 360)
  })

  it('#N is the -F row, 1-based', () => {
    strictEqual(pickVariant(ladder, { kind: 'index', index: 3 })?.height, 720)
    strictEqual(pickVariant(ladder, { kind: 'index', index: 99 }), null)
  })

  it('best on an audio-only page is the best audio, not a refusal', () => {
    strictEqual(pickVariant([audio(64_000), audio(320_000)], { kind: 'best' })?.bandwidth, 320_000)
  })

  it('classifies role-less scraped variants by container', () => {
    const scraped: MediaVariant = { ...audio(192_000), youtube: undefined, container: 'mp3' }
    strictEqual(pickVariant([video(480, 1), scraped], { kind: 'bestaudio' }), scraped)
  })
})
