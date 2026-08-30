import { version as currentVersion } from '../../package.json'
import type { UpdateInfo } from '../shared/types.ts'
import { getDispatcher } from './engine/http.ts'
import { compareVersions } from './update-version.ts'

/** Checks a small provider-neutral HTTPS JSON feed: { version, url, notes }. */
export async function checkForUpdates(feedUrl: string | null): Promise<UpdateInfo> {
  if (!feedUrl) throw new Error('Configure an HTTPS update feed in Options first')
  const response = await fetch(feedUrl, {
    headers: { accept: 'application/json', 'user-agent': `Draco/${currentVersion}` },
    redirect: 'follow',
    dispatcher: getDispatcher(30_000)
  } as RequestInit)
  if (!response.ok) throw new Error(`Update feed returned HTTP ${response.status}`)
  if (!response.url.startsWith('https://')) throw new Error('Update feed redirected to a non-HTTPS address')

  const text = await response.text()
  if (text.length > 1_000_000) throw new Error('Update feed is unexpectedly large')
  const raw = JSON.parse(text) as Record<string, unknown>
  const latestVersion = typeof raw.version === 'string' ? raw.version.trim().slice(0, 50) : ''
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(latestVersion)) {
    throw new Error('Update feed has no valid semantic version')
  }
  const downloadUrl = secureUrl(raw.url)
  return {
    currentVersion,
    latestVersion,
    available: compareVersions(latestVersion, currentVersion) > 0,
    downloadUrl,
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 10_000) : null
  }
}

function secureUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}
