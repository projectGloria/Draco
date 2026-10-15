import { strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { connectionsForUrl } from '../src/main/engine/network-rules.ts'
import { isEmptyRangeResponse } from '../src/main/engine/probe-helpers.ts'
import { compareVersions } from '../src/main/update-version.ts'
import { couldBeHtmlPageUrl, isSunoUrl, isSupportedMediaPageUrl } from '../src/main/media-url.ts'
import { isSupportedYouTubeUrl, preparedYouTubeUrl, youtubeFormatId } from '../src/main/youtube-url.ts'
import { isPrivateHost, validateUrl } from '../src/main/engine/create.ts'
import { isXPage, xPostUrl, xStatusId } from '../src/shared/x-post.ts'
import { tokenForTweet } from '../src/main/twitter.ts'

/** The small decisions that sit on the edge of the engine. */

describe('connectionsForUrl', () => {
  const rules = [
    { host: 'example.com', connections: 4 },
    { host: 'cdn.example.com', connections: 2 },
    { host: 'other.test', connections: 8 }
  ]

  it('falls back when no rule matches', () => {
    strictEqual(connectionsForUrl('https://nobody.test/f.bin', 16, rules), 16)
    strictEqual(connectionsForUrl('https://example.com/f.bin', 16, []), 16)
  })

  it('applies a rule to the host and to its subdomains', () => {
    strictEqual(connectionsForUrl('https://example.com/f.bin', 16, rules), 4)
    strictEqual(connectionsForUrl('https://files.example.com/f.bin', 16, rules), 4)
  })

  it('prefers the most specific rule', () => {
    strictEqual(connectionsForUrl('https://cdn.example.com/f.bin', 16, rules), 2)
  })

  it('does not match a host that merely ends in the same letters', () => {
    strictEqual(connectionsForUrl('https://notexample.com/f.bin', 16, rules), 16)
  })

  it('is case-insensitive about hostnames', () => {
    strictEqual(connectionsForUrl('https://CDN.Example.COM/f.bin', 16, rules), 2)
  })

  it('never raises the budget above the global one, and never drops below one', () => {
    strictEqual(connectionsForUrl('https://other.test/f.bin', 4, rules), 4, 'a rule is a ceiling, not a licence')
    strictEqual(connectionsForUrl('https://x.test/f.bin', 16, [{ host: 'x.test', connections: 0 }]), 1)
  })

  it('falls back on a URL it cannot parse', () => {
    strictEqual(connectionsForUrl('not a url', 16, rules), 16)
  })
})

describe('isEmptyRangeResponse', () => {
  it('recognises the one 416 that means the file is empty, not that we asked wrongly', () => {
    strictEqual(isEmptyRangeResponse(416, 'bytes */0'), true)
    strictEqual(isEmptyRangeResponse(416, 'bytes */1000'), false)
    strictEqual(isEmptyRangeResponse(416, null), false)
    strictEqual(isEmptyRangeResponse(206, 'bytes */0'), false)
  })
})

describe('compareVersions', () => {
  it('orders releases numerically, not as text', () => {
    strictEqual(compareVersions('0.10.0', '0.9.0'), 1, '10 is after 9')
    strictEqual(compareVersions('1.0.0', '1.0.0'), 0)
    strictEqual(compareVersions('1.2.3', '1.2.4'), -1)
    strictEqual(compareVersions('2.0.0', '1.99.99'), 1)
  })

  it('treats missing parts as zero and ignores build metadata', () => {
    strictEqual(compareVersions('1.2', '1.2.0'), 0)
    strictEqual(compareVersions('1.2.3-beta.1', '1.2.3'), -1, 'a pre-release comes before the stable release')
    strictEqual(compareVersions('1.2.3+build9', '1.2.3'), 0)
  })

  it('orders prerelease identifiers using semantic version precedence', () => {
    strictEqual(compareVersions('1.2.3', '1.2.3-beta.9'), 1)
    strictEqual(compareVersions('1.2.3-beta.10', '1.2.3-beta.9'), 1)
    strictEqual(compareVersions('1.2.3-alpha', '1.2.3-beta'), -1)
    strictEqual(compareVersions('1.2.3-beta', '1.2.3-beta.1'), -1)
    strictEqual(compareVersions('1.2.3-1', '1.2.3-alpha'), -1)
  })
})

describe('media page URLs', () => {
  it('resolves only one X status, never a feed or unrelated status link', () => {
    strictEqual(xPostUrl('https://x.com/alice/status/12345?source=home'), 'https://x.com/alice/status/12345')
    strictEqual(xPostUrl('https://mobile.twitter.com/bob/status/67890/video/1'), 'https://x.com/bob/status/67890')
    strictEqual(xPostUrl('https://x.com/i/web/status/1234567890'), 'https://x.com/i/status/1234567890')
    strictEqual(xPostUrl('https://vxtwitter.com/jack/status/20'), 'https://x.com/jack/status/20')
    strictEqual(xPostUrl('https://fixupx.com/jack/status/20'), 'https://x.com/jack/status/20')
    strictEqual(xStatusId('https://x.com/alice/status/12345'), '12345')
    strictEqual(xStatusId('https://x.com/i/web/status/1891234567890'), '1891234567890')
    strictEqual(tokenForTweet('20').length > 0, true)
    strictEqual(xPostUrl('https://x.com/home'), null)
    strictEqual(xPostUrl('https://notx.com/alice/status/12345'), null)
    strictEqual(isXPage('https://x.com/home'), true)
    strictEqual(isSupportedMediaPageUrl('https://x.com/alice/status/12345'), true)
    strictEqual(isSupportedMediaPageUrl('https://x.com/home'), false)
  })
  it('accepts only pages that could hold a video', () => {
    strictEqual(couldBeHtmlPageUrl('https://example.test/watch/123'), true)
    strictEqual(couldBeHtmlPageUrl('https://example.test/clip.mp4'), false, 'that is the media itself')
    strictEqual(couldBeHtmlPageUrl('ftp://example.test/page'), false)
    strictEqual(couldBeHtmlPageUrl(42), false)
  })

  it('sends a SoundCloud track through yt-dlp, but not a browsing page', () => {
    strictEqual(isSupportedMediaPageUrl('https://soundcloud.com/artist/track'), true)
    strictEqual(isSupportedMediaPageUrl('https://m.soundcloud.com/artist/track'), true)
    strictEqual(isSupportedMediaPageUrl('https://soundcloud.com/artist'), false, 'a profile is not a track')
    strictEqual(isSupportedMediaPageUrl('https://soundcloud.com/discover/sets'), false)
    strictEqual(isSupportedMediaPageUrl('https://soundcloud.com/search/x'), false)
  })

  it('recognises a Suno song page on either domain', () => {
    strictEqual(isSupportedMediaPageUrl('https://suno.com/song/abc123'), true)
    strictEqual(isSupportedMediaPageUrl('https://suno.ai/s/abc123'), true)
    strictEqual(isSunoUrl('https://suno.com/song/abc123'), true)
    strictEqual(isSupportedMediaPageUrl('https://suno.com/create'), false)
  })

  it('claims nothing else', () => {
    strictEqual(isSupportedMediaPageUrl('https://example.test/p/abc/'), false)
    strictEqual(isSupportedMediaPageUrl('http://soundcloud.com/artist/track'), false, 'http is not accepted')
    strictEqual(isSupportedMediaPageUrl('https://soundcloud.com.evil.test/a/b'), false)
    strictEqual(isSupportedMediaPageUrl(null), false)
  })
})

describe('YouTube URLs', () => {
  it('accepts the youtube hosts over https and nothing else', () => {
    strictEqual(isSupportedYouTubeUrl('https://www.youtube.com/watch?v=abc'), true)
    strictEqual(isSupportedYouTubeUrl('https://music.youtube.com/watch?v=abc'), true)
    strictEqual(isSupportedYouTubeUrl('https://youtu.be/abc'), true)
    strictEqual(isSupportedYouTubeUrl('http://www.youtube.com/watch?v=abc'), false, 'http is not accepted')
    strictEqual(isSupportedYouTubeUrl('https://notyoutube.com/watch?v=abc'), false)
    strictEqual(isSupportedYouTubeUrl('https://youtube.com.evil.test/watch?v=abc'), false)
  })

  it('accepts a prepared media URL only from the media CDN, and only for the itag asked for', () => {
    const good = 'https://rr3---sn-x.googlevideo.com/videoplayback?itag=137&expire=1'
    strictEqual(preparedYouTubeUrl(good, 137), good)
    strictEqual(preparedYouTubeUrl(good, 140), null, 'a different format than the page described')
    strictEqual(preparedYouTubeUrl('https://evil.test/videoplayback?itag=137', 137), null)
    strictEqual(preparedYouTubeUrl('https://rr3.googlevideo.com/redirect?itag=137', 137), null)
    strictEqual(preparedYouTubeUrl('http://rr3.googlevideo.com/videoplayback?itag=137', 137), null)
    strictEqual(preparedYouTubeUrl('', 137), null)
  })

  it('resolves the format id from the half of the download that is asking', () => {
    // Reading videoFormatId unconditionally made both halves of a merged
    // download fetch the video stream, and the mux then had no audio track.
    const merged = { videoFormatId: '137', audioFormatId: '140' }
    strictEqual(youtubeFormatId({ ...merged, role: 'video' }), '137')
    strictEqual(youtubeFormatId({ ...merged, role: 'audio' }), '140')
    strictEqual(youtubeFormatId({ videoFormatId: '251', role: 'audio' }), '251', 'an audio-only download carries its format in the primary slot')
    strictEqual(youtubeFormatId(merged), '137', 'no role means the primary stream')
  })
})

describe('isPrivateHost', () => {
  it('blocks localhost, .localhost, and .local', () => {
    strictEqual(isPrivateHost('localhost'), true)
    strictEqual(isPrivateHost('sub.localhost'), true)
    strictEqual(isPrivateHost('nas.local'), true)
  })

  it('blocks IPv4 loopback, private, and link-local ranges', () => {
    strictEqual(isPrivateHost('127.0.0.1'), true)
    strictEqual(isPrivateHost('10.0.0.1'), true)
    strictEqual(isPrivateHost('172.16.0.1'), true)
    strictEqual(isPrivateHost('172.31.255.255'), true)
    strictEqual(isPrivateHost('192.168.1.1'), true)
    strictEqual(isPrivateHost('169.254.169.254'), true)
  })

  it('blocks IPv6 loopback, unique-local, and link-local', () => {
    strictEqual(isPrivateHost('::1'), true)
    strictEqual(isPrivateHost('fc00::1'), true)
    strictEqual(isPrivateHost('fe80::1'), true)
  })

  it('blocks IPv4-mapped IPv6 in both hex and dotted forms', () => {
    strictEqual(isPrivateHost('::ffff:c0a8:101'), true)
    strictEqual(isPrivateHost('::ffff:192.168.1.1'), true)
    strictEqual(isPrivateHost('::ffff:a9fe:a9fe'), true)
  })

  it('allows public hosts', () => {
    strictEqual(isPrivateHost('example.com'), false)
    strictEqual(isPrivateHost('8.8.8.8'), false)
    strictEqual(isPrivateHost('1.1.1.1'), false)
  })
})

describe('validateUrl SSRF guard', () => {
  it('allows private hosts when allowPrivate is default or true', () => {
    strictEqual(validateUrl('http://192.168.1.1/video.mp4'), 'http://192.168.1.1/video.mp4')
    strictEqual(validateUrl('http://192.168.1.1/video.mp4', { allowPrivate: true }), 'http://192.168.1.1/video.mp4')
  })

  it('rejects private hosts when allowPrivate is false', () => {
    let threw = false
    try {
      validateUrl('http://192.168.1.1/video.mp4', { allowPrivate: false })
    } catch {
      threw = true
    }
    strictEqual(threw, true)
  })
})
