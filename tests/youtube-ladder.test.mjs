import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAudioVariants,
  buildVariants,
  formatsFromPage,
  formatsFromYtDlp,
  selectDirectYtFormat,
  tierFor,
  tierLabel
} from '../src/main/youtube-ladder.ts'

const URL_ = 'https://rr1.googlevideo.com/videoplayback?x=1'

function video(id, height, opts = {}) {
  return {
    format_id: id,
    url: URL_,
    height,
    fps: opts.fps ?? 30,
    vbr: opts.vbr ?? 1000,
    ext: opts.ext ?? 'mp4',
    vcodec: opts.vcodec ?? 'avc1.640028',
    acodec: 'none',
    filesize: opts.filesize ?? null
  }
}

function audio(id, opts = {}) {
  return {
    format_id: id,
    url: URL_,
    ext: opts.ext ?? 'm4a',
    vcodec: 'none',
    acodec: opts.acodec ?? 'mp4a.40.2',
    abr: opts.abr ?? 128,
    filesize: opts.filesize ?? null,
    language: opts.language ?? null,
    language_preference: opts.language_preference ?? null,
    format_note: opts.format_note ?? null
  }
}

test('a frame is snapped onto the nearest standard rung', () => {
  assert.equal(tierFor(2160), 2160)
  assert.equal(tierFor(1080), 1080)
  assert.equal(tierFor(1440), 1440)
  // Non-16:9 sources produce heights a little off the rung they belong to.
  assert.equal(tierFor(1072), 1080)
  assert.equal(tierFor(640), 720)
  assert.equal(tierFor(406), 360)
  assert.equal(tierFor(0), null)
  assert.equal(tierFor(null), null)
})

test('quality is measured on the short side, as YouTube measures it', () => {
  // A Short is 1080p in YouTube's own UI despite being 1920 pixels tall.
  assert.equal(tierFor(1920, 1080), 1080)
  assert.equal(tierFor(1280, 720), 720)
  // Landscape is unaffected: there the short side is the height.
  assert.equal(tierFor(1080, 1920), 1080)
  assert.equal(tierFor(2160, 3840), 2160)
})

test('a vertical video is offered as the quality it actually is', () => {
  const variants = buildVariants(
    formatsFromPage([
      { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 4000000, width: 1080, height: 1920, fps: 30, contentLength: null },
      { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, width: null, height: null, fps: null, contentLength: null }
    ])
  )

  assert.deepEqual(variants.map((v) => v.label), ['1080p'])
})

test('the top rungs are named the way people ask for them', () => {
  assert.equal(tierLabel(4320, 30), '8K')
  assert.equal(tierLabel(2160, 30), '4K')
  assert.equal(tierLabel(1440, 30), '2K')
  assert.equal(tierLabel(1080, 30), '1080p')
  // Only a high frame rate earns a suffix; 30fps is unremarkable.
  assert.equal(tierLabel(1080, 60), '1080p60')
  assert.equal(tierLabel(2160, 60), '4K60')
})

test('each quality appears once, as the best copy of that quality', () => {
  // What YouTube actually serves: the same 1080p in three containers.
  const variants = buildVariants(
    formatsFromYtDlp([
      video('137', 1080, { vbr: 4000, ext: 'mp4', vcodec: 'avc1.640028' }),
      video('248', 1080, { vbr: 4500, ext: 'webm', vcodec: 'vp9' }),
      video('399', 1080, { vbr: 3800, ext: 'mp4', vcodec: 'av01.0.08M.08' }),
      video('136', 720, { vbr: 2000 }),
      audio('140', { abr: 128 })
    ])
  )

  assert.deepEqual(
    variants.map((v) => v.label),
    ['1080p', '720p']
  )
  // The highest bitrate at that rung wins, whatever container it arrives in.
  assert.equal(variants[0].youtube.videoFormatId, '248')
})

test('the ladder is ordered high to low', () => {
  const variants = buildVariants(
    formatsFromYtDlp([
      video('136', 720),
      video('313', 2160, { vbr: 20000 }),
      video('271', 1440, { vbr: 9000 }),
      video('137', 1080, { vbr: 4000 }),
      audio('140')
    ])
  )

  assert.deepEqual(
    variants.map((v) => v.label),
    ['4K', '2K', '1080p', '720p']
  )
})

test('video-only formats are paired with the best audio, preferring AAC', () => {
  const variants = buildVariants(
    formatsFromYtDlp([
      video('137', 1080),
      // Opus is the higher bitrate, but AAC is what muxes into an .mp4 without
      // argument, so it is the one that should be chosen.
      audio('251', { ext: 'webm', acodec: 'opus', abr: 160 }),
      audio('140', { ext: 'm4a', acodec: 'mp4a.40.2', abr: 128 })
    ])
  )

  assert.equal(variants.length, 1)
  assert.equal(variants[0].youtube.audioFormatId, '140')
  assert.equal(variants[0].audioUrl, URL_)
})

test('the best available audio is used when there is no AAC at all', () => {
  const variants = buildVariants(
    formatsFromYtDlp([
      video('137', 1080),
      audio('249', { ext: 'webm', acodec: 'opus', abr: 50 }),
      audio('251', { ext: 'webm', acodec: 'opus', abr: 160 })
    ])
  )

  assert.equal(variants[0].youtube.audioFormatId, '251')
})

test('a video-only format is dropped when nothing can supply its audio', () => {
  const variants = buildVariants(formatsFromYtDlp([video('137', 1080)]))
  assert.deepEqual(variants, [])
})

test('a progressive format needs no audio pairing', () => {
  const variants = buildVariants(
    formatsFromYtDlp([
      {
        format_id: '18',
        url: URL_,
        height: 360,
        fps: 30,
        tbr: 700,
        ext: 'mp4',
        vcodec: 'avc1.42001E',
        acodec: 'mp4a.40.2'
      }
    ])
  )

  assert.equal(variants.length, 1)
  assert.equal(variants[0].label, '360p')
  assert.equal(variants[0].audioUrl, null)
  assert.equal(variants[0].youtube.audioFormatId, null)
})

test('estimated size covers both halves of a paired download', () => {
  const variants = buildVariants(
    formatsFromYtDlp([
      video('137', 1080, { filesize: 100 }),
      audio('140', { filesize: 25 })
    ])
  )

  assert.equal(variants[0].estimatedSize, 125)
})

test('storyboards and other non-media entries never reach the ladder', () => {
  const variants = buildVariants(
    formatsFromYtDlp([
      { format_id: 'sb0', url: URL_, ext: 'mhtml', vcodec: 'none', acodec: 'none', height: 90 },
      video('137', 1080),
      audio('140')
    ])
  )

  assert.deepEqual(
    variants.map((v) => v.label),
    ['1080p']
  )
})

test('formats read from the page are understood without any URL', () => {
  const formats = formatsFromPage([
    { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 4000000, width: 1920, height: 1080, fps: 30, contentLength: 100 },
    { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, width: null, height: null, fps: null, contentLength: 25 }
  ])

  assert.equal(formats[0].hasVideo, true)
  assert.equal(formats[0].hasAudio, false)
  assert.equal(formats[0].ext, 'mp4')
  assert.equal(formats[0].vcodec, 'avc1.640028')

  assert.equal(formats[1].hasVideo, false)
  assert.equal(formats[1].hasAudio, true)
  assert.equal(formats[1].acodec, 'mp4a.40.2')

  const variants = buildVariants(formats)
  assert.equal(variants.length, 1)
  assert.equal(variants[0].label, '1080p')
  assert.equal(variants[0].youtube.videoFormatId, '137')
  assert.equal(variants[0].youtube.audioFormatId, '140')
  // No URL is taken from the page; the accept path resolves the real one.
  assert.equal(variants[0].url, '')
  assert.equal(variants[0].audioUrl, null)
})

test('validated page resources flow into the chosen video and audio variant', () => {
  const videoUrl = 'https://rr2.googlevideo.com/videoplayback?itag=137'
  const audioUrl = 'https://rr2.googlevideo.com/videoplayback?itag=140'
  const variants = buildVariants(formatsFromPage([
    {
      itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 4_000_000,
      width: 1920, height: 1080, fps: 30, contentLength: 100, url: videoUrl
    },
    {
      itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128_000,
      width: null, height: null, fps: null, contentLength: 25, url: audioUrl
    }
  ]))

  assert.equal(variants[0].url, videoUrl)
  assert.equal(variants[0].audioUrl, audioUrl)
})

test('a progressive format in the page response lists both codecs', () => {
  const [format] = formatsFromPage([
    { itag: 18, mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', bitrate: 700000, width: 640, height: 360, fps: 30, contentLength: null }
  ])

  assert.equal(format.hasVideo, true)
  assert.equal(format.hasAudio, true)
  assert.equal(format.vcodec, 'avc1.42001E')
  assert.equal(format.acodec, 'mp4a.40.2')
})

test('HLS and DASH manifests never reach the ladder', () => {
  // Taken from a real video: at every rung yt-dlp priced the m3u8 repackaging
  // above the actual file, so ranking on bitrate alone chose a playlist. The
  // engine then saved a few KB of text as .v.mp4 and ffmpeg rejected it with
  // "Invalid data found when processing input".
  const variants = buildVariants(
    formatsFromYtDlp([
      {
        format_id: '232',
        url: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/x/index.m3u8',
        protocol: 'm3u8_native',
        height: 720,
        width: 1280,
        fps: 30,
        vbr: 1170.916,
        ext: 'mp4',
        vcodec: 'avc1.64001F',
        acodec: 'none',
        filesize: null
      },
      video('136', 720, { vbr: 984.797, filesize: 772204 }),
      audio('140', { abr: 130.362, filesize: 103296 })
    ])
  )

  assert.equal(variants.length, 1)
  // The real file, not the manifest that claimed a higher bitrate.
  assert.equal(variants[0].youtube.videoFormatId, '136')
  assert.match(variants[0].url, /^https:\/\/rr1\./)
  // And a size that reflects the video, not just its audio track.
  assert.equal(variants[0].estimatedSize, 772204 + 103296)
})

test('a manifest URL is rejected even when the protocol field is missing', () => {
  const variants = buildVariants(
    formatsFromYtDlp([
      {
        format_id: '999',
        url: 'https://manifest.googlevideo.com/api/manifest/dash/x/index.mpd',
        height: 1080,
        vbr: 9000,
        ext: 'mp4',
        vcodec: 'avc1',
        acodec: 'none'
      },
      video('137', 1080, { vbr: 4000 }),
      audio('140')
    ])
  )

  assert.equal(variants[0].youtube.videoFormatId, '137')
})

test('the plain audio track is preferred over its -drc twin', () => {
  const variants = buildVariants(
    formatsFromYtDlp([
      video('137', 1080),
      audio('140-drc', { abr: 130.362, filesize: 103296 }),
      audio('140', { abr: 130.362, filesize: 103296 })
    ])
  )

  assert.equal(variants[0].youtube.audioFormatId, '140')
})

test('a page itag resolves to the default language member of a suffixed audio family', () => {
  const formats = [
    audio('140-0', { language: 'ar', language_preference: -1, format_note: 'Arabic' }),
    audio('140-1', {
      language: 'en-US', language_preference: 10,
      format_note: 'English (US) original (default)'
    })
  ]

  assert.equal(selectDirectYtFormat(formats, '140')?.format_id, '140-1')
  const source = formatsFromYtDlp([video('137', 1080), ...formats])
  assert.equal(buildVariants(source)[0].youtube.audioFormatId, '140-1')
})

test('a progressive format is ranked on its video bitrate, not its total', () => {
  // itag 18 declares only tbr, which counts its audio. Compared raw against a
  // video-only format's vbr it would win on bitrate it does not have.
  const [variant] = buildVariants(
    formatsFromYtDlp([
      {
        format_id: '18',
        url: URL_,
        height: 360,
        width: 640,
        fps: 30,
        tbr: 402.781,
        vbr: null,
        ext: 'mp4',
        vcodec: 'avc1.42001E',
        acodec: 'mp4a.40.2'
      },
      // 380 kbps of pure video beats itag 18's 402 total once its ~96 kbps of
      // audio is discounted back out.
      video('134', 360, { vbr: 380 }),
      audio('140', { abr: 130 })
    ])
  )

  assert.equal(variant.youtube.videoFormatId, '134')
})

test('a quality is labelled with the container it will actually be saved as', () => {
  // AAC audio keeps a download in mp4 whatever the video codec is, because
  // that is what ffmpeg is going to be asked to write.
  const [avc] = buildVariants(formatsFromYtDlp([video('137', 1080), audio('140')]))
  assert.equal(avc.container, 'mp4')

  const [vp9] = buildVariants(
    formatsFromYtDlp([video('248', 1080, { ext: 'webm', vcodec: 'vp9' }), audio('140')])
  )
  assert.equal(vp9.container, 'mp4')
})

test('opus audio decides the container it can actually live in', () => {
  const [webm] = buildVariants(
    formatsFromYtDlp([
      video('248', 1080, { ext: 'webm', vcodec: 'vp9' }),
      audio('251', { ext: 'webm', acodec: 'opus' })
    ])
  )
  assert.equal(webm.container, 'webm')

  // Opus beside an mp4-only video: Matroska is the only container that takes
  // the pair without re-encoding either of them.
  const [mixed] = buildVariants(
    formatsFromYtDlp([
      video('137', 1080),
      audio('251', { ext: 'webm', acodec: 'opus' })
    ])
  )
  assert.equal(mixed.container, 'mkv')
})

test('a progressive format keeps its own container', () => {
  const [only] = buildVariants(
    formatsFromYtDlp([
      { format_id: '18', url: URL_, height: 360, ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', tbr: 600 }
    ])
  )
  assert.equal(only.container, 'mp4')
})

test('a Premium manifest is replaced with a direct stream at the same quality', () => {
  const format = selectDirectYtFormat(
    [
      {
        format_id: '616',
        url: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/x/index.m3u8',
        protocol: 'm3u8_native',
        width: 1920,
        height: 1080,
        vbr: 4359,
        ext: 'mp4',
        vcodec: 'vp09.00.51.08',
        acodec: 'none'
      },
      {
        format_id: '137',
        url: 'https://rr1.googlevideo.com/videoplayback?direct=1',
        protocol: 'https',
        width: 1920,
        height: 1080,
        vbr: 4082,
        ext: 'mp4',
        vcodec: 'avc1.640028',
        acodec: 'none'
      }
    ],
    '616'
  )

  assert.equal(format?.format_id, '137')
})

/*
 * The page ladder and yt-dlp's ladder come from two different YouTube clients
 * and do not always name the same itags. Observed on a real video: the page
 * offered 720p as itag 136, and yt-dlp's list for the same video had no 136 at
 * all - its only 720p AVC entry was 298. Refusing to substitute failed the
 * download with "format 136 is no longer available" for a video whose 720p was
 * sitting right there.
 */
test('an itag missing from the yt-dlp ladder resolves to the rung it named', () => {
  const format = selectDirectYtFormat(
    [audio('140'), video('298', 720, { vbr: 2500, fps: 60 }), video('302', 720, { vbr: 2000, vcodec: 'vp9' })],
    '136',
    { kind: 'video', height: 720 }
  )

  assert.equal(format?.format_id, '298')
})

test('a substituted rung is never quietly upgraded past the one chosen', () => {
  const format = selectDirectYtFormat(
    [video('271', 1440, { vbr: 9000 }), video('298', 720, { vbr: 2500 })],
    '137',
    { kind: 'video', height: 1080 }
  )

  assert.equal(format?.format_id, '298')
})

test('a missing audio itag falls back to a track that will still mux', () => {
  const format = selectDirectYtFormat(
    [video('299', 1080), audio('251', { ext: 'webm', acodec: 'opus', abr: 130 })],
    '140',
    { kind: 'audio' }
  )

  assert.equal(format?.format_id, '251')
})

test('an unknown itag is still refused when the caller describes nothing', () => {
  assert.equal(selectDirectYtFormat([video('298', 720), audio('140')], '136'), null)
})

test('a video substitution is refused when the rung it should match is unknown', () => {
  // A task saved before the rung was recorded. Guessing would mean the top of
  // the ladder, which is not what someone who picked 360p asked for.
  const format = selectDirectYtFormat(
    [video('313', 2160, { vbr: 20000 }), video('298', 720, { vbr: 2500 })],
    '136',
    { kind: 'video', height: null }
  )

  assert.equal(format, null)
})

test('audio-only media pages get a compact bitrate ladder', () => {
  const variants = buildAudioVariants(formatsFromYtDlp([
    audio('low', { abr: 64, ext: 'mp3' }),
    audio('high', { abr: 192, ext: 'mp3' }),
    audio('duplicate', { abr: 192, ext: 'mp3' })
  ]))

  assert.deepEqual(variants.map((variant) => variant.label), ['Music · 192 kbps', 'Music · 64 kbps'])
  assert.equal(variants[0].container, 'mp3')
  assert.equal(variants[0].youtube.videoFormatId, 'high')
  assert.equal(variants[0].youtube.role, 'audio')
})

test('each audio bitrate keeps its best available codec', () => {
  const variants = buildAudioVariants(formatsFromYtDlp([
    audio('mp3-copy', { abr: 320, ext: 'mp3', acodec: 'mp3' }),
    audio('opus-copy', { abr: 320, ext: 'webm', acodec: 'opus' })
  ]))

  assert.equal(variants.length, 1)
  assert.equal(variants[0].youtube.videoFormatId, 'opus-copy')
})
