import { readFile } from 'node:fs/promises'

export const PROXY_CREDENTIAL_REALM = '__draco_proxy__'

export interface ParsedProxyUrl {
  sanitizedUrl: string | null
  host: string | null
  username: string | null
  password: string | null
}

export interface ProxyCredentialSink {
  save(host: string, username: string, password: string): Promise<void>
  clear(): Promise<void>
}

export function splitProxyUrl(raw: string | null | undefined): ParsedProxyUrl {
  if (!raw || typeof raw !== 'string') {
    return { sanitizedUrl: null, host: null, username: null, password: null }
  }
  const trimmed = raw.trim()
  if (!trimmed) {
    return { sanitizedUrl: null, host: null, username: null, password: null }
  }
  try {
    const parsed = new URL(trimmed)
    const host = parsed.host.toLowerCase() || null
    const hasCreds = Boolean(parsed.username || parsed.password)
    if (!hasCreds) {
      return { sanitizedUrl: trimmed, host, username: null, password: null }
    }
    const username = decodeURIComponent(parsed.username)
    const password = decodeURIComponent(parsed.password)
    parsed.username = ''
    parsed.password = ''
    const href = parsed.pathname === '/' && !parsed.search && !parsed.hash
      ? parsed.origin
      : parsed.toString()
    return { sanitizedUrl: href, host, username, password }
  } catch {
    return { sanitizedUrl: trimmed, host: null, username: null, password: null }
  }
}

export function hasProxyCredentials(raw: string | null | undefined): boolean {
  const { username, password } = splitProxyUrl(raw)
  return Boolean(username || password)
}

export function assembleProxyUrl(
  sanitizedUrl: string | null | undefined,
  creds: { username: string; password: string } | null
): string | null {
  if (!sanitizedUrl) return null
  if (!creds || !creds.username) return sanitizedUrl
  try {
    const parsed = new URL(sanitizedUrl)
    parsed.username = creds.username
    parsed.password = creds.password
    return parsed.toString()
  } catch {
    return sanitizedUrl
  }
}

export async function sanitizeAndStoreProxyUrl(
  rawProxyUrl: string | null | undefined,
  sink: ProxyCredentialSink
): Promise<{ sanitizedUrl: string | null; extracted: boolean }> {
  const parsed = splitProxyUrl(rawProxyUrl)
  if (!parsed.sanitizedUrl) {
    await sink.clear()
    return { sanitizedUrl: null, extracted: false }
  }
  if (parsed.host && parsed.username && parsed.password) {
    await sink.save(parsed.host, parsed.username, parsed.password)
    return { sanitizedUrl: parsed.sanitizedUrl, extracted: true }
  }
  return { sanitizedUrl: parsed.sanitizedUrl, extracted: Boolean(parsed.username || parsed.password) }
}

/**
 * Checks whether `<settingsPath>.bak` still holds a plaintext proxy password.
 * Missing or corrupt backup files return false (never throw).
 */
export async function backupHasProxyCredentials(settingsPath: string): Promise<boolean> {
  try {
    const raw = await readFile(settingsPath + '.bak', 'utf8')
    const parsed = JSON.parse(raw) as { proxyUrl?: unknown } | null
    if (!parsed || typeof parsed !== 'object') return false
    return typeof parsed.proxyUrl === 'string' && hasProxyCredentials(parsed.proxyUrl)
  } catch {
    return false
  }
}
