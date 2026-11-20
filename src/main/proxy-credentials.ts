import { readFile } from 'node:fs/promises'

export const PROXY_CREDENTIAL_REALM = '__draco_proxy__'

export interface ParsedProxyUrl {
  sanitizedUrl: string | null
  host: string | null
  /**
   * What the credential is stored and looked up under: the proxy's origin
   * with its real scheme (`http://proxy:443`). Both the save path and the
   * lookup path run it through the same `hostOf`, so a non-default port for
   * the scheme (http on 443, https on 80) survives on both sides.
   */
  key: string | null
  username: string | null
  password: string | null
}

export interface ProxyCredentialSink {
  save(key: string, username: string, password: string): Promise<void>
  clear(): Promise<void>
}

const EMPTY: ParsedProxyUrl = { sanitizedUrl: null, host: null, key: null, username: null, password: null }

export function splitProxyUrl(raw: string | null | undefined): ParsedProxyUrl {
  if (!raw || typeof raw !== 'string') return { ...EMPTY }
  const trimmed = raw.trim()
  if (!trimmed) return { ...EMPTY }
  try {
    const parsed = new URL(trimmed)
    const host = parsed.host.toLowerCase() || null
    const key = host ? proxyCredentialKey(parsed) : null
    const hasCreds = Boolean(parsed.username || parsed.password)
    if (!hasCreds) {
      return { sanitizedUrl: trimmed, host, key, username: null, password: null }
    }
    const username = safeDecode(parsed.username)
    const password = safeDecode(parsed.password)
    parsed.username = ''
    parsed.password = ''
    const href = parsed.pathname === '/' && !parsed.search && !parsed.hash
      ? parsed.origin
      : parsed.toString()
    return { sanitizedUrl: href, host, key, username, password }
  } catch {
    return { ...EMPTY, sanitizedUrl: trimmed }
  }
}

/** `scheme://host[:port]`, lowercased: the one key form for save and lookup. */
export function proxyCredentialKey(url: URL | string): string | null {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url
    if (!parsed.host) return null
    return `${parsed.protocol}//${parsed.host}`.toLowerCase()
  } catch {
    return null
  }
}

/** A stray `%` that was typed rather than encoded is kept as-is instead of throwing. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
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
    // The userinfo setters leave `%` unescaped, but undici runs
    // decodeURIComponent() on both halves to build Proxy-Authorization. Encode
    // fully so `p%w` arrives as `p%w` (not a URIError) and `ab%41` stays
    // `ab%41` (not `abA`).
    parsed.username = encodeURIComponent(creds.username)
    parsed.password = encodeURIComponent(creds.password)
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
  if (parsed.username === null && parsed.password === null) {
    return { sanitizedUrl: parsed.sanitizedUrl, extracted: false }
  }
  // Username-only proxies (`http://KEY@host`, `http://KEY:@host`) are real:
  // API-key proxies use them. `extracted` strips the URL and overwrites the
  // .bak copy, so it is reported only once the credential is actually sealed.
  // Otherwise the URL is kept exactly as given and nothing is lost.
  if (parsed.key && parsed.username) {
    try {
      await sink.save(parsed.key, parsed.username, parsed.password ?? '')
      return { sanitizedUrl: parsed.sanitizedUrl, extracted: true }
    } catch {
      // Encryption unavailable or the store could not be written.
    }
  }
  return { sanitizedUrl: String(rawProxyUrl).trim(), extracted: false }
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
