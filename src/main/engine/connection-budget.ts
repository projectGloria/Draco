/**
 * How a merged video+audio download divides its connection allowance.
 *
 * Pure and Electron-free, in `engine/`, for the reason every other decision
 * module here is: the runner that uses it reaches ffmpeg and cannot be loaded
 * under bare Node, and this is the part worth testing without a build.
 *
 * Two things were wrong with the `maxConnections / 2` this replaces.
 *
 * The split was even, and the streams are not: an audio track is typically
 * 5-10% of the bytes, so half the allowance sat on the half that finishes first
 * while the half that sets the length of the download ran narrow. Audio takes a
 * quarter here, never fewer than one; video takes the rest.
 *
 * And there was no ceiling at all. `TaskRunner` computes
 * `connectionTarget = max(maxConnections, connectionCeiling ?? 0)` and starts
 * the ramp at `min(RAMP_START_CONNECTIONS, target)`; with a target of 4 those
 * are the same number, and `ConnectionRamp` marks itself `done` on construction
 * when `current >= target`. Every YouTube video+audio download therefore ran at
 * exactly four connections per stream and could never climb, however much the
 * link had left - and the "Adaptive ceiling" setting did nothing whatsoever for
 * the downloads most likely to want it.
 */
export interface ConnectionBudget {
  video: number
  audio: number
  videoCeiling: number
  audioCeiling: number
}

export function splitConnectionBudget(
  maxConnections: number,
  connectionCeiling?: number
): ConnectionBudget {
  const base = Math.max(1, Math.floor(maxConnections))
  // A ceiling below the configured maximum is not a ceiling; it is a number
  // somebody left behind, and the maximum still applies.
  const ceiling = Math.max(base, Math.floor(connectionCeiling ?? 0))

  const audio = Math.max(1, Math.round(base / 4))
  const video = Math.max(1, base - audio)
  const audioCeiling = Math.max(audio, Math.round(ceiling / 4))
  const videoCeiling = Math.max(video, ceiling - audioCeiling)

  return { video, audio, videoCeiling, audioCeiling }
}
