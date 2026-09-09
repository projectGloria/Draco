import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isKhinsiderUrl, parseAlbumPage, parseTrackPage } from '../src/main/khinsider.ts'

const ALBUM_URL = 'https://downloads.khinsider.com/game-soundtracks/album/example-score'

const ALBUM_HTML = `
<h2>Example Score</h2>
<div class="albumImage">
  <a href="https://cdn.example.com/soundtracks/example-score/00%20Front.jpg" target="_blank">
    <img src="https://cdn.example.com/soundtracks/example-score/thumbs/00%20Front.jpg">
  </a>
</div>
<table id="songlist">
  <tr id="songlist_header"><th><b>MP3</b></th><th><b>FLAC</b></th></tr>
  <tr>
    <td><a href="/game-soundtracks/album/example-score/01.%2520Main%2520Theme.mp3">Main Theme</a></td>
    <td><a href="/game-soundtracks/album/example-score/01.%2520Main%2520Theme.mp3">4:02</a></td>
  </tr>
  <tr>
    <td><a href="/game-soundtracks/album/example-score/02.%2520Prologue.mp3">Prologue</a></td>
  </tr>
</table>
<p><a href="/game-soundtracks/album/example-score/change_log">Change log</a></p>
<p><a href="/game-soundtracks/album/other-album">Other album</a></p>
<div class="albumListImage"><img src="https://cdn.example.com/soundtracks/other-album/thumbs/Front.jpg"></div>
`

const TRACK_HTML = `
<h2>Example Score (2010)</h2>
<p align="left">Album name: <b>Example Score (2010)</b><br>Song name: <b>Main Theme</b></p>
<p><a href="https://cdn.example.com/soundtracks/example-score/abc123/01.%20Main%20Theme.mp3"><span class="songDownloadLink">Click here to download as MP3</span></a></b> (7.55 MB)</p>
<p><a href="https://cdn.example.com/soundtracks/example-score/abc123/01.%20Main%20Theme.flac"><span class="songDownloadLink">Click here to download as FLAC</span></a></b> (21.43 MB)</p>
<audio id="audio" src="https://cdn.example.com/soundtracks/example-score/abc123/01.%20Main%20Theme.mp3"></audio>
<p>Go back to the album - <a href="/game-soundtracks/album/example-score">Example Score</a></p>
`

describe('isKhinsiderUrl', () => {
  it('accepts album and track pages on any khinsider host', () => {
    ok(isKhinsiderUrl(ALBUM_URL))
    ok(isKhinsiderUrl('https://www.khinsider.com/game-soundtracks/album/example-score/01.%20Theme.mp3'))
  })

  it('rejects other pages and other sites', () => {
    strictEqual(isKhinsiderUrl('https://downloads.khinsider.com/game-soundtracks/browse/M'), false)
    strictEqual(isKhinsiderUrl('https://notkhinsider.com/game-soundtracks/album/example-score'), false)
    strictEqual(isKhinsiderUrl(null), false)
  })
})

describe('parseAlbumPage', () => {
  const album = parseAlbumPage(ALBUM_HTML, ALBUM_URL)

  it('lists every track page once, in album order', () => {
    deepStrictEqual(album.trackUrls, [
      `${ALBUM_URL}/01.%2520Main%2520Theme.mp3`,
      `${ALBUM_URL}/02.%2520Prologue.mp3`
    ])
  })

  it('leaves the album sub-pages and neighbouring albums out', () => {
    ok(!album.trackUrls.some((url) => url.includes('change_log') || url.includes('other-album')))
  })

  it('takes the full-size artwork the thumbnail links to, not the thumbnail', () => {
    deepStrictEqual(album.images, [{
      url: 'https://cdn.example.com/soundtracks/example-score/00%20Front.jpg',
      thumbnailUrl: 'https://cdn.example.com/soundtracks/example-score/thumbs/00%20Front.jpg'
    }])
  })

  it('reads the album name from the heading', () => {
    strictEqual(album.title, 'Example Score')
  })
})

describe('parseTrackPage', () => {
  const track = parseTrackPage(TRACK_HTML, `${ALBUM_URL}/01.%2520Main%2520Theme.mp3`)

  it('finds every published format, lossless first', () => {
    deepStrictEqual(track.files.map((file) => file.format), ['flac', 'mp3'])
  })

  it('keeps the printed file sizes', () => {
    deepStrictEqual(track.files.map((file) => file.size), [
      Math.round(21.43 * 1024 ** 2),
      Math.round(7.55 * 1024 ** 2)
    ])
  })

  it('never mistakes the album page for a media file', () => {
    ok(track.files.every((file) => !file.url.includes('khinsider.com')))
  })

  it('names the track from the page rather than the URL', () => {
    strictEqual(track.title, 'Main Theme')
  })
})
