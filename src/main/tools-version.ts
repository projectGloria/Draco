/**
 * Reading version numbers off the two external binaries, and deciding when one
 * of them is behind.
 *
 * Its own module, free of Electron, for the usual reason: `hls/ffmpeg.ts` and
 * `youtube.ts` both reach `paths.ts` and so cannot be loaded by `node --test`,
 * while getting these strings wrong is exactly the sort of thing that wants a
 * test - an ffmpeg banner names four versions and only the first is ffmpeg's.
 */

/**
 * The build's own version out of `ffmpeg -version`, or out of a bare release
 * file containing nothing else.
 *
 * Anchored at the banner on purpose. The rest of that output lists the compiler
 * and every library ffmpeg was linked against, so a loose search for a dotted
 * number happily returns gcc's. A git snapshot (`N-113452-g1a2b3c`) has no
 * comparable version at all, and null says so rather than inventing one.
 */
export function parseFfmpegVersion(output: string): string | null {
  const text = output.trim()
  const banner = /^ffmpeg\s+version\s+(\S+)/i.exec(text)
  const candidate = banner ? banner[1] : text.split(/\s/, 1)[0]
  const version = /^(\d+\.\d+(?:\.\d+)?)/.exec(candidate)
  return version ? version[1] : null
}

/** yt-dlp names its releases by date: `2025.08.11`, occasionally with a suffix. */
export function parseYtDlpVersion(output: string): string | null {
  const match = /(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)/.exec(output.trim())
  return match ? match[1] : null
}

/** First 64-hex digest in a `.sha256` side file, with or without a filename. */
export function parseSha256(text: string): string | null {
  const match = /\b([0-9a-f]{64})\b/i.exec(text.slice(0, 4096))
  return match ? match[1].toLowerCase() : null
}

/**
 * Compares two dotted numeric versions, or returns null when either side is not
 * one. Null means "no opinion" and must never be read as "up to date": offering
 * an update against a version nobody could parse is how a working install gets
 * replaced every time the app starts.
 */
export function compareToolVersions(left: string | null, right: string | null): number | null {
  const a = parts(left)
  const b = parts(right)
  if (!a || !b) return null

  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

function parts(value: string | null): number[] | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!/^\d+(\.\d+)*$/.test(trimmed)) return null
  return trimmed.split('.').map(Number)
}
