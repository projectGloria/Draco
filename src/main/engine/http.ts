import dns, { type LookupAddress, type LookupAllOptions, type LookupOneOptions } from 'node:dns'
import { Agent, ProxyAgent, interceptors, type Dispatcher } from 'undici'
import { isPrivateHost } from './create.ts'

export const PRIVATE_ADDRESS_ERROR = 'Connecting to private network addresses is not allowed'

export type LookupFn = (
  hostname: string,
  options: LookupOneOptions | LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
) => void

/**
 * Wraps a DNS lookup function so any resolved IPv4/IPv6 address classified as
 * private/loopback/link-local/CGNAT/multicast by `isPrivateHost` is rejected
 * before a TCP socket is opened (closing static DNS and DNS-rebinding SSRF).
 */
export function createSafeLookup(baseLookup: LookupFn = dns.lookup as unknown as LookupFn): LookupFn {
  return (hostname, options, callback) => {
    const opts = typeof options === 'function' ? {} : (options ?? {})
    const cb = (typeof options === 'function' ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number
    ) => void

    if (isPrivateHost(hostname)) {
      const err = new Error(PRIVATE_ADDRESS_ERROR) as NodeJS.ErrnoException
      err.code = 'ERR_PRIVATE_ADDRESS'
      cb(err, '')
      return
    }

    baseLookup(hostname, opts, (err, address, family) => {
      if (err) {
        cb(err, address, family)
        return
      }
      if (Array.isArray(address)) {
        if (address.length === 0 || address.some((entry) => !entry?.address || isPrivateHost(entry.address))) {
          const blocked = new Error(PRIVATE_ADDRESS_ERROR) as NodeJS.ErrnoException
          blocked.code = 'ERR_PRIVATE_ADDRESS'
          cb(blocked, [])
          return
        }
        cb(null, address)
        return
      }
      if (!address || isPrivateHost(address)) {
        const blocked = new Error(PRIVATE_ADDRESS_ERROR) as NodeJS.ErrnoException
        blocked.code = 'ERR_PRIVATE_ADDRESS'
        cb(blocked, '')
        return
      }
      cb(null, address, family)
    })
  }
}

/**
 * The shared connection pool.
 *
 * One Agent for the whole app rather than one per task, so keep-alive
 * connections are reused across segments and across downloads from the same
 * host. That reuse is what avoids re-running TLS - and, on authenticated
 * servers, re-running the login - for every one of the eight connections a
 * single file opens.
 *
 * undici 7 no longer takes `maxRedirections` on the request; redirects are an
 * interceptor composed onto the dispatcher.
 */

const openDispatchers = new Map<number, Dispatcher>()
const guardedDispatchers = new Map<number, Dispatcher>()
const retiredDispatchers = new Set<Dispatcher>()
const MAX_CACHED_DISPATCHERS = 8
let proxyUrl: string | null = null
let customLookup: LookupFn | null = null
/**
 * Defaults to 1280 (maxConcurrentTasks 20 x maxConnectionsPerTask 64),
 * and dynamically resizes when settings are loaded or saved.
 */
let poolConnections = 1280

function retire(dispatcher: Dispatcher): void {
  retiredDispatchers.add(dispatcher)
  void dispatcher.close().catch(() => {}).finally(() => {
    retiredDispatchers.delete(dispatcher)
  })
}

function retireAllCached(): void {
  for (const dispatcher of openDispatchers.values()) retire(dispatcher)
  for (const dispatcher of guardedDispatchers.values()) retire(dispatcher)
  openDispatchers.clear()
  guardedDispatchers.clear()
}

/**
 * Whether this host is on a private network: by its text (`nas.local`,
 * `192.168.1.10`) or by what it actually resolves to (`nas`, a split-horizon
 * corporate name, a Tailscale MagicDNS name in 100.64/10). Used to decide
 * whether a download that *started* on a private host may keep fetching from
 * private addresses. A failed lookup counts as public, the stricter answer.
 */
export function hostResolvesPrivate(hostname: string): Promise<boolean> {
  if (isPrivateHost(hostname)) return Promise.resolve(true)
  const lookup = customLookup ?? (dns.lookup as unknown as LookupFn)
  const host = hostname.replace(/^\[|\]$/g, '')
  return new Promise((resolve) => {
    try {
      lookup(host, { all: true }, (err, address) => {
        if (err) return resolve(false)
        const list = Array.isArray(address) ? address.map((entry) => entry?.address) : [address]
        resolve(list.some((entry) => typeof entry === 'string' && entry !== '' && isPrivateHost(entry)))
      })
    } catch {
      resolve(false)
    }
  })
}

/** Overrides the underlying DNS lookup (for tests). Pass null to restore `dns.lookup`. */
export function setDnsLookup(lookup: LookupFn | null): void {
  customLookup = lookup
  retireAllCached()
}

/** Dynamically sizes the per-origin connection pool to match configured concurrency. */
export function setPoolConnections(connections: number): void {
  const next = Math.max(256, connections)
  if (next === poolConnections) return
  poolConnections = next
  retireAllCached()
}

/** Applies to newly-created pools; active requests finish on their old pool. */
export function setProxyUrl(next: string | null): void {
  if (next === proxyUrl) return
  proxyUrl = next
  retireAllCached()
}

export function getDispatcher(
  requestedTimeoutMs: number,
  opts?: { allowPrivate?: boolean }
): Dispatcher {
  // 0 would disable undici's headers and body timeouts entirely.
  const timeoutMs = Math.max(1, requestedTimeoutMs)
  const allowPrivate = opts?.allowPrivate !== false
  const cache = allowPrivate ? openDispatchers : guardedDispatchers
  const existing = cache.get(timeoutMs)
  if (existing) {
    cache.delete(timeoutMs)
    cache.set(timeoutMs, existing)
    return existing
  }

  const baseLookup = customLookup ?? (dns.lookup as unknown as LookupFn)
  const connectOptions = !allowPrivate
    ? { lookup: createSafeLookup(baseLookup) }
    : customLookup
      ? { lookup: customLookup }
      : undefined

  const options = {
    // Must comfortably exceed maxConnectionsPerTask x maxConcurrentTasks, or
    // segments of the same file - and of different files on the same host -
    // would queue behind each other instead of running in parallel. This is a
    // per-origin pool, and an idle slot costs nothing in undici, so it is sized
    // for the largest settings the sanitizer permits (or dynamically adjusted)
    // rather than a narrow default.
    connections: poolConnections,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    ...(connectOptions ? { connect: connectOptions } : {})
  }
  const base = proxyUrl
    ? new ProxyAgent({ uri: proxyUrl, ...options })
    : new Agent(options)
  const agent = base.compose(interceptors.redirect({ maxRedirections: 10 }))

  cache.set(timeoutMs, agent)
  // Editing request timeouts must not retain one connection pool per value
  // for the lifetime of the app. Retire idle entries without aborting transfers.
  while (cache.size > MAX_CACHED_DISPATCHERS) {
    const oldest = cache.keys().next().value!
    const dispatcher = cache.get(oldest)!
    cache.delete(oldest)
    retire(dispatcher)
  }
  return agent
}

/** Closes every pool. Only for shutdown - in-flight requests are cut off. */
export async function closeDispatchers(): Promise<void> {
  const all = [...openDispatchers.values(), ...guardedDispatchers.values(), ...retiredDispatchers]
  openDispatchers.clear()
  guardedDispatchers.clear()
  retiredDispatchers.clear()
  await Promise.allSettled(all.map((d) => d.destroy()))
}
