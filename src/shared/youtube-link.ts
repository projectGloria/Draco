/**
 * What a YouTube link stands for: one video, or many.
 *
 * This used to exist twice - `main/youtube-playlist.ts` held the authority and
 * `renderer/src/lib/format.ts` held "a quick read, only good enough to decide
 * which dialog opens". Two copies of the same three regexes and the same
 * mix-prefix check, with a comment explaining that the renderer's was allowed
 * to be wrong because main would catch it. That only holds while the two agree,
 * and every fix had to be made twice to keep them agreeing.
 *
 * Pure, dependency-free and in `shared` so both processes import the same
 * answer. Main reaches it with a relative `.ts` specifier rather than the
 * `@shared` alias, because the engine tests run these modules under bare Node's
 * type stripping, which has no alias resolution.
 */

/**
 * The URL a typed or pasted string means.
 *
 * A scheme-less `youtube.com/playlist?list=...` - which is what copying from
 * Chrome's address bar frequently gives you - failed `new URL()` outright and
 * fell through to the generic file path, where it became a download of an HTML
 * page. Anything that already names a protocol is left exactly as it was, so
 * this can never rewrite a link the user was explicit about.
 */
export function normalizeLinkInput(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  return LOOKS_LIKE_HOST_AND_PATH.test(trimmed) ? 'https://' + trimmed : trimmed
}

/**
 * A dotted host followed by a path, query or fragment.
 *
 * The path separator is required, and that is the whole point of the pattern:
 * a bare `file.iso` is indistinguishable from a bare `example.co`, so accepting
 * hosts on their own would turn a mistyped filename into a download attempt
 * against a hostname instead of an error that says what went wrong. Everything
 * this exists for - `youtube.com/playlist?list=...` off an address bar - has a
 * path on it.
 */
const LOOKS_LIKE_HOST_AND_PATH = /^[a-z0-9-]+(\.[a-z0-9-]+)+[:/?#]/i

/** The parsed form of a YouTube address, or null for anything else. */
export function parseYouTubeUrl(value: unknown): URL | null {
  const normalized = normalizeLinkInput(value)
  if (normalized === null) return null

  try {
    const url = new URL(normalized)
    // https only, and deliberately: a scheme-less address is normalised up to
    // https above, but an explicit `http://` is a downgrade somebody asked for
    // and is refused rather than quietly upgraded.
    if (url.protocol !== 'https:') return null
    if (!/(^|\.)youtube\.com$/i.test(url.hostname) && !/(^|\.)youtu\.be$/i.test(url.hostname)) {
      return null
    }
    return url
  } catch {
    return null
  }
}

/**
 * The one answer to "is this a YouTube page we handle?".
 *
 * There used to be two, and they disagreed: the handoff path took `http:` but
 * refused `music.youtube.com`, while the priming path did the opposite - so a
 * video could be primed and then declined, or vice versa. Subdomains are in
 * (music, m, www).
 */
export function isSupportedYouTubeUrl(value: unknown): boolean {
  return parseYouTubeUrl(value) !== null
}

/**
 * A mix has no end: YouTube generates the next entry from what you just
 * watched, so "download the playlist" has no meaning for one.
 *
 * `RD` is the mix prefix and the only one that belongs here. `UL` (a legacy
 * uploads playlist) and `TL` were also being rejected, and both are perfectly
 * finite lists - so a link to one was refused for no reason at all.
 */
function isEndlessMix(list: string): boolean {
  return /^RD/.test(list)
}

/** A channel link means "everything this person posted", which is a listing too. */
function isChannelPath(pathname: string): boolean {
  return (
    /^\/@[^/]+(?:\/(?:videos|shorts|streams|featured|playlists))?\/?$/i.test(pathname) ||
    /^\/(?:channel|c|user)\/[^/]+(?:\/(?:videos|shorts|streams|featured|playlists))?\/?$/i.test(pathname) ||
    /^\/playlist\/?$/i.test(pathname)
  )
}

/**
 * Whether this link stands for a collection rather than a single video.
 *
 * A watch URL carrying `list=` is the ambiguous case, and it is treated as a
 * playlist: the user pasted a link that names one, and the one-video reading is
 * still available by removing it - which is what `singleVideoUrl` offers.
 */
export function isPlaylistUrl(value: unknown): boolean {
  const parsed = parseYouTubeUrl(value)
  if (!parsed) return false

  const list = parsed.searchParams.get('list')
  if (list) return !isEndlessMix(list)

  return isChannelPath(parsed.pathname)
}

/** The `list=` id, when there is one. Used to name the folder entries land in. */
export function playlistIdOf(value: unknown): string | null {
  const parsed = parseYouTubeUrl(value)
  const list = parsed?.searchParams.get('list')
  return list && !isEndlessMix(list) ? list : null
}

/**
 * The eleven-character video id a link names, or null when it names none.
 *
 * Deliberately strict about the shape. This id is pasted into a thumbnail URL,
 * and an id taken verbatim from an arbitrary string is a way to point that URL
 * somewhere else entirely; the character class here is exactly YouTube's own.
 */
export function videoIdOf(value: unknown): string | null {
  const parsed = parseYouTubeUrl(value)
  if (!parsed) return typeof value === 'string' && VIDEO_ID.test(value) ? value : null

  const candidate = /(^|\.)youtu\.be$/i.test(parsed.hostname)
    ? parsed.pathname.replace(/^\//, '').split('/')[0]
    : parsed.searchParams.get('v') ??
      /^\/(?:shorts|embed|live)\/([^/?#]+)/i.exec(parsed.pathname)?.[1] ??
      ''

  return VIDEO_ID.test(candidate) ? candidate : null
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

/**
 * The poster image for a video id or watch URL.
 *
 * `hqdefault` rather than `maxresdefault`: every video has one. maxres exists
 * only for uploads above 720p, and YouTube answers a missing one with an HTML
 * 404 page, which means a broken preview on exactly the older videos a person
 * is most likely to be looking through a playlist for.
 */
export function youtubeThumbnailUrl(value: unknown): string | null {
  const id = videoIdOf(value)
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null
}

/**
 * The same link with `list=` removed - the single video the user could have
 * meant instead, offered alongside the playlist rather than guessed at.
 */
export function singleVideoUrl(value: string): string | null {
  const parsed = parseYouTubeUrl(value)
  if (!parsed || !parsed.searchParams.get('v')) return null
  parsed.searchParams.delete('list')
  parsed.searchParams.delete('index')
  parsed.searchParams.delete('start_radio')
  return parsed.toString()
}
