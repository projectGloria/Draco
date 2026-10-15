import { request } from 'undici'
import { isPrivateHost } from './engine/create.ts'
import { getDispatcher } from './engine/http.ts'

/**
 * Fetch with redirect hops under our control.
 *
 * `redirect: 'follow'` connects to every redirect target before any code gets
 * a look at it, so a public page can bounce the request at an intranet host or
 * a cloud metadata endpoint and the connection - including its credentials -
 * has already happened by the time `response.url` reveals it. Re-fetching
 * hop-by-hop puts the checks *before* the connection.
 */

/** Only transport headers survive a redirect to a different origin. Captured
 * browser headers can contain secrets under arbitrary names, including X-API-Key.
 */
const CROSS_ORIGIN_HEADERS = new Set(['accept', 'accept-encoding', 'user-agent', 'range', 'if-range'])

function headersForOtherOrigin(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => CROSS_ORIGIN_HEADERS.has(name.toLowerCase()))
  )
}

/** A manifest-declared resource has the same credential boundary as a redirect. */
export function headersForResource(
  resourceUrl: string,
  credentialUrl: string,
  headers: Record<string, string>
): Record<string, string> {
  return new URL(resourceUrl).origin === new URL(credentialUrl).origin
    ? headers
    : headersForOtherOrigin(headers)
}

export interface FetchGuardedOptions {
  method?: string
  headers?: Record<string, string>
  /** Builds origin-scoped authentication for each hop after redirect checks. */
  headersForHop?(url: URL, headers: Record<string, string>): Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  /** When set, no redirect may leave this host (`host`, port included). */
  pinHost?: string
  /** Release metadata and executable downloads must stay on HTTPS. */
  requireHttps?: boolean
  maxRedirects?: number
}

/** Stop an unread response immediately; Undici emits its abort on the body. */
export function discardRequestBody(body: Awaited<ReturnType<typeof request>>['body']): void {
  body.once('error', () => {})
  body.destroy()
}

function redirectTarget(url: URL, location: string, options: FetchGuardedOptions): URL {
  let target: URL
  try {
    target = new URL(location, url)
  } catch {
    throw new Error('The server sent a redirect that is not a valid address')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`A redirect pointed at an unsupported address: ${target.protocol}`)
  }
  if (options.requireHttps && target.protocol !== 'https:') {
    throw new Error('A redirect downgraded a secure request to HTTP')
  }
  if (options.pinHost && target.host.toLowerCase() !== options.pinHost.toLowerCase()) {
    throw new Error('A redirect left the original host')
  }
  if (!isPrivateHost(url.hostname) && isPrivateHost(target.hostname)) {
    throw new Error('A redirect pointed into a private network')
  }
  return target
}

export async function fetchGuarded(
  rawUrl: string | URL,
  options: FetchGuardedOptions = {}
): Promise<Response> {
  let url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported address: ${url.protocol}`)
  }
  if (options.requireHttps && url.protocol !== 'https:') throw new Error('This request requires HTTPS')
  let headers = { ...options.headers }
  const maxRedirects = options.maxRedirects ?? 8

  for (let hop = 0; ; hop++) {
    const requestHeaders = options.headersForHop?.(url, { ...headers }) ?? headers
    const response = await fetch(url, {
      method: options.method,
      headers: requestHeaders,
      redirect: 'manual',
      signal: options.signal,
      dispatcher: getDispatcher(options.timeoutMs ?? 30_000)
    } as RequestInit)

    const location = response.status >= 300 && response.status < 400
      ? response.headers.get('location')
      : null
    if (!location) return response

    // Release the socket for the hop we are not going to read.
    await response.body?.cancel().catch(() => {})
    if (hop >= maxRedirects) throw new Error('Too many redirects')

    const target = redirectTarget(url, location, options)

    if (target.origin !== url.origin) {
      headers = headersForOtherOrigin(headers)
    }
    url = target
  }
}

/** Undici's streaming request variant of fetchGuarded for byte-range workers. */
export async function requestGuarded(
  rawUrl: string | URL,
  options: FetchGuardedOptions
): Promise<{ response: Awaited<ReturnType<typeof request>>; finalUrl: string }> {
  let url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported address: ${url.protocol}`)
  }
  if (options.requireHttps && url.protocol !== 'https:') throw new Error('This request requires HTTPS')
  let headers = { ...options.headers }
  const maxRedirects = options.maxRedirects ?? 8

  for (let hop = 0; ; hop++) {
    const requestHeaders = options.headersForHop?.(url, { ...headers }) ?? headers
    const response = await request(url, {
      method: (options.method ?? 'GET') as 'GET' | 'HEAD',
      headers: requestHeaders,
      signal: options.signal,
      dispatcher: getDispatcher(options.timeoutMs ?? 30_000),
      maxRedirections: 0
    } as Parameters<typeof request>[1] & { maxRedirections: number })

    const rawLocation = response.statusCode >= 300 && response.statusCode < 400
      ? response.headers.location : undefined
    const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation
    if (!location) return { response, finalUrl: url.href }

    // A redirect can stream forever. Abandon its body before taking the next
    // hop rather than waiting for EOF (the socket idle timeout cannot help).
    discardRequestBody(response.body)
    if (hop >= maxRedirects) throw new Error('Too many redirects')
    const target = redirectTarget(url, location, options)
    if (target.origin !== url.origin) headers = headersForOtherOrigin(headers)
    url = target
  }
}
