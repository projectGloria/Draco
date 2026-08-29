import { Agent, interceptors, type Dispatcher } from 'undici'

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

const dispatchers = new Map<number, Dispatcher>()

export function getDispatcher(timeoutMs: number): Dispatcher {
  const existing = dispatchers.get(timeoutMs)
  if (existing) return existing

  const agent = new Agent({
    // Must comfortably exceed maxConnectionsPerTask, or segments of the same
    // file would queue behind each other instead of running in parallel.
    connections: 64,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  }).compose(interceptors.redirect({ maxRedirections: 10 }))

  dispatchers.set(timeoutMs, agent)
  return agent
}

/** Closes every pool. Only for shutdown - in-flight requests are cut off. */
export async function closeDispatchers(): Promise<void> {
  const all = [...dispatchers.values()]
  dispatchers.clear()
  await Promise.allSettled(all.map((d) => d.close()))
}
