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
  language_preference?: number | null
  preference?: number | null
  audio_ext?: string
  video_ext?: string
  source_preference?: number | null
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
  sourcePreference?: number | null
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
 * Which axis names the quality depends on which way up the video is, and both
 * directions have been got wrong here:
 *
 * - Portrait. A Short at 1080x1920 is 1080p everywhere in YouTube's own UI, so
 *   the short side - the width - is the name. Calling it 4K because it happens
 *   to be 1920 pixels tall would be nonsense.
 *
 * - Landscape. Taking the short side here is what broke letterboxed video. A
 *   2.40:1 film is encoded with the bars cropped off, so YouTube's 1080p
 *   rendition of it is 1920x798 - and `min(1920, 798)` is 798, which snaps to
 *   720p. The whole ladder of a widescreen video shifted down one rung, and a
 *   video YouTube was plainly offering in 1080p could only be downloaded at
 *   "720p". So the rung comes from whichever is larger: the real height, or the
 *   height this width would have at 16:9. A 4:3 video keeps its own height
 *   (640x480 stays 480p), and an ordinary 16:9 frame is unaffected either way.
 *
 * Nearest rung rather than a fixed cutoff, so the odd heights that non-16:9
 * sources produce land where a person would put them: 1072 is 1080p, 640 is
 * 720p rather than being demoted two rungs by an arbitrary threshold.
 */
export function tierFor(height: number | null, width: number | null = null): number | null {
  if (!height || height <= 0) return null

  const side = !width || width <= 0
    ? height
    : height > width
      ? width
      : Math.max(height, Math.round((width * 9) / 16))

  let best = TIERS[TIERS.length - 1]
  for (const tier of TIERS) {
    if (Math.abs(tier - side) < Math.abs(best - side)) best = tier
  }
  return best
}

/**
 * How many rungs below the requested quality a substitute actually landed.
 *
 * Zero means the same rung or better. This exists because a substitution is
 * only reasonable while it stays near what was asked for: `substituteVideo`
 * will walk all the way down the ladder rather than fail, and when YouTube is
 * withholding everything but itag 18 that walk turns a 2160p request into a
 * 360p file still named `… 2160p.mp4`. Nothing about that is visible to the
 * person who chose 2160p, which is what makes it worth measuring.
 */
export function rungsBelow(wantedHeight: number | null, offeredHeight: number | null): number {
  const wanted = tierFor(wantedHeight)
  const offered = tierFor(offeredHeight)
  if (wanted === null || offered === null) return 0

  const wantedIndex = TIERS.indexOf(wanted)
  const offeredIndex = TIERS.indexOf(offered)
  if (wantedIndex < 0 || offeredIndex < 0) return 0

  // TIERS runs highest first, so a larger index is a lower rung.
  return Math.max(0, offeredIndex - wantedIndex)
}

/**
 * The rungs a ladder actually offers, highest first, as labels.
 *
 * Shown to the user when a substitution is refused: "2160p is not on offer" is
 * only half an answer, and the other half - what *is* on offer - is the part
 * that tells them whether the problem is this video or their whole setup.
 */
export function offeredTiers(formats: YtDlpFormat[]): string[] {
  const tiers = new Set<number>()
  for (const format of directFormats(formats)) {
    if (!format.vcodec || format.vcodec === 'none') continue
    const tier = tierFor(format.height ?? null, format.width ?? null)
    if (tier !== null) tiers.add(tier)
  }
  return [...tiers].sort((a, b) => b - a).map((tier) => tierLabel(tier, null))
}

export function tierLabel(tier: number, fps: number | null): string {
  const name = tier === 4320 ? '8K' : tier === 2160 ? '4K' : tier === 1440 ? '2K' : `${tier}p`
  // Only high frame rates are worth the ink; every ordinary format is 24-30.
  return fps && fps >= 50 ? `${name}${Math.round(fps)}` : name
}

/**
 * Compare bitrate within a codec: a more efficient codec need not be larger.
 */
function codecRank(vcodec: string | null): number {
  const codec = (vcodec ?? '').toLowerCase()
  if (codec.startsWith('av01')) return 3
  if (codec.startsWith('vp9') || codec.startsWith('vp09')) return 2
  if (codec.startsWith('avc1') || codec.startsWith('h264')) return 1
  return 0
}

function audioCodecRank(format: SourceFormat): number {
  const codec = (format.acodec ?? '').toLowerCase()
  const ext = (format.ext ?? '').toLowerCase()
  if (/flac|alac|wav|pcm/.test(codec) || /^(flac|wav|alac)$/.test(ext)) return 5
  if (/opus/.test(codec)) return 4
  if (/mp4a|aac/.test(codec)) return 3
  if (/vorbis/.test(codec)) return 2
  if (/mp3|mpga/.test(codec) || ext === 'mp3') return 1
  return 0
}

/** Higher is better, on every axis. */
function betterVideo(a: SourceFormat, b: SourceFormat): number {
  return (
    (b.sourcePreference ?? -1) - (a.sourcePreference ?? -1) ||
    (b.fps ?? 0) - (a.fps ?? 0) ||
    codecRank(b.vcodec) - codecRank(a.vcodec) ||
    (b.bitrate ?? 0) - (a.bitrate ?? 0) ||
    (b.size ?? 0) - (a.size ?? 0)
  )
}

/**
 * One entry per quality rung, ranked by source preference, frame rate, codec,
 * then bitrate within that codec. Pair the winning video with the best audio.
 */
export function buildVariants(formats: SourceFormat[]): MediaVariant[] {
  const real = formats.filter((f) => !isStoryboardFormat(f))
  const audios = real.filter((f) => f.hasAudio && !f.hasVideo)
  const bestAudio = pickBestAudio(audios)

  // Video-only formats carry the high bitrates and go up to 4K; progressive
  // ones stop at 720p but need no mux. Both compete for a rung on merit, with
  // adaptive winning wherever it exists because its bitrate is higher.
  const candidates = real.filter((f) => f.hasVideo && (f.height ?? 0) > 0)

  const hasAnyAudio = real.some((f) => f.hasAudio)

  const best = new Map<number, SourceFormat>()
  for (const format of candidates) {
    const tier = tierFor(format.height, format.width)
    if (tier === null) continue
    // A video-only format only requires audio pairing if the source actually offers audio.
    // Silent videos, screen captures, and Twitter GIFs have no audio track at all.
    if (!format.hasAudio && !bestAudio && hasAnyAudio) continue

    const existing = best.get(tier)
    if (!existing || betterVideo(format, existing) < 0) best.set(tier, format)
  }

  return [...best.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([tier, video]) => variantFor(tier, video, video.hasAudio ? null : bestAudio))
}

/** A compact quality list for media pages that expose audio but no video. */
export function buildAudioVariants(formats: SourceFormat[]): MediaVariant[] {
  const audio = formats
    .filter((format) => format.hasAudio && !format.hasVideo)
    .sort((a, b) =>
      (b.bitrate ?? 0) - (a.bitrate ?? 0) ||
      audioCodecRank(b) - audioCodecRank(a) ||
      (b.size ?? 0) - (a.size ?? 0)
    )

  const seen = new Set<string>()
  const variants: MediaVariant[] = []
  for (const format of audio) {
    const rate = format.bitrate ? Math.round(format.bitrate / 1000) : null
    const container = format.ext || 'm4a'
    // One best stream for each bitrate. If the source publishes several 320
    // kbps copies, codec quality and then the real size decide which survives.
    const key = `${rate ?? 'unknown'}`
    if (seen.has(key)) continue
    seen.add(key)
    variants.push({
      url: format.url ?? '',
      label: rate ? `Music · ${rate} kbps` : 'Music',
      height: null,
      bandwidth: format.bitrate,
      codecs: format.acodec,
      estimatedSize: format.size,
      container,
      youtube: { videoFormatId: format.id, audioFormatId: null, role: 'audio' }
    })
  }
  return variants.slice(0, 6)
}

function variantFor(
  tier: number,
  video: SourceFormat,
  audio: SourceFormat | null
): MediaVariant {
  const size = video.size !== null && (!audio || audio.size !== null)
    ? video.size + (audio?.size ?? 0) : null

  const bandwidth = (video.bitrate ?? 0) + (audio?.bitrate ?? 0)

  const codecText = [video.vcodec, audio ? audio.acodec : video.acodec]
    .filter((c): c is string => Boolean(c) && c !== 'none')
    .join(' / ')

  return {
    container: containerFor(video, audio),
    // Page-derived formats carry the already-playing CDN resource when the
    // browser exposes it. yt-dlp variants always carry one. Either way, this is
    // the URL the task starts with; stable itags below remain the refresh key.
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

  // YouTube ships a dynamic-range-compressed twin of each audio track at the
  // same bitrate ("140-drc" beside "140"). The plain one is what the site plays
  // by default, so it is what a download should be.
  const drc = (f: SourceFormat): number => (/-drc$/i.test(f.id) ? 1 : 0)

  return (
    [...formats].sort(
      (a, b) =>
        drc(a) - drc(b) ||
        audioCodecRank(b) - audioCodecRank(a) ||
        (b.bitrate ?? 0) - (a.bitrate ?? 0) ||
        (b.size ?? 0) - (a.size ?? 0)
    )[0] ?? null
  )
}

/* ------------------------------------------------------------------ */
/* Format sources                                                      */
/* ------------------------------------------------------------------ */

/**
 * Whether a format can go through the ranged file downloader. HLS playlists
 * must use HlsRunner instead, even when the extractor reports ext: 'mp4'.
 */
export function isDirectDownload(format: YtDlpFormat): boolean {
  const protocol = (format.protocol ?? '').toLowerCase()
  if (protocol && protocol !== 'https' && protocol !== 'http') return false
  return !/[.]m3u8([?#]|$)|\/manifest\//i.test(format.url ?? '')
}

/** The formats this engine can actually fetch: real files, over http(s). */
export function directFormats(formats: YtDlpFormat[]): YtDlpFormat[] {
  return formats.filter(
    (candidate) => Boolean(candidate.url) && /^https?:/i.test(candidate.url!) && isDirectDownload(candidate)
  )
}

/** Compare only formats Draco can download, not manifest entries without usable media URLs. */
export function bestDirectVideoHeight(formats: YtDlpFormat[]): number {
  return directFormats(formats).reduce((best, format) =>
    format.vcodec && format.vcodec !== 'none'
      ? Math.max(best, tierFor(format.height ?? null, format.width ?? null) ?? 0)
      : best, 0)
}

/**
 * What the caller actually asked for, in terms that survive a missing itag.
 *
 * The page ladder and yt-dlp's ladder are two different YouTube clients'
 * answers to the same question, and they do not always name the same itags: a
 * page offering 720p as itag 136 has been seen against a yt-dlp list whose only
 * 720p AVC entry is 298, with no 136 in it at all. The itag is only the page's
 * *name* for a rung; this is the rung, which is what the user actually chose
 * and the only thing a substitution can be made against.
 */
export interface WantedFormat {
  kind: 'video' | 'audio'
  height?: number | null
  delivery?: 'hls'
}

/**
 * Finds a fetchable replacement for a page-selected itag. Premium formats can
 * share a resolution with an ordinary file while exposing only an HLS URL; the
 * latter is what the segmented downloader needs. And an itag the other client
 * never listed still has to resolve to *something*, or a perfectly downloadable
 * video fails outright on the strength of a name.
 */
export function selectDirectYtFormat(
  formats: YtDlpFormat[],
  formatId: string,
  wanted?: WantedFormat
): YtDlpFormat | null {
  // HLS runs through the playlist runner. Never substitute a file URL into it.
  if (wanted?.delivery === 'hls') return formats.find(candidate =>
    candidate.format_id === formatId && isHlsDownload(candidate)) ?? null
  const direct = directFormats(formats)
  const exact = direct.find((candidate) => candidate.format_id === formatId)
  if (exact) return exact

  // Multi-language videos now commonly expose an itag as 140-0, 140-1, …
  // even though YouTube's player response still names the family as 140. Pick
  // yt-dlp's default/original-language member of that family rather than
  // declaring the page-selected audio unavailable.
  const alternateTracks = direct.filter((candidate) => baseFormatId(candidate.format_id) === formatId)
  if (alternateTracks.length > 0) return preferredLanguageTrack(alternateTracks)

  // yt-dlp's own record of the itag describes the substitute best, since it
  // carries the real frame and rate. `wanted` covers the case that brings most
  // downloads here: the two ladders not sharing the itag at all.
  const requested = formats.find(
    (candidate) => candidate.format_id === formatId || baseFormatId(candidate.format_id) === formatId
  )
  if (!requested && !wanted) return null

  const video = requested ? hasVideoTrack(requested) : wanted!.kind === 'video'
  const pool = direct.filter((candidate) => hasVideoTrack(candidate) === video)
  if (pool.length === 0) return null

  return video
    ? substituteVideo(pool, requested, requested?.height ?? wanted?.height ?? null)
    : substituteAudio(pool, requested)
}

function hasVideoTrack(format: YtDlpFormat): boolean {
  return Boolean(format.vcodec && format.vcodec !== 'none')
}

/**
 * The rung is what the user picked; the itag was only its name. Prefer the
 * exact frame, then the same height, then the closest rung - but never a rung
 * *above* the request unless there is nothing below it, because a substitution
 * that quietly doubles the file size is its own kind of wrong.
 */
function substituteVideo(
  pool: YtDlpFormat[],
  requested: YtDlpFormat | undefined,
  height: number | null
): YtDlpFormat | null {
  // Nothing known about the rung - an itag with no counterpart, on a task saved
  // before the rung was recorded. Better to fail than to guess: the guess would
  // be the top of the ladder, and fetching 4K for someone who chose 360p is a
  // worse answer than saying so.
  if (!requested && height === null) return null

  const frameWidth = requested?.width ?? null
  const frameHeight = requested?.height ?? null
  const sameFrame = frameWidth && frameHeight
    ? pool.filter((c) => c.width === frameWidth && c.height === frameHeight)
    : []
  const sameHeight = height ? pool.filter((c) => c.height === height) : []
  const tier = tierFor(height)
  const sameTier = tier ? pool.filter((c) => tierFor(c.height ?? null, c.width ?? null) === tier) : []

  let candidates = firstNonEmpty(sameFrame, sameHeight, sameTier)
  if (!candidates && tier) {
    const below = pool.filter((c) => (tierFor(c.height ?? null, c.width ?? null) ?? 0) < tier)
    candidates = firstNonEmpty(below, pool)
  }
  if (!candidates) candidates = pool

  const rate = requested ? (requested.vbr ?? requested.tbr ?? 0) : 0
  if (rate > 0) return nearestRate(candidates, rate)

  // Nothing to aim at, so take the best of what is left the way the ladder
  // itself would: highest rung first, then the richest copy of it.
  return [...candidates].sort(
    (a, b) =>
      (b.height ?? 0) - (a.height ?? 0) ||
      (b.vbr ?? b.tbr ?? 0) - (a.vbr ?? a.tbr ?? 0)
  )[0] ?? null
}

/**
 * Any audio track will mux, so the only question is which. The same container
 * family as the missing one where possible - that is what keeps an .mp4 an
 * .mp4 - and otherwise the ladder's own preference: the plain track over its
 * -drc twin, the original language, the highest rate.
 */
function substituteAudio(pool: YtDlpFormat[], requested: YtDlpFormat | undefined): YtDlpFormat | null {
  const ext = requested?.ext ?? null
  const sameExt = ext ? pool.filter((c) => c.ext === ext) : []
  const candidates = firstNonEmpty(sameExt, pool) ?? pool

  const rate = requested?.abr ?? requested?.tbr ?? 0
  if (rate > 0) return nearestRate(candidates, rate)

  return [...candidates].sort(
    (a, b) =>
      (/-drc/i.test(a.format_id ?? '') ? 1 : 0) - (/-drc/i.test(b.format_id ?? '') ? 1 : 0) ||
      (b.language_preference ?? 0) - (a.language_preference ?? 0) ||
      (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0)
  )[0] ?? null
}

function nearestRate(candidates: YtDlpFormat[], targetRate: number): YtDlpFormat | null {
  return [...candidates].sort((a, b) => {
    const aRate = a.vbr ?? a.abr ?? a.tbr ?? 0
    const bRate = b.vbr ?? b.abr ?? b.tbr ?? 0
    return Math.abs(aRate - targetRate) - Math.abs(bRate - targetRate)
  })[0] ?? null
}

function firstNonEmpty(...groups: YtDlpFormat[][]): YtDlpFormat[] | null {
  return groups.find((group) => group.length > 0) ?? null
}

function baseFormatId(formatId: string | undefined): string | null {
  if (!formatId) return null
  const match = /^(.*)-(\d+)$/.exec(formatId)
  return match?.[1] ?? null
}

function preferredLanguageTrack(formats: YtDlpFormat[]): YtDlpFormat {
  return [...formats].sort((a, b) => {
    const language = (b.language_preference ?? 0) - (a.language_preference ?? 0)
    if (language !== 0) return language
    const preference = (b.preference ?? 0) - (a.preference ?? 0)
    if (preference !== 0) return preference
    const bDefault = /(?:original|default)/i.test(b.format_note ?? '') ? 1 : 0
    const aDefault = /(?:original|default)/i.test(a.format_note ?? '') ? 1 : 0
    return bDefault - aDefault
  })[0]
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

export function isHlsDownload(format: YtDlpFormat): boolean {
  return /^(m3u8|m3u8_native)$/.test(format.protocol ?? '') && /^https?:/i.test(format.url ?? '')
}

export function formatsFromYtDlp(formats: YtDlpFormat[], includeHls = false): SourceFormat[] {
  const preferredAudio = new Map<string, YtDlpFormat>()
  for (const format of formats) {
    const audioOnly = Boolean(format.acodec && format.acodec !== 'none') &&
      (!format.vcodec || format.vcodec === 'none')
    const base = audioOnly ? baseFormatId(format.format_id) : null
    if (!base) continue
    const previous = preferredAudio.get(base)
    preferredAudio.set(base, previous ? preferredLanguageTrack([previous, format]) : format)
  }

  return formats
    .filter((format) => {
      const base = baseFormatId(format.format_id)
      return !base || !preferredAudio.has(base) || preferredAudio.get(base) === format
    })
    .filter((f) => f.url && /^https?:/i.test(f.url) &&
      (isDirectDownload(f) || (includeHls && isHlsDownload(f) && hasVideoTrack(f))))
    .map((f) => ({
      id: f.format_id ?? '',
      sourcePreference: f.source_preference,
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
      const codecs = /codecs=["']?([^"']+)["']?/i.exec(mime)?.[1] ?? ''
      const parts = codecs.split(',').map((c) => c.trim()).filter(Boolean)
      const ext = /^[a-z]+\/([a-z0-9]+)/i.exec(mime)?.[1]?.toLowerCase() ?? null

      // A progressive format lists both codecs; an adaptive one lists a single
      // codec whose kind the MIME type has already told us.
      const vcodec = kind === 'video' ? parts[0] ?? null : null
      const acodec =
        kind === 'audio' ? parts[0] ?? null : parts.length > 1 ? parts[1] ?? null : null

      return {
        id: String(f.itag),
        url: f.url ?? null,
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
