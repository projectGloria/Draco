import { deepStrictEqual, match, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bestDirectVideoHeight, buildVariants, formatsFromYtDlp, selectDirectYtFormat, offeredTiers, rungsBelow, tierFor } from '../src/main/youtube-ladder.ts'
import { describeQualityShortfall, normalizeYtDlpError } from '../src/main/youtube-error.ts'
import {
  advance,
  cookiesReadFrom,
  looksDowngraded,
  progressFor,
  verdictFor
} from '../src/main/cookie-report.ts'
import { halfSuffix } from '../src/main/engine/naming.ts'
import { videoIdOf, youtubeThumbnailUrl } from '../src/shared/youtube-link.ts'
import { parseFlatPlaylist } from '../src/main/youtube-playlist.ts'

/**
 * The 360p cap, and everything that exists because of it.
 *
 * YouTube withholds every format above 360p from a request it reads as signed
 * out, and `substituteVideo` will happily walk the whole ladder down to itag 18
 * rather than fail - so a 4K request became a 360p file still carrying a 4K
 * name, with one WARN line as the only trace. These are the pieces that make
 * that visible instead.
 */

describe('tierFor', () => {
  it('names an ordinary landscape frame after its height', () => {
    strictEqual(tierFor(1080, 1920), 1080)
    strictEqual(tierFor(720, 1280), 720)
    strictEqual(tierFor(360, 640), 360)
  })

  it('names a portrait frame after its short side, which is the width', () => {
    // A Short at 1080x1920 is 1080p in YouTube's own UI, not 4K.
    strictEqual(tierFor(1920, 1080), 1080)
    strictEqual(tierFor(1280, 720), 720)
  })

  it('does not demote letterboxed widescreen a rung', () => {
    /*
     * The reported bug. A 2.40:1 film is encoded with the bars cropped, so
     * YouTube's 1080p rendition is 1920x798 - and the old short-side rule read
     * that as 798, snapped it to 720p, and shifted the entire ladder down one.
     * The video was offered in 1080p and could only be taken at "720p".
     */
    strictEqual(tierFor(798, 1920), 1080)
    strictEqual(tierFor(532, 1280), 720)
    strictEqual(tierFor(266, 640), 360)
    strictEqual(tierFor(1600, 3840), 2160)
  })

  it('leaves 4:3 material named after its own height', () => {
    strictEqual(tierFor(480, 640), 480)
    strictEqual(tierFor(1080, 1440), 1080)
  })

  it('still snaps an odd height when no width is known', () => {
    strictEqual(tierFor(1072), 1080)
    strictEqual(tierFor(640), 720)
    strictEqual(tierFor(null), null)
    strictEqual(tierFor(0), null)
  })
})

describe('buildVariants on letterboxed video', () => {
  const formats = [
    { format_id: '137', url: 'https://cdn/v.mp4', height: 1080, width: 1918, fps: 24,
      vcodec: 'avc1', acodec: 'none', ext: 'mp4', protocol: 'https', tbr: 2824 },
    { format_id: '248', url: 'https://cdn/v.webm', height: 1080, width: 1918, fps: 24,
      vcodec: 'vp9', acodec: 'none', ext: 'webm', protocol: 'https', tbr: 1710 },
    { format_id: '616', url: 'https://cdn/premium.m3u8', height: 1080, width: 1918, fps: 24,
      vcodec: 'vp9', acodec: 'none', ext: 'mp4', protocol: 'm3u8_native', tbr: 3974, source_preference: 99 },
    { format_id: '140', url: 'https://cdn/a.m4a', vcodec: 'none', acodec: 'mp4a',
      ext: 'm4a', protocol: 'https', abr: 129 },
    { format_id: '251', url: 'https://cdn/a.webm', vcodec: 'none', acodec: 'opus',
      ext: 'webm', protocol: 'https', abr: 138 }
  ]

  it('selects enhanced HLS video and Opus instead of discarding them for H.264/AAC', () => {
    const [best] = buildVariants(formatsFromYtDlp(formats, true))
    strictEqual(best.youtube?.videoFormatId, '616')
    strictEqual(best.youtube?.audioFormatId, '251')
    strictEqual(best.url, 'https://cdn/premium.m3u8')
    strictEqual(best.container, 'mkv')
    strictEqual(best.estimatedSize, null)
  })

  it('does not compare the bitrates of different codecs as if they had the same efficiency', () => {
    const [best] = buildVariants(formatsFromYtDlp(formats))
    strictEqual(best.youtube?.videoFormatId, '248')
  })

  it('keeps playlist and file refreshes separate and refuses to silently downgrade HLS', () => {
    strictEqual(selectDirectYtFormat(formats, '616')?.format_id, '137')
    strictEqual(selectDirectYtFormat(formats, '616', { kind: 'video', delivery: 'hls' })?.format_id, '616')
    strictEqual(selectDirectYtFormat(formats.slice(0, 2), '616', { kind: 'video', delivery: 'hls' }), null)
  })

  it('offers 1080p for a 2.40:1 film rather than calling it 720p', () => {
    const audio = {
      id: '140', url: 'https://x/a', width: null, height: null, fps: null,
      bitrate: 128000, size: 1000, vcodec: null, acodec: 'mp4a.40.2', ext: 'm4a',
      hasVideo: false, hasAudio: true
    }
    const video = {
      id: '137', url: 'https://x/v', width: 1920, height: 798, fps: 24,
      bitrate: 4000000, size: 100000, vcodec: 'avc1', acodec: null, ext: 'mp4',
      hasVideo: true, hasAudio: false
    }

    const variants = buildVariants([audio, video])
    strictEqual(variants.length, 1)
    strictEqual(variants[0].label, '1080p')
  })

  it('preserves video-only / GIF formats without dropping them when no audio exists', () => {
    const gif = {
      id: 'gif-1', url: 'https://x/g.mp4', width: 640, height: 640, fps: 30,
      bitrate: 1000000, size: 50000, vcodec: 'avc1', acodec: null, ext: 'mp4',
      hasVideo: true, hasAudio: false
    }

    const variants = buildVariants([gif])
    strictEqual(variants.length, 1)
    strictEqual(variants[0].label, '720p')
    strictEqual(variants[0].audioUrl, null)
  })
})

describe('halfSuffix', () => {
  it('keeps two qualities of the same download apart on disk', () => {
    /*
     * The exact failure: a 2160p task (itag 313) retried after its audio half
     * failed, found the complete 360p half (itag 18) the substitution had left
     * behind under the shared name `… .v.mp4`, adopted it as finished and muxed
     * a 360p file called `… 2160p.mp4`. Different names, no collision.
     */
    strictEqual(halfSuffix('v', 'mp4', '313'), '.v.313.mp4')
    strictEqual(halfSuffix('v', 'mp4', '18'), '.v.18.mp4')
    strictEqual(halfSuffix('a', 'm4a', '140'), '.a.140.m4a')
  })

  it('keeps a multi-language audio itag intact, since those are real', () => {
    strictEqual(halfSuffix('a', 'm4a', '140-1'), '.a.140-1.m4a')
  })

  it('falls back to the original name when there is no format id', () => {
    // Nothing but YouTube substitutes formats, so nothing else needs the
    // discriminator - and this keeps every other merged download unchanged.
    strictEqual(halfSuffix('v', 'mp4', null), '.v.mp4')
    strictEqual(halfSuffix('v', 'mp4', undefined), '.v.mp4')
    strictEqual(halfSuffix('a', 'm4a', ''), '.a.m4a')
  })

  it('strips anything that would escape the filename', () => {
    strictEqual(halfSuffix('v', 'mp4', '../../evil'), '.v.evil.mp4')
    strictEqual(halfSuffix('v', 'mp4', 'a/b\\c:d'), '.v.abcd.mp4')
  })
})

describe('rungsBelow', () => {
  it('measures the drop that used to happen silently', () => {
    // The real case from the log: 2160p asked for, itag 18 delivered.
    strictEqual(rungsBelow(2160, 360), 5)
  })

  it('is zero for the same rung, and for a better one', () => {
    strictEqual(rungsBelow(1080, 1080), 0)
    strictEqual(rungsBelow(720, 1080), 0)
  })

  it('allows a single rung, which is where the two ladders genuinely disagree', () => {
    strictEqual(rungsBelow(1080, 720), 1)
  })

  it('snaps odd heights to their rung before comparing', () => {
    // 1072 is a 1080p frame from a non-16:9 source, not a rung of its own.
    strictEqual(rungsBelow(1080, 1072), 0)
  })

  it('claims no shortfall when a height is unknown, rather than guessing at one', () => {
    strictEqual(rungsBelow(null, 360), 0)
    strictEqual(rungsBelow(2160, null), 0)
  })
})

describe('offeredTiers', () => {
  it('lists the rungs the engine could actually fetch, highest first', () => {
    deepStrictEqual(
      offeredTiers([
        { url: 'https://x/1', height: 360, vcodec: 'avc1', protocol: 'https' },
        { url: 'https://x/2', height: 1080, vcodec: 'vp9', protocol: 'https' },
        { url: 'https://x/3', height: 720, vcodec: 'avc1', protocol: 'https' }
      ]),
      ['1080p', '720p', '360p']
    )
  })

  it('leaves out the HLS renditions, whose URL is a playlist rather than media', () => {
    // The whole point: web_safari answers with a 1080p m3u8 ladder that nothing
    // in the byte-range engine can download, and reporting it as on offer would
    // tell the user their session works when it does not.
    deepStrictEqual(
      offeredTiers([
        { url: 'https://x/a.m3u8', height: 1080, vcodec: 'avc1', protocol: 'm3u8_native' },
        { url: 'https://x/b', height: 360, vcodec: 'avc1', protocol: 'https' }
      ]),
      ['360p']
    )
  })

  it('leaves out audio-only formats, which have no rung', () => {
    deepStrictEqual(
      offeredTiers([{ url: 'https://x/a', vcodec: 'none', acodec: 'opus', protocol: 'https' }]),
      []
    )
  })
})

describe('describeQualityShortfall', () => {
  it('names the rung, what was on offer, the cause and the fix', () => {
    const message = describeQualityShortfall({
      wantedLabel: '4K',
      offeredLabels: ['360p'],
      cookieBrowser: 'none'
    })
    match(message, /4K/)
    match(message, /360p/)
    match(message, /Cause:/)
    match(message, /Options → Cookies/)
  })

  it('does not misdiagnose a limited browser lookup as signed out', () => {
    const message = describeQualityShortfall({
      wantedLabel: '1080p',
      offeredLabels: ['360p'],
      cookieBrowser: 'firefox'
    })
    match(message, /Options → Cookies/)
    match(message, /even when the browser is signed in/)
  })

  it('says so plainly when nothing at all was downloadable', () => {
    match(
      describeQualityShortfall({ wantedLabel: '720p', offeredLabels: [], cookieBrowser: 'none' }),
      /nothing it could download/
    )
  })
})

describe('normalizeYtDlpError', () => {
  it('rewrites the extractor KeyError into something actionable', () => {
    // Verbatim from the failing task: it sends the user to the yt-dlp issue
    // tracker for something that is not a yt-dlp bug.
    const raw =
      "ERROR: hKtwmkBVblM: An extractor error has occurred. (caused by KeyError('INNERTUBE_CONTEXT')); " +
      'please report this issue on  https://github.com/yt-dlp/yt-dlp/issues'
    const message = normalizeYtDlpError(raw, 'https://www.youtube.com/watch?v=hKtwmkBVblM')
    match(message, /Options → Cookies/)
    strictEqual(/report this issue/.test(message), false)
  })

  it('leaves a non-YouTube extractor error alone, having nothing to add', () => {
    const raw = 'ERROR: An extractor error has occurred.'
    strictEqual(normalizeYtDlpError(raw, 'https://example.com/video'), raw)
  })
})

describe('cookie check reporting', () => {
  it('prefers a public 4K ladder when valid browser cookies leave only 360p', () => {
    const result = verdictFor({
      browser: 'firefox', cookiesRead: 72, downgraded: true,
      heights: [360], anonymousHeights: [2160, 1440, 1080, 360]
    })
    strictEqual(result.ok, true)
    strictEqual(result.usedPublicFallback, true)
    strictEqual(result.bestQuality, '4K')
    match(result.cause!, /cookies were read/)
    strictEqual(/signed out/.test(result.cause!), false)
  })

  it('compares only URLs the file runner can fetch', () => {
    strictEqual(bestDirectVideoHeight([
      { url: 'https://example.com/manifest', protocol: 'm3u8_native', height: 2160, vcodec: 'avc1' },
      { url: 'https://example.com/file', protocol: 'https', height: 360, vcodec: 'avc1' }
    ]), 360)
  })

  it('reads the cookie count out of yt-dlp own commentary', () => {
    strictEqual(cookiesReadFrom(['Extracting cookies from firefox', 'Extracted 56 cookies from firefox']), 56)
    strictEqual(cookiesReadFrom(['[youtube] Extracting URL: https://x']), null)
  })

  it('recognises a downgraded player without treating it as proof of sign-out', () => {
    strictEqual(looksDowngraded(['[youtube] abc: Downloading tv downgraded player API JSON']), true)
    strictEqual(looksDowngraded(['[youtube] abc: Downloading tv player API JSON']), false)
  })

  it('turns the stage lines into progress, and ignores everything else', () => {
    strictEqual(progressFor('Extracted 56 cookies from firefox', 'firefox')?.percent, 35)
    strictEqual(progressFor('[youtube] abc: Downloading webpage', 'firefox')?.stage, 'contacting')
    strictEqual(progressFor('{"id": "abc"}', 'firefox'), null)
    strictEqual(progressFor('   ', 'firefox'), null)
  })

  it('never lets the bar run backwards', () => {
    const later = { stage: 'formats' as const, percent: 88, message: 'b' }
    const earlier = { stage: 'cookies' as const, percent: 15, message: 'a' }
    strictEqual(advance(later, earlier), later)
    strictEqual(advance(earlier, later), later)
  })

  it('calls a session working only when something above 360p came back', () => {
    const good = verdictFor({ browser: 'firefox', cookiesRead: 90, downgraded: false, heights: [1080, 720, 360] })
    strictEqual(good.ok, true)
    strictEqual(good.bestQuality, '1080p')
    strictEqual(good.cause, null)

    // The exact shape of the reported bug: cookies read fine, ladder still 360p.
    const capped = verdictFor({ browser: 'firefox', cookiesRead: 56, downgraded: true, heights: [360] })
    strictEqual(capped.ok, false)
    match(capped.cause!, /does not mean the browser is signed out/)
    match(capped.fix!, /public formats/)
  })

  it('separates "no cookies" from "cookies that YouTube would not accept"', () => {
    const none = verdictFor({ browser: 'chrome', cookiesRead: 0, downgraded: false, heights: [360] })
    match(none.cause!, /No cookies were read/)
  })

  it('explains a locked cookie database rather than repeating yt-dlp at the user', () => {
    const locked = verdictFor({
      browser: 'chrome',
      cookiesRead: null,
      downgraded: false,
      heights: [],
      error: 'ERROR: Could not copy Chrome cookie database. See  https://…'
    })
    strictEqual(locked.ok, false)
    match(locked.cause!, /holding its cookie database open/)
    match(locked.fix!, /Close chrome/)
  })
})

describe('thumbnails', () => {
  it('reads the video id out of every link shape', () => {
    strictEqual(videoIdOf('https://www.youtube.com/watch?v=hKtwmkBVblM'), 'hKtwmkBVblM')
    strictEqual(videoIdOf('https://youtu.be/hKtwmkBVblM'), 'hKtwmkBVblM')
    strictEqual(videoIdOf('https://www.youtube.com/shorts/hKtwmkBVblM'), 'hKtwmkBVblM')
    strictEqual(videoIdOf('hKtwmkBVblM'), 'hKtwmkBVblM')
  })

  it('refuses anything that is not an id, since it is pasted into a URL', () => {
    strictEqual(videoIdOf('https://www.youtube.com/playlist?list=PLabc'), null)
    strictEqual(videoIdOf('../../evil'), null)
    strictEqual(videoIdOf('hKtwmkBVblM/../../x'), null)
    strictEqual(videoIdOf(null), null)
  })

  it('builds hqdefault, which every video has, rather than maxres, which many do not', () => {
    strictEqual(
      youtubeThumbnailUrl('https://www.youtube.com/watch?v=hKtwmkBVblM'),
      'https://i.ytimg.com/vi/hKtwmkBVblM/hqdefault.jpg'
    )
    strictEqual(youtubeThumbnailUrl('https://example.com/x'), null)
  })
})

describe('parseFlatPlaylist thumbnails', () => {
  it('derives a poster from the entry id when the listing carries none', () => {
    const listing = parseFlatPlaylist({ title: 'Raps', entries: [{ id: 'hKtwmkBVblM', title: 'One' }] })
    strictEqual(listing.entries[0].thumbnailUrl, 'https://i.ytimg.com/vi/hKtwmkBVblM/hqdefault.jpg')
  })

  it('prefers the largest thumbnail the listing gave, which is the last one', () => {
    const listing = parseFlatPlaylist({
      entries: [
        {
          id: 'hKtwmkBVblM',
          title: 'One',
          thumbnails: [{ url: 'https://i.ytimg.com/small.jpg' }, { url: 'https://i.ytimg.com/big.jpg' }]
        }
      ]
    })
    strictEqual(listing.entries[0].thumbnailUrl, 'https://i.ytimg.com/big.jpg')
  })

  it('ignores a plaintext thumbnail, which main would then fetch over http', () => {
    const listing = parseFlatPlaylist({
      entries: [{ id: 'hKtwmkBVblM', title: 'One', thumbnails: [{ url: 'http://insecure/x.jpg' }] }]
    })
    strictEqual(listing.entries[0].thumbnailUrl, 'https://i.ytimg.com/vi/hKtwmkBVblM/hqdefault.jpg')
  })

  it('leaves an entry with no id and no thumbnail without one', () => {
    const listing = parseFlatPlaylist({
      entries: [{ url: 'https://vimeo.com/12345', title: 'Elsewhere' }]
    })
    strictEqual(listing.entries[0].thumbnailUrl, null)
  })
})
