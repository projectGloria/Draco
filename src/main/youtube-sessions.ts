import { isDirectDownload, type YtDlpFormat } from './youtube-ladder.ts'

export interface YtDlpInfo {
  id?: string
  title?: string
  thumbnail?: string
  duration?: number
  uploader?: string
  channel?: string
  /** YYYYMMDD. */
  upload_date?: string
  formats?: YtDlpFormat[]
  entries?: Array<{ formats?: YtDlpFormat[] }>
}

/** Keep public video qualities and add the formats available to the account. */
export async function loadYouTubeSessions(
  publicLookup: () => Promise<YtDlpInfo>,
  sessionLookup?: () => Promise<YtDlpInfo>,
  onSessionError?: (error: unknown) => void
): Promise<YtDlpInfo> {
  if (!sessionLookup) return publicLookup()
  const [publicResult, sessionResult] = await Promise.allSettled([
    publicLookup(), sessionLookup()
  ])
  if (sessionResult.status === 'rejected') {
    if (publicResult.status === 'rejected') throw sessionResult.reason
    onSessionError?.(sessionResult.reason)
    return publicResult.value
  }
  if (publicResult.status === 'rejected') return sessionResult.value

  const formats = new Map<string, YtDlpFormat>()
  for (const format of [...publicResult.value.formats ?? [], ...sessionResult.value.formats ?? []]) {
    const key = `${format.format_id ?? format.url}:${format.language ?? ''}`
    const previous = formats.get(key)
    // Prefer the signed-in URL for duplicates, but do not replace a usable
    // public file with an account-only manifest the HTTP runner cannot fetch.
    if (previous?.url && isDirectDownload(previous) && (!format.url || !isDirectDownload(format))) continue
    formats.set(key, format)
  }
  return { ...publicResult.value, ...sessionResult.value, formats: [...formats.values()] }
}
