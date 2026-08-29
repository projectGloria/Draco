import type { MediaVariant, PageFormat } from '../shared/types.ts'

/**
 * How a pile of formats becomes the short list of qualities a person is offered.
 *
 * Split out of `youtube.ts` for the same reason `store-sanitize.ts` is split out
 * of `store.ts`: this is pure data shaping with awkward edge cases, and keeping
 * it free of Electron and of child processes means it can be tested directly.
 */

/** One entry of yt-dlp's `--dump-single-json` format list. */
export interface YtDlpFormat {
  url?: string
  format_id?: string
  ext?: string
  protocol?: string
  format_note?: string
  width?: number
  height?: number
  fps?: number
  vcodec?: string
  acodec?: string
  tbr?: number
  abr?: number
  vbr?: number
  filesize?: number | null
  filesize_approx?: number | null
  language?: string | null
  audio_ext?: string
  video_ext?: string
  manifest_url?: string
}

/* ------------------------------------------------------------------ */
/* Quality ladder                                                      */
/* ------------------------------------------------------------------ */

/**
 * A format from either source - yt-dlp's JSON or the player response read
 * straight out of the page - reduced to the fields the ladder actually ranks on.
 *
 * The page can only supply metadata, never a URL: see `formatsFromPage`.
 */
export interface SourceFormat {
  id: string
  url: string | null
  width: number | null
  height: number | null
  fps: number | null
  /** Video bitrate in bits per second, the figure quality is ranked on. */
  bitrate: number | null
  size: number | null
  vcodec: string | null
  acodec: string | null
  ext: string | null
  hasVideo: boolean
  hasAudio: boolean
}

/**
 * The rungs a height is snapped onto. YouTube hands out odd heights for
 * non-16:9 videos - 1072, 806, 362 - and listing those verbatim produces a menu
 * of near-duplicates instead of the handful of choices anyone actually wants.
 */
const TIERS = [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144]

/**
 * The rung a frame belongs to, measured the way YouTube measures it.
 *
 * Quality is named after the short side, not the height: a Short at 1080x1920
 * is 1080p everywhere in YouTube's own UI, and calling it 4K because it happens
 * to be 1920 pixels tall would be nonsense. For ordinary landscape video the
 * short side *is* the height and nothing changes.
 *
 * Nearest rung rather than a fixed cutoff, so the odd heights that non-16:9
 * sources produce land where a person would put them: 1072 is 1080p, 640 is
 * 720p rather than being demoted two rungs by an arbitrary threshold.
 */
export function tierFor(height: number | null, width: number | null = null): number | null {
  const side = width && height ? Math.min(width, height) : height
  if (!side || side <= 0) return null

  let best = TIERS[TIERS.length - 1]
  for (const tier of TIERS) {
    if (Math.abs(tier - side) < Math.abs(best - side)) best = tier
  }
  return best
}

export function tierLabel(tier: number, fps: number | null): string {
  const name = tier === 4320 ? '8K' : tier === 2160 ? '4K' : tier === 1440 ? '2K' : `${tier}p`
  // Only high frame rates are worth the ink; every ordinary format is 24-30.
  return fps && fps >= 50 ? `${name}${Math.round(fps)}` : name
}

/**
 * Modern codecs carry more detail at the same bitrate, so they win a tie. This
 * only ever breaks one - bitrate decides first.
 */
function codecRank(vcodec: string | null): number {
  const codec = (vcodec ?? '').toLowerCase()
  if (codec.startsWith('av01')) return 3
  if (codec.startsWith('vp9') || codec.startsWith('vp09')) return 2
  if (codec.startsWith('avc1') || codec.startsWith('h264')) return 1
  return 0
}

/** Higher is better, on every axis. */
function betterVideo(a: SourceFormat, b: SourceFormat): number {
  return (
    (b.bitrate ?? 0) - (a.bitrate ?? 0) ||
    (b.fps ?? 0) - (a.fps ?? 0) ||
    codecRank(b.vcodec) - codecRank(a.vcodec) ||
    (b.size ?? 0) - (a.size ?? 0)
  )
}

/**
 * One entry per quality rung, each of them the best that rung has.
 *
 * YouTube publishes the same 1080p three or four times over - mp4/avc1,
 * webm/vp9, mp4/av01, plus a progressive copy - and offering all of them asks
 * the user to know which container they want, which is not a question they came
 * here to answer. So: bucket by rung, keep the highest-bitrate entry in each,
 * and pair it with the best audio.
 */
export function buildVariants(formats: SourceFormat[]): MediaVariant[] {
  const real = formats.filter((f) => !isStoryboardFormat(f))
  const audios = real.filter((f) => f.hasAudio && !f.hasVideo)
  const bestAudio = pickBestAudio(audios)

  // Video-only formats carry the high bitrates and go up to 4K; progressive
  // ones stop at 720p but need no mux. Both compete for a rung on merit, with
  // adaptive winning wherever it exists because its bitrate is higher.
  const candidates = real.filter((f) => f.hasVideo && (f.height ?? 0) > 0)

  const best = new Map<number, SourceFormat>()
  for (const format of candidates) {
    const tier = tierFor(format.height, format.width)
    if (tier === null) continue
    // A video-only format is unusable without audio to pair with it.
    if (!format.hasAudio && !bestAudio) continue

    const existing = best.get(tier)
    if (!existing || betterVideo(format, existing) < 0) best.set(tier, format)
  }

  return [...best.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([tier, video]) => variantFor(tier, video, video.hasAudio ? null : bestAudio))
}

function variantFor(
  tier: number,
  video: SourceFormat,
  audio: SourceFormat | null
): MediaVariant {
  const size =
    video.size !== null || audio?.size != null
      ? (video.size ?? 0) + (audio?.size ?? 0)
      : null

  const bandwidth = (video.bitrate ?? 0) + (audio?.bitrate ?? 0)

  const codecText = [video.vcodec, audio ? audio.acodec : video.acodec]
    .filter((c): c is string => Boolean(c) && c !== 'none')
    .join(' / ')

  return {
    container: containerFor(video, audio),
    // Page-derived formats have no URL of their own, and even a yt-dlp one is
    // only ever displayed: the task carries the watch page and its format ids,
    // and the engine resolves the signed URL as it starts. Nothing fetches this
    // value - see `refreshYouTubeFormat`.
    url: video.url ?? '',
    audioUrl: audio?.url ?? null,
    label: tierLabel(tier, video.fps),
    height: video.height ?? tier,
    bandwidth: bandwidth > 0 ? bandwidth : null,
    codecs: codecText || null,
    estimatedSize: size,
    youtube: { videoFormatId: video.id, audioFormatId: audio?.id ?? null }
  }
}

/**
 * The extension the finished file will carry, which is also the container the
 * mux has to produce.
 *
 * Muxing is always `-c copy`, so the container must accept both streams exactly
 * as they came off the wire. MP4 takes all of YouTube's video codecs - avc1,
 * vp9 and av01 alike - so an AAC audio track keeps the whole thing in the .mp4
 * people expect. Opus is the awkward one: it belongs in WebM, and pairing it
 * with an MP4-only video leaves Matroska as the only container that will hold
 * the pair without re-encoding.
 */
export function containerFor(video: SourceFormat, audio: SourceFormat | null): string {
  const videoFamily = familyOf(video)
  if (!audio) return videoFamily ?? 'mp4'

  const audioFamily = familyOf(audio)
  if (audioFamily === 'mp4') return 'mp4'
  if (audioFamily === 'webm') return videoFamily === 'webm' ? 'webm' : 'mkv'
  return videoFamily ?? 'mp4'
}

/** Which of the two container families a format belongs to, by ext then codec. */
function familyOf(format: SourceFormat): 'mp4' | 'webm' | null {
  const ext = (format.ext ?? '').toLowerCase()
  if (/^(mp4|m4a|m4v|mov|3gp)$/.test(ext)) return 'mp4'
  if (/^(webm|weba)$/.test(ext)) return 'webm'

  const codecs = `${format.vcodec ?? ''} ${format.acodec ?? ''}`.toLowerCase()
  if (/mp4a|avc1|h264|aac/.test(codecs)) return 'mp4'
  if (/opus|vorbis/.test(codecs)) return 'webm'
  return null
}

function isStoryboardFormat(format: SourceFormat): boolean {
  return format.ext === 'mhtml' || (!format.hasVideo && !format.hasAudio)
}

function pickBestAudio(formats: SourceFormat[]): SourceFormat | null {
  if (formats.length === 0) return null

  // AAC in an MP4 container muxes into the .mp4 these downloads land as without
  // argument. Opus is only reached for when there is no AAC on offer.
  const aac = formats.filter(
    (f) => /^(m4a|mp4)$/i.test(f.ext ?? '') && /mp4a|aac/i.test(f.acodec ?? '')
  )

  const pool = aac.length > 0 ? aac : formats

  // YouTube ships a dynamic-range-compressed twin of each audio track at the
  // same bitrate ("140-drc" beside "140"). The plain one is what the site plays
  // by default, so it is what a download should be.
  const drc = (f: SourceFormat): number => (/-drc$/i.test(f.id) ? 1 : 0)

  return (
    [...pool].sort(
      (a, b) =>
        drc(a) - drc(b) ||
        (b.bitrate ?? 0) - (a.bitrate ?? 0) ||
        (b.size ?? 0) - (a.size ?? 0)
    )[0] ?? null
  )
}

/* ------------------------------------------------------------------ */
/* Format sources                                                      */
/* ------------------------------------------------------------------ */

/**
 * Whether a format is a single file this engine can actually fetch.
 *
 * yt-dlp also lists HLS and DASH repackagings of the same streams, and prices
 * them higher: for one 720p video the m3u8 entry claimed 1170 kbps against the
 * real file's 985, so ranking on bitrate alone picked the manifest at every
 * rung. Their `url` is a playlist, not media - the byte-range downloader
 * happily saves a few kilobytes of text as `.v.mp4`, and ffmpeg then rejects it
 * with "Invalid data found when processing input". They also carry no filesize,
 * so every quality ends up displaying the same audio-only estimate.
 *
 * The manifest entries add nothing anyway: they describe the same renditions
 * that are already listed as plain files.
 */
export function isDirectDownload(format: YtDlpFormat): boolean {
  const protocol = (format.protocol ?? '').toLowerCase()
  if (protocol && protocol !== 'https' && protocol !== 'http') return false
  return !/[.]m3u8([?#]|$)|\/manifest\//i.test(format.url ?? '')
}

/** YouTube's progressive audio rate, used only when a format will not say. */
const NOMINAL_PROGRESSIVE_ABR = 96

function videoRate(f: YtDlpFormat): number {
  const hasVideo = Boolean(f.vcodec && f.vcodec !== 'none')
  const hasAudio = Boolean(f.acodec && f.acodec !== 'none')

  if (!hasVideo) return f.abr ?? f.tbr ?? 0
  // Nullish, not just undefined: yt-dlp writes JSON null for an absent rate.
  if (f.vbr != null) return f.vbr
  if (!hasAudio) return f.tbr ?? 0

  return Math.max(0, (f.tbr ?? 0) - (f.abr ?? NOMINAL_PROGRESSIVE_ABR))
}

export function formatsFromYtDlp(formats: YtDlpFormat[]): SourceFormat[] {
  return formats
    .filter((f) => f.url && /^https?:/i.test(f.url) && isDirectDownload(f))
    .map((f) => ({
      id: f.format_id ?? '',
      url: f.url ?? null,
      width: f.width ?? null,
      height: f.height ?? null,
      fps: f.fps ?? null,
      /*
       * Each kind of format reports its rate under a different key: vbr for
       * video, abr for audio, tbr for a progressive stream carrying both. Taking
       * vbr alone would leave every audio-only format at zero, and the best-audio
       * pick would then come down to whatever happened to be listed first.
       *
       * A progressive format usually gives only tbr, which counts its audio too.
       * Comparing that against a video-only format's vbr would flatter it by the
       * audio bitrate, so the audio is discounted back out first - itag 18 is
       * 96 kbps AAC when it declines to say.
       */
      bitrate: Math.round(videoRate(f) * 1000) || null,
      size: f.filesize ?? f.filesize_approx ?? null,
      vcodec: f.vcodec && f.vcodec !== 'none' ? f.vcodec : null,
      acodec: f.acodec && f.acodec !== 'none' ? f.acodec : null,
      ext: f.ext ?? null,
      hasVideo: Boolean(f.vcodec && f.vcodec !== 'none'),
      hasAudio: Boolean(f.acodec && f.acodec !== 'none')
    }))
    .filter((f) => f.id)
}

/**
 * The browser already parsed the player response to play the video, so the
 * quality ladder is sitting in the page for free. Reading it there is the
 * difference between a menu that appears at once and one that appears after
 * yt-dlp has spent six seconds asking YouTube the same question.
 *
 * Only metadata crosses this boundary. The page is web content and cannot be
 * trusted with a URL Draco would then fetch, so every download URL still comes
 * from yt-dlp; these entries exist to be *shown*.
 */
export function formatsFromPage(formats: PageFormat[]): SourceFormat[] {
  return formats
    .map((f) => {
      const mime = f.mimeType ?? ''
      const kind = /^audio\//i.test(mime) ? 'audio' : /^video\//i.test(mime) ? 'video' : ''
      const codecs = /codecs="([^"]+)"/i.exec(mime)?.[1] ?? ''
      const parts = codecs.split(',').map((c) => c.trim()).filter(Boolean)
      const ext = /^[a-z]+\/([a-z0-9]+)/i.exec(mime)?.[1]?.toLowerCase() ?? null

      // A progressive format lists both codecs; an adaptive one lists a single
      // codec whose kind the MIME type has already told us.
      const vcodec = kind === 'video' ? parts[0] ?? null : null
      const acodec =
        kind === 'audio' ? parts[0] ?? null : parts.length > 1 ? parts[1] ?? null : null

      return {
        id: String(f.itag),
        url: null,
        width: f.width ?? null,
        height: f.height ?? null,
        fps: f.fps ?? null,
        bitrate: f.bitrate ?? null,
        size: f.contentLength ?? null,
        vcodec,
        acodec,
        ext,
        hasVideo: Boolean(vcodec),
        hasAudio: Boolean(acodec)
      }
    })
    .filter((f) => f.id && f.id !== 'undefined')
}
