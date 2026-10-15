import { ok, strictEqual, throws } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateUrl } from '../src/main/engine/create.ts'
import {
  MAX_PLAYLIST_ENTRIES,
  isPlaylistUrl,
  normalizeLinkInput,
  parseFlatPlaylist,
  playlistIdOf,
  singleVideoUrl
} from '../src/main/youtube-playlist.ts'
import { cookieArgs, explainCookieFailure, isCookieBrowser } from '../src/main/ytdlp-cookies.ts'

describe('isPlaylistUrl', () => {
  it('recognises a playlist link', () => {
    strictEqual(isPlaylistUrl('https://www.youtube.com/playlist?list=PL1234567890'), true)
  })

  it('treats a watch link carrying a list as the playlist the user pasted', () => {
    strictEqual(isPlaylistUrl('https://www.youtube.com/watch?v=abc123&list=PLxyz'), true)
  })

  it('refuses an endless mix, which has no last entry', () => {
    // RD lists are generated as you watch, so "download all of it" means nothing.
    strictEqual(isPlaylistUrl('https://www.youtube.com/watch?v=abc&list=RDabc'), false)
  })

  it('accepts the finite prefixes that used to be lumped in with mixes', () => {
    // `UL` is a legacy uploads listing and `TL` a queue; both have a last entry
    // and were being refused only because they sat in the same regex as `RD`.
    strictEqual(isPlaylistUrl('https://www.youtube.com/watch?v=abc&list=ULabc'), true)
    strictEqual(isPlaylistUrl('https://www.youtube.com/watch?v=abc&list=TLabc'), true)
  })

  it('recognises the channel forms', () => {
    for (const url of [
      'https://www.youtube.com/@someone',
      'https://www.youtube.com/@someone/videos',
      'https://www.youtube.com/@someone/shorts',
      'https://www.youtube.com/channel/UC1234567890',
      'https://www.youtube.com/c/SomeName/videos',
      'https://www.youtube.com/user/SomeName'
    ]) {
      strictEqual(isPlaylistUrl(url), true, url)
    }
  })

  it('leaves a plain video alone', () => {
    strictEqual(isPlaylistUrl('https://www.youtube.com/watch?v=abc123'), false)
    strictEqual(isPlaylistUrl('https://youtu.be/abc123'), false)
    strictEqual(isPlaylistUrl('https://www.youtube.com/@someone/community'), false)
  })

  it('claims nothing that is not YouTube', () => {
    strictEqual(isPlaylistUrl('https://example.test/playlist?list=PL1'), false)
    strictEqual(isPlaylistUrl('http://www.youtube.com/playlist?list=PL1'), false, 'http is not accepted')
    strictEqual(isPlaylistUrl('https://youtube.com.evil.test/playlist?list=PL1'), false)
    strictEqual(isPlaylistUrl(null), false)
  })
})

describe('playlistIdOf', () => {
  it('is the list id, or nothing', () => {
    strictEqual(playlistIdOf('https://www.youtube.com/watch?v=a&list=PLabc'), 'PLabc')
    strictEqual(playlistIdOf('https://www.youtube.com/watch?v=a'), null)
    strictEqual(playlistIdOf('https://www.youtube.com/watch?v=a&list=RDabc'), null)
  })
})

describe('singleVideoUrl', () => {
  it('offers the one video the same link could have meant', () => {
    strictEqual(
      singleVideoUrl('https://www.youtube.com/watch?v=abc123&list=PLxyz&index=4'),
      'https://www.youtube.com/watch?v=abc123'
    )
  })

  it('has nothing to offer for a link that names no video', () => {
    strictEqual(singleVideoUrl('https://www.youtube.com/playlist?list=PLxyz'), null)
    strictEqual(singleVideoUrl('https://www.youtube.com/@someone'), null)
  })
})

describe('parseFlatPlaylist', () => {
  it('builds a watch URL per entry from its id', () => {
    const listing = parseFlatPlaylist({
      title: 'My Playlist',
      entries: [
        { id: 'aaaaaaaaaaa', title: 'First', duration: 61.5 },
        { id: 'bbbbbbbbbbb', title: 'Second', duration: null }
      ]
    })

    strictEqual(listing.title, 'My Playlist')
    strictEqual(listing.entries.length, 2)
    strictEqual(listing.entries[0].url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa')
    strictEqual(listing.entries[0].title, 'First')
    strictEqual(listing.entries[0].duration, 62, 'rounded to whole seconds')
    strictEqual(listing.entries[1].duration, null)
  })

  it('prefers the id over the entry URL, which can carry the playlist along', () => {
    const listing = parseFlatPlaylist({
      entries: [{ id: 'aaaaaaaaaaa', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PLx' }]
    })
    strictEqual(listing.entries[0].url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa')
  })

  it('keeps a full URL from an extractor that gives no usable id', () => {
    const listing = parseFlatPlaylist({
      entries: [{ url: 'https://other.test/video/1', title: 'Elsewhere' }]
    })
    strictEqual(listing.entries[0].url, 'https://other.test/video/1')
  })

  it('drops entries with nothing to download - a deleted or private video', () => {
    const listing = parseFlatPlaylist({
      entries: [
        { id: 'aaaaaaaaaaa', title: 'Fine' },
        { title: '[Deleted video]' },
        null,
        'nonsense',
        { id: '', url: '' }
      ]
    })
    strictEqual(listing.entries.length, 1)
  })

  it('names an untitled entry rather than dropping it', () => {
    strictEqual(parseFlatPlaylist({ entries: [{ id: 'aaaaaaaaaaa' }] }).entries[0].title, 'Untitled')
  })

  it('caps a channel that lists thousands, and says that it did', () => {
    const entries = Array.from({ length: MAX_PLAYLIST_ENTRIES + 25 }, (_, index) => ({
      id: `v${String(index).padStart(9, '0')}`,
      title: `Video ${index}`
    }))

    const listing = parseFlatPlaylist({ title: 'Everything', entries })
    strictEqual(listing.entries.length, MAX_PLAYLIST_ENTRIES)
    strictEqual(listing.truncated, true)
  })

  it('survives junk where a listing was expected', () => {
    strictEqual(parseFlatPlaylist(null).entries.length, 0)
    strictEqual(parseFlatPlaylist({ entries: 'no' }).entries.length, 0)
    strictEqual(parseFlatPlaylist({}).title, 'Playlist', 'an unnamed listing still has a name')
  })

  it('does not call a listing truncated because some of it was unusable', () => {
    // A deleted video is skipped, not cut off. Comparing the two lengths made
    // any playlist containing one claim it had run past the cap.
    const listing = parseFlatPlaylist({
      entries: [
        { id: 'aaaaaaaaaaa', title: 'Fine' },
        { title: '[Deleted video]' },
        { id: 'bbbbbbbbbbb', title: 'Also fine' }
      ]
    })
    strictEqual(listing.entries.length, 2)
    strictEqual(listing.truncated, false)
  })

  it('walks into a channel listing, which is a playlist of tabs', () => {
    /*
     * `youtube.com/@someone` with no `/videos` on the end answers with one
     * entry per channel tab, each a playlist of its own. Reading those as
     * videos offered three tab pages for download, and all three then failed.
     */
    const listing = parseFlatPlaylist({
      title: 'Someone',
      entries: [
        {
          _type: 'playlist',
          id: 'UUaaaaaaaaaaaaaaaaaaaaaa',
          title: 'Videos',
          url: 'https://www.youtube.com/@someone/videos',
          entries: [
            { id: 'aaaaaaaaaaa', title: 'First' },
            { id: 'bbbbbbbbbbb', title: 'Second' }
          ]
        },
        {
          _type: 'playlist',
          id: 'UUbbbbbbbbbbbbbbbbbbbbbb',
          title: 'Shorts',
          url: 'https://www.youtube.com/@someone/shorts',
          entries: [{ id: 'ccccccccccc', title: 'Third' }]
        }
      ]
    })

    strictEqual(listing.entries.length, 3)
    strictEqual(listing.entries[0].url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa')
    strictEqual(listing.entries[2].url, 'https://www.youtube.com/watch?v=ccccccccccc')
  })

  it('refuses a channel tab that yt-dlp did not expand', () => {
    // Nothing downloadable in it, and offering it produced an entry that could
    // only ever fail - looking identical to a real one in the dialog.
    const listing = parseFlatPlaylist({
      entries: [
        { _type: 'playlist', id: 'UUaaaaaaaaaaaaaaaaaaaaaa', url: 'https://www.youtube.com/@someone/videos' },
        { url: 'https://www.youtube.com/@someone/streams', title: 'Live' }
      ]
    })
    strictEqual(listing.entries.length, 0)
  })
})

describe('normalizeLinkInput', () => {
  it('adds the scheme a pasted address left off', () => {
    // What copying from an address bar frequently gives you. Without this it
    // failed `new URL()` and never reached the playlist check at all.
    strictEqual(
      normalizeLinkInput('youtube.com/playlist?list=PLx'),
      'https://youtube.com/playlist?list=PLx'
    )
    strictEqual(isPlaylistUrl('www.youtube.com/playlist?list=PLx'), true)
  })

  it('leaves anything that already names a protocol exactly as it was', () => {
    strictEqual(normalizeLinkInput('magnet:?xt=urn:btih:abc'), 'magnet:?xt=urn:btih:abc')
    strictEqual(normalizeLinkInput('http://example.test/a'), 'http://example.test/a')
    // An explicit downgrade is refused rather than quietly upgraded.
    strictEqual(isPlaylistUrl('http://www.youtube.com/playlist?list=PL1'), false)
  })

  it('does not turn a phrase, a path or a filename into a URL', () => {
    strictEqual(normalizeLinkInput('C:\\Users\\me\\file.iso'), 'C:\\Users\\me\\file.iso')
    strictEqual(normalizeLinkInput('some words'), null)
    strictEqual(normalizeLinkInput('notaurl'), 'notaurl')
    // A bare dotted name is indistinguishable from a bare hostname, so it is
    // left alone and fails as "not a URL" rather than becoming a request.
    strictEqual(normalizeLinkInput('file.iso'), 'file.iso')
  })

  it('still refuses a private address it was asked to normalise', () => {
    // The scheme prefix must not become a way around the boundary that keeps a
    // web page from aiming Draco at the router with the browser's cookies.
    throws(() => validateUrl('192.168.1.1/admin', { allowPrivate: false }))
    throws(() => validateUrl('10.0.0.1/x', { allowPrivate: false }))
    strictEqual(
      validateUrl('192.168.1.1/admin'),
      'https://192.168.1.1/admin',
      'the user asking for it themselves is still allowed'
    )
  })
})

describe('cookieArgs', () => {
  it('names the browser yt-dlp should read', () => {
    strictEqual(cookieArgs('chrome').join(' '), '--cookies-from-browser chrome')
    strictEqual(cookieArgs('firefox').join(' '), '--cookies-from-browser firefox')
  })

  it('sends nothing for none, and nothing for anything unrecognised', () => {
    // The value becomes a command-line argument, so an unknown one must produce
    // no argument at all rather than a best effort.
    strictEqual(cookieArgs('none').length, 0)
    strictEqual(cookieArgs('safari; rm -rf /').length, 0)
    strictEqual(cookieArgs('--exec').length, 0)
    strictEqual(cookieArgs(undefined).length, 0)
    strictEqual(cookieArgs({ browser: 'chrome' }).length, 0)
  })

  it('agrees with its own type guard', () => {
    strictEqual(isCookieBrowser('brave'), true)
    strictEqual(isCookieBrowser('netscape'), false)
  })
})

describe('explainCookieFailure', () => {
  it('recognises the locked-database case, which is the common one on Windows', () => {
    const message = explainCookieFailure('ERROR: Could not copy Chrome cookie database', 'chrome')
    ok(message?.includes('Close chrome'), message ?? 'no message')
  })

  it('recognises a profile whose cookies cannot be decrypted', () => {
    ok(explainCookieFailure('failed to decrypt with DPAPI', 'edge')?.includes('decrypt'))
  })

  it('stays quiet about failures that have nothing to do with cookies', () => {
    strictEqual(explainCookieFailure('ERROR: Video unavailable', 'chrome'), null)
    strictEqual(explainCookieFailure('could not copy anything', 'none'), null, 'nothing was borrowed')
  })
})
